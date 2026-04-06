#!/usr/bin/env tsx
/**
 * Hourly forecast collection script — executed by GitHub Actions.
 *
 * Fetches Open-Meteo (GFS + ECMWF) snowfall for every grid location,
 * NWS for snowy locations, stores non-zero rows in Neon, detects storms,
 * and prunes snapshots older than 7 days.
 *
 * Map-layer data is aggregated in-memory and written to the map_cache
 * table as a single JSON blob — no per-location snapshot rows needed
 * for the map view.  Only locations with predicted snow get detailed
 * hourly rows in forecast_snapshots (for drift charts).
 *
 * Usage:  npm run collect
 * Env:    DATABASE_URL      (required)
 *         OPEN_METEO_KEY    (optional — commercial API, removes rate limits)
 */

import { sql, ensureSchema } from '../lib/db';
import { fetchOpenMeteoSnowBatch } from '../lib/open-meteo';
import { collectNWSForSnowyLocations } from '../lib/nws';
import { detectStormsAfterCollect } from '../lib/detect-storms';

const BATCH_SIZE  = 500;
const PAUSE_MS    = process.env.OPEN_METEO_KEY ? 2_000 : 35_000; // 2s with key, 35s without
const RECOVERY_MS = 10_000;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 7-day window boundaries used for map aggregation. */
function mapWindow(): { start: Date; end: Date } {
  const now = new Date();
  return { start: now, end: new Date(now.getTime() + 7 * 24 * 3_600_000) };
}

interface MapPoint {
  locationId: number;
  lat: number;
  lon: number;
  snowIn: number;
}

async function collectModel(
  model: 'forecast' | 'ecmwf',
  source: string,
  batches: { id: number; lat: number; lon: number }[][],
  fetchedAt: string,
  window: { start: Date; end: Date },
  locationLookup: Map<number, { lat: number; lon: number }>,
): Promise<{
  totalRows: number;
  errors: number;
  snowyIds: Set<number>;
  mapTotals: Map<number, { lat: number; lon: number; snowCm: number }>;
}> {
  let totalRows = 0;
  let errors    = 0;
  const snowyIds  = new Set<number>();
  const mapTotals = new Map<number, { lat: number; lon: number; snowCm: number }>();

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(PAUSE_MS);

    try {
      const rows = await fetchOpenMeteoSnowBatch(batches[i], model);

      // Accumulate per-location 7-day totals for the map cache (in-memory).
      for (const r of rows) {
        if (r.validTime >= window.start && r.validTime < window.end) {
          const loc = locationLookup.get(r.locationId)!;
          const entry = mapTotals.get(r.locationId) ?? { lat: loc.lat, lon: loc.lon, snowCm: 0 };
          entry.snowCm += r.snowCm;
          mapTotals.set(r.locationId, entry);
        }
      }

      // Only write detailed hourly rows for locations with snow (for drift charts).
      if (rows.length > 0) {
        const locationIds = rows.map(r => r.locationId);
        const times       = rows.map(r => r.validTime.toISOString());
        const cms         = rows.map(r => r.snowCm);

        await sql`
          INSERT INTO forecast_snapshots (fetched_at, location_id, source, valid_time, snow_cm)
          SELECT
            ${fetchedAt}::timestamptz,
            unnest(${locationIds}::integer[]),
            ${source},
            unnest(${times}::text[])::timestamptz,
            unnest(${cms}::double precision[])
        `;
        totalRows += rows.length;
        for (const r of rows) snowyIds.add(r.locationId);
      }

      console.log(`[collect:${source}] batch ${i + 1}/${batches.length} — ${rows.length} rows`);
    } catch (e) {
      errors++;
      console.error(`[collect:${source}] batch ${i + 1} error:`, e);
      await sleep(RECOVERY_MS);
    }
  }

  return { totalRows, errors, snowyIds, mapTotals };
}

