/**
 * GET /api/cron
 * Polls Open-Meteo for all grid locations and stores non-zero snow forecasts.
 * Also prunes snapshots older than 14 days to keep the DB footprint bounded.
 *
 * Called hourly by cron-job.org:
 *   Authorization: Bearer <CRON_SECRET>
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureSchema } from '@/lib/db';
import { fetchOpenMeteoSnowBatch } from '@/lib/open-meteo';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

const OM_BATCH_SIZE = 500; // locations per request → ~13 requests total
const OM_PAUSE_MS   = 2000; // 2s between requests — keeps us well under the free-tier per-minute cap

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureSchema();

  const fetchedAt = new Date().toISOString();
  const result: Record<string, unknown> = { fetchedAt };

  // ── Load all locations ────────────────────────────────────────────────────
  const locations = await sql`SELECT id, lat, lon FROM locations ORDER BY id` as {
    id: number; lat: number; lon: number;
  }[];

  if (locations.length === 0) {
    return NextResponse.json({ error: 'No locations seeded. Run /api/locations/seed first.' }, { status: 400 });
  }

  // ── Prune data older than 14 days ─────────────────────────────────────────
  await sql`DELETE FROM forecast_snapshots WHERE fetched_at < NOW() - INTERVAL '14 days'`;

  // ── Chunk locations into batches ──────────────────────────────────────────
  const batches: typeof locations[] = [];
  for (let i = 0; i < locations.length; i += OM_BATCH_SIZE) {
    batches.push(locations.slice(i, i + OM_BATCH_SIZE));
  }

  let totalRows   = 0;
  let batchErrors = 0;
  const sampleErrors: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(OM_PAUSE_MS);
    try {
      const rows = await fetchOpenMeteoSnowBatch(batches[i]);
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
    } catch (e) {
      batchErrors++;
      if (sampleErrors.length < 3) sampleErrors.push(String(e));
      console.error('[cron] batch error:', e);
    }
  }

  result.locations    = locations.length;
  result.batches      = batches.length;
  result.rowsInserted = totalRows;
  result.batchErrors  = batchErrors;
  if (sampleErrors.length) result.sampleErrors = sampleErrors;

  return NextResponse.json(result);
}
