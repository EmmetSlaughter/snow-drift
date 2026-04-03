#!/usr/bin/env tsx
/**
 * Hourly forecast collection script — executed by GitHub Actions.
 *
 * Fetches Open-Meteo snowfall for every grid location, stores non-zero
 * rows in Neon, and prunes snapshots older than 14 days.
 *
 * Usage:  npm run collect
 * Env:    DATABASE_URL  (required — set as a GitHub Actions secret)
 */

import { sql, ensureSchema } from '../lib/db';
import { fetchOpenMeteoSnowBatch } from '../lib/open-meteo';
import { collectNWSForSnowyLocations } from '../lib/nws';
import { detectStormsAfterCollect } from '../lib/detect-storms';

const BATCH_SIZE    = 500;    // locations per Open-Meteo request
const PAUSE_MS      = 10_000; // ms between requests (~6 req/min, well under free-tier cap)
const RECOVERY_MS   = 30_000; // extra pause after a batch error before continuing

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  console.log('[collect] start', new Date().toISOString());

  await ensureSchema();

  const locations = await sql`
    SELECT id, lat, lon FROM locations ORDER BY id
  ` as { id: number; lat: number; lon: number }[];

  if (locations.length === 0) {
    console.error('[collect] no locations — run /api/locations/seed first');
    process.exit(1);
  }

  // Prune data older than 14 days
  await sql`DELETE FROM forecast_snapshots WHERE fetched_at < NOW() - INTERVAL '14 days'`;

  const fetchedAt = new Date().toISOString();

  // Chunk into batches
  const batches: typeof locations[] = [];
  for (let i = 0; i < locations.length; i += BATCH_SIZE) {
    batches.push(locations.slice(i, i + BATCH_SIZE));
  }

  console.log(`[collect] ${locations.length} locations → ${batches.length} batches`);

  let totalRows = 0;
  let errors    = 0;
  const snowyLocationIds = new Set<number>();

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(PAUSE_MS);

    try {
      const rows = await fetchOpenMeteoSnowBatch(batches[i]);

      if (rows.length > 0) {
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
        for (const r of rows) snowyLocationIds.add(r.locationId);
      }

      console.log(`[collect] batch ${i + 1}/${batches.length} — ${rows.length} non-zero rows`);
    } catch (e) {
      errors++;
      console.error(`[collect] batch ${i + 1} error:`, e);
      console.log(`[collect] rate-limit recovery — waiting ${RECOVERY_MS / 1000}s before next batch`);
      await sleep(RECOVERY_MS);
    }
  }

  console.log(`[collect] open-meteo done — ${totalRows} rows, ${errors} batch errors, ${snowyLocationIds.size} snowy locations`);

  if (snowyLocationIds.size > 0) {
    const nwsRows = await collectNWSForSnowyLocations([...snowyLocationIds], fetchedAt);
    console.log(`[collect] nws — ${nwsRows} rows inserted`);
  }

  if (totalRows > 0) {
    const storms = await detectStormsAfterCollect(fetchedAt);
    console.log(`[collect] storm detection — ${storms} storms upserted`);
  }

  // Only hard-fail if we got nothing at all — partial success is acceptable
  // given shared GitHub Actions IPs and Open-Meteo's per-minute rate limits.
  if (totalRows === 0) {
    console.error('[collect] zero rows inserted — marking run as failed');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[collect] fatal:', e);
  process.exit(1);
});