async function main() {
  console.log('[collect] start', new Date().toISOString());
  console.log('[collect] API key:', process.env.OPEN_METEO_KEY ? 'yes (commercial)' : 'no (free tier)');

  await ensureSchema();

  const locations = await sql`
    SELECT id, lat, lon FROM locations ORDER BY id
  ` as { id: number; lat: number; lon: number }[];

  if (locations.length === 0) {
    console.error('[collect] no locations — run /api/locations/seed first');
    process.exit(1);
  }

  await sql`DELETE FROM forecast_snapshots WHERE fetched_at < NOW() - INTERVAL '7 days'`;
  await sql`DELETE FROM storms WHERE window_end < NOW()`;

  const fetchedAt = new Date().toISOString();
  const window    = mapWindow();
  const batches: typeof locations[] = [];
  for (let i = 0; i < locations.length; i += BATCH_SIZE) {
    batches.push(locations.slice(i, i + BATCH_SIZE));
  }

  const locationLookup = new Map(locations.map(l => [l.id, { lat: l.lat, lon: l.lon }]));
  console.log(`[collect] ${locations.length} locations → ${batches.length} batches, ${PAUSE_MS}ms pause`);

  // ── Open-Meteo GFS (default model) ─────────────────────────────────────────
  const gfs = await collectModel('forecast', 'open-meteo', batches, fetchedAt, window, locationLookup);
  console.log(`[collect] open-meteo done — ${gfs.totalRows} rows, ${gfs.errors} errors`);

  // ── Open-Meteo ECMWF (commercial only) ────────────────────────────────────
  let ecmwf = { totalRows: 0, errors: 0, snowyIds: new Set<number>(), mapTotals: new Map<number, { lat: number; lon: number; snowCm: number }>() };
  if (process.env.OPEN_METEO_KEY) {
    ecmwf = await collectModel('ecmwf', 'ecmwf', batches, fetchedAt, window, locationLookup);
    console.log(`[collect] ecmwf done — ${ecmwf.totalRows} rows, ${ecmwf.errors} errors`);
  }

  // ── Write map cache ────────────────────────────────────────────────────────
  // Use GFS totals for the map layer (primary model).
  const mapPoints: MapPoint[] = [];
  for (const [locationId, entry] of gfs.mapTotals) {
    const snowIn = Math.round(entry.snowCm * 0.3937 * 100) / 100;
    if (snowIn > 0) {
      mapPoints.push({ locationId, lat: entry.lat, lon: entry.lon, snowIn });
    }
  }
  mapPoints.sort((a, b) => b.snowIn - a.snowIn);

  await sql`
    INSERT INTO map_cache (id, fetched_at, data)
    VALUES (1, ${fetchedAt}::timestamptz, ${JSON.stringify(mapPoints)}::jsonb)
    ON CONFLICT (id) DO UPDATE
    SET fetched_at = EXCLUDED.fetched_at,
        data       = EXCLUDED.data
  `;
  console.log(`[collect] map cache — ${mapPoints.length} points with snow`);

  // ── NWS ────────────────────────────────────────────────────────────────────
  const allSnowyIds = new Set([...gfs.snowyIds, ...ecmwf.snowyIds]);
  if (allSnowyIds.size > 0) {
    const nwsRows = await collectNWSForSnowyLocations([...allSnowyIds], fetchedAt);
    console.log(`[collect] nws — ${nwsRows} rows inserted`);
  }

  // ── Storm detection ────────────────────────────────────────────────────────
  const totalRows = gfs.totalRows + ecmwf.totalRows;
  if (totalRows > 0) {
    const storms = await detectStormsAfterCollect(fetchedAt);
    console.log(`[collect] storm detection — ${storms} storms upserted`);
  }

  if (totalRows === 0) {
    console.error('[collect] zero rows inserted — marking run as failed');
    process.exit(1);
  }

  console.log(`[collect] done — ${totalRows} total rows, ${mapPoints.length} map points`);
}

main().catch(e => {
  console.error('[collect] fatal:', e);
  process.exit(1);
});
