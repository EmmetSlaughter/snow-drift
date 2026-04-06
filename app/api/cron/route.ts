/**
 * GET /api/cron
 * Polls Open-Meteo for all grid locations, aggregates map data into
 * map_cache, and stores detailed hourly rows only for snowy locations
 * (for drift charts).  Prunes snapshots older than 7 days.
 *
 * Called hourly by cron-job.org:
 *   Authorization: Bearer <CRON_SECRET>
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureSchema } from '@/lib/db';
import { fetchOpenMeteoSnowBatch } from '@/lib/open-meteo';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

const OM_BATCH_SIZE = 500;
const OM_PAUSE_MS   = 2000;
const MAX_ROWS_PER_RUN   = 50_000;
const MAX_SNAPSHOT_ROWS  = 8_000_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureSchema();

  const fetchedAt = new Date().toISOString();
  const windowEnd = new Date(Date.now() + 7 * 24 * 3_600_000);
  const now       = new Date();
  const result: Record<string, unknown> = { fetchedAt };

  // ── Load all locations ────────────────────────────────────────────────────
  const locations = await sql`SELECT id, lat, lon FROM locations ORDER BY id` as {
    id: number; lat: number; lon: number;
  }[];

  if (locations.length === 0) {
    return NextResponse.json({ error: 'No locations seeded. Run /api/locations/seed first.' }, { status: 400 });
  }

  // ── Prune old data ─────────────────────────────────────────────────────────
  await sql`DELETE FROM forecast_snapshots WHERE fetched_at < NOW() - INTERVAL '3 days'`;
  await sql`DELETE FROM storms WHERE window_end < NOW()`;

  // Safety: abort if table is already too large.
  const [{ count: snapshotCount }] = await sql`
    SELECT COUNT(*)::integer AS count FROM forecast_snapshots
  ` as { count: number }[];
  if (snapshotCount > MAX_SNAPSHOT_ROWS) {
    return NextResponse.json({
      error: `Snapshot table has ${snapshotCount} rows (cap: ${MAX_SNAPSHOT_ROWS}) — skipping to protect DB costs`,
    }, { status: 429 });
  }

  // ── Chunk locations into batches ──────────────────────────────────────────
  const batches: typeof locations[] = [];
  for (let i = 0; i < locations.length; i += OM_BATCH_SIZE) {
    batches.push(locations.slice(i, i + OM_BATCH_SIZE));
  }

  let totalRows   = 0;
  let batchErrors = 0;
  const sampleErrors: string[] = [];

  // Per-location 7-day snow totals for the map cache.
  const locationLookup = new Map(locations.map(l => [l.id, { lat: l.lat, lon: l.lon }]));
  const mapTotals = new Map<number, { lat: number; lon: number; snowCm: number }>();

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(OM_PAUSE_MS);
    try {
      const rows = await fetchOpenMeteoSnowBatch(batches[i]);

      // Accumulate map totals in-memory.
      for (const r of rows) {
        if (r.validTime >= now && r.validTime < windowEnd) {
          const loc = locationLookup.get(r.locationId)!;
          const entry = mapTotals.get(r.locationId) ?? { lat: loc.lat, lon: loc.lon, snowCm: 0 };
          entry.snowCm += r.snowCm;
          mapTotals.set(r.locationId, entry);
        }
      }

      // Write detailed hourly rows (for drift charts).
      if (rows.length === 0) continue;

      const locationIds = rows.map(r => r.locationId);
      const times       = rows.map(r => r.validTime.toISOString());
      const cms         = rows.map(r => r.snowCm);

      await sql`
        INSERT INTO forecast_snapshots (fetched_at, location_id, source, valid_time, snow_cm)
        SELECT
          ${fetchedAt}::timestamptz,
          unnest(${locationIds}::integer[]),
          'open-meteo',
          unnest(${times}::text[])::timestamptz,
          unnest(${cms}::double precision[])
      `;
      totalRows += rows.length;
      if (totalRows >= MAX_ROWS_PER_RUN) {
        console.warn(`[cron] hit per-run cap of ${MAX_ROWS_PER_RUN} rows — stopping early`);
        break;
      }
    } catch (e) {
      batchErrors++;
      if (sampleErrors.length < 3) sampleErrors.push(String(e));
      console.error('[cron] batch error:', e);
    }
  }

  // ── Write map cache ─────────────────────────────────────────────────────
  const mapPoints: { locationId: number; lat: number; lon: number; snowIn: number }[] = [];
  for (const [locationId, entry] of mapTotals) {
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

  result.locations    = locations.length;
  result.batches      = batches.length;
  result.rowsInserted = totalRows;
  result.mapPoints    = mapPoints.length;
  result.batchErrors  = batchErrors;
  if (sampleErrors.length) result.sampleErrors = sampleErrors;

  return NextResponse.json(result);
}
