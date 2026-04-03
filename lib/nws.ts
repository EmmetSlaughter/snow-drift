/**
 * NWS (National Weather Service) snowfall collection.
 *
 * NWS has no batch endpoint, so we only fetch data for locations that
 * Open-Meteo already predicts snow for in a given collect run. This keeps
 * collect times reasonable (typically 300-600 locations during a storm vs
 * the full ~6 000-point grid).
 *
 * NWS grid metadata (office / gridX / gridY) is looked up once per location
 * via /points/ and cached in the locations table. Subsequent runs skip the
 * lookup and go straight to /gridpoints/.
 *
 * Docs: https://www.weather.gov/documentation/services-web-api
 */

import { sql } from './db';
import type { LocationSnowRow } from './open-meteo';

const NWS_BASE   = 'https://api.weather.gov';
const UA         = 'snow-drift/1.0 (github.com/EmmetSlaughter/snow-drift)';
const CONCURRENT = 5;    // parallel requests per batch
const PAUSE_MS   = 250;  // ms between batches

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Grid metadata lookup ──────────────────────────────────────────────────────

async function lookupGridMeta(
  lat: number, lon: number,
): Promise<{ office: string; gridX: number; gridY: number } | null> {
  try {
    const res = await fetch(
      `${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } },
    );
    if (!res.ok) return null;
    const j = await res.json();
    const p = j.properties;
    if (!p?.gridId) return null;
    return { office: p.gridId as string, gridX: p.gridX as number, gridY: p.gridY as number };
  } catch {
    return null;
  }
}

// ── Gridpoints snowfall fetch ─────────────────────────────────────────────────

function parseDurationHours(dur: string): number {
  // Handles PT1H, PT3H, PT6H, PT12H, P1D, P1DT6H …
  const m = dur?.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/);
  if (!m) return 1;
  return Math.max(1, Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0));
}

function toCm(value: number, uom: string): number {
  if (uom.endsWith(':in'))  return value * 2.54;
  if (uom.endsWith(':mm'))  return value / 10;
  if (uom.endsWith(':cm'))  return value;
  return value * 100; // default wmoUnit:m
}

async function fetchGridpointsSnow(
  locationId: number,
  office: string,
  gridX: number,
  gridY: number,
): Promise<LocationSnowRow[]> {
  const res = await fetch(
    `${NWS_BASE}/gridpoints/${office}/${gridX},${gridY}`,
    { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } },
  );
  if (!res.ok) throw new Error(`NWS ${res.status} for ${office}/${gridX},${gridY}`);

  const json  = await res.json();
  const field = json.properties?.snowfallAmount;
  if (!field?.values?.length) return [];

  const uom  = (field.uom as string) ?? 'wmoUnit:m';
  const rows: LocationSnowRow[] = [];

  for (const entry of field.values as { validTime: string; value: number | null }[]) {
    if (!entry.value || entry.value <= 0) continue;

    // validTime is an ISO 8601 interval: "2026-04-03T10:00:00+00:00/PT6H"
    const slashIdx = entry.validTime.lastIndexOf('/');
    const timeStr  = entry.validTime.slice(0, slashIdx);
    const durStr   = entry.validTime.slice(slashIdx + 1);
    const start    = new Date(timeStr);
    const hours    = parseDurationHours(durStr);
    const cmPerH   = toCm(entry.value, uom) / hours;
    if (cmPerH <= 0) continue;

    for (let h = 0; h < hours; h++) {
      rows.push({
        locationId,
        validTime: new Date(start.getTime() + h * 3_600_000),
        snowCm: cmPerH,
      });
    }
  }

  return rows;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * For each location with non-zero Open-Meteo snow in this collect run:
 *   1. Ensure NWS grid metadata is cached in the locations table (lazy lookup).
 *   2. Fetch NWS gridpoints snowfall forecast.
 *   3. Insert rows into forecast_snapshots with source = 'nws'.
 *
 * Returns the number of rows inserted.
 */
export async function collectNWSForSnowyLocations(
  snowyLocationIds: number[],
  fetchedAt: string,
): Promise<number> {
  if (!snowyLocationIds.length) return 0;

  // ── Step 1: populate missing NWS metadata ─────────────────────────────────
  const locs = await sql`
    SELECT id, lat, lon, nws_office, nws_grid_x, nws_grid_y
    FROM   locations
    WHERE  id = ANY(${snowyLocationIds}::integer[])
  ` as {
    id: number; lat: number; lon: number;
    nws_office: string | null; nws_grid_x: number | null; nws_grid_y: number | null;
  }[];

  const MAX_META_PER_RUN = 100; // spread metadata population across multiple hourly runs
  const allNeedsMeta = locs.filter(l => l.nws_office === null);
  const needsMeta    = allNeedsMeta.slice(0, MAX_META_PER_RUN);

  if (needsMeta.length > 0) {
    console.log(`[nws] looking up grid metadata for ${needsMeta.length} locations (${allNeedsMeta.length - needsMeta.length} deferred to future runs)…`);

    for (let i = 0; i < needsMeta.length; i += CONCURRENT) {
      if (i > 0) await sleep(PAUSE_MS);
      const chunk = needsMeta.slice(i, i + CONCURRENT);

      await Promise.all(chunk.map(async loc => {
        const meta = await lookupGridMeta(loc.lat, loc.lon);
        if (meta) {
          await sql`
            UPDATE locations
            SET nws_office = ${meta.office},
                nws_grid_x = ${meta.gridX},
                nws_grid_y = ${meta.gridY}
            WHERE id = ${loc.id}
          `;
          loc.nws_office  = meta.office;
          loc.nws_grid_x  = meta.gridX;
          loc.nws_grid_y  = meta.gridY;
        } else {
          // No NWS coverage (ocean edge, outside CONUS, etc.) — don't retry.
          await sql`UPDATE locations SET nws_office = 'NONE' WHERE id = ${loc.id}`;
          loc.nws_office = 'NONE';
        }
      }));
    }
  }

  // ── Step 2: fetch forecasts for covered locations ─────────────────────────
  const covered = locs.filter(
    l => l.nws_office && l.nws_office !== 'NONE'
      && l.nws_grid_x != null && l.nws_grid_y != null,
  );

  if (!covered.length) return 0;
  console.log(`[nws] fetching forecasts for ${covered.length} locations…`);

  const allRows: LocationSnowRow[] = [];
  let errors = 0;

  for (let i = 0; i < covered.length; i += CONCURRENT) {
    if (i > 0) await sleep(PAUSE_MS);
    const chunk   = covered.slice(i, i + CONCURRENT);
    const results = await Promise.allSettled(
      chunk.map(loc =>
        fetchGridpointsSnow(loc.id, loc.nws_office!, loc.nws_grid_x!, loc.nws_grid_y!),
      ),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allRows.push(...r.value);
      else errors++;
    }
  }

  if (errors > 0) console.warn(`[nws] ${errors} location fetch errors (skipped)`);

  // ── Step 3: bulk insert ───────────────────────────────────────────────────
  if (!allRows.length) return 0;

  const locationIds = allRows.map(r => r.locationId);
  const times       = allRows.map(r => r.validTime.toISOString());
  const cms         = allRows.map(r => r.snowCm);

  await sql`
    INSERT INTO forecast_snapshots (fetched_at, location_id, source, valid_time, snow_cm)
    SELECT
      ${fetchedAt}::timestamptz,
      unnest(${locationIds}::integer[]),
      'nws',
      unnest(${times}::text[])::timestamptz,
      unnest(${cms}::double precision[])
  `;

  console.log(`[nws] inserted ${allRows.length} rows`);
  return allRows.length;
}
