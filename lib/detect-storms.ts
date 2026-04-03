/**
 * Storm detection — runs after each collect pass.
 *
 * Algorithm per location:
 *   1. Load the latest hourly forecast (only non-zero rows stored).
 *   2. Group hours into contiguous blocks, bridging gaps ≤ 12 h.
 *   3. Discard blocks totalling < 1 inch (2.54 cm).
 *   4. For each qualifying block, upsert a storm row — extending an
 *      existing storm's window if the windows overlap, inserting a new
 *      one otherwise.
 */

import { sql } from './db';

const THRESHOLD_CM      = 2.54; // 1 inch
const GAP_TOLERANCE_MS  = 12 * 3_600_000; // 12 hours in ms

interface HourRow { valid_time: Date; snow_cm: number }
interface Window  { start: Date; end: Date; totalCm: number }

function detectWindows(rows: HourRow[]): Window[] {
  if (!rows.length) return [];

  const sorted = [...rows].sort((a, b) => a.valid_time.getTime() - b.valid_time.getTime());
  const windows: Window[] = [];

  let start: Date | null = null;
  let end:   Date | null = null;
  let last:  Date | null = null;
  let total  = 0;

  const save = () => {
    if (start && end) {
      // window_end is exclusive: one hour past the last snowy hour
      windows.push({ start, end: new Date(end.getTime() + 3_600_000), totalCm: total });
    }
  };

  for (const row of sorted) {
    if (row.snow_cm <= 0) continue;

    if (start === null) {
      start = row.valid_time;
      end   = row.valid_time;
      last  = row.valid_time;
      total = row.snow_cm;
    } else if (row.valid_time.getTime() - last!.getTime() <= GAP_TOLERANCE_MS) {
      end   = row.valid_time;
      last  = row.valid_time;
      total += row.snow_cm;
    } else {
      save();
      start = row.valid_time;
      end   = row.valid_time;
      last  = row.valid_time;
      total = row.snow_cm;
    }
  }
  save();

  return windows.filter(w => w.totalCm >= THRESHOLD_CM);
}

/**
 * Detect storms for every location that has data in the given collect run.
 * Returns the number of storm rows upserted.
 */
export async function detectStormsAfterCollect(fetchedAt: string): Promise<number> {
  // Pull all rows for this fetch in one query — only locations with snow.
  const rows = await sql`
    SELECT location_id, valid_time, snow_cm
    FROM   forecast_snapshots
    WHERE  fetched_at = ${fetchedAt}::timestamptz
      AND  source     = 'open-meteo'
    ORDER  BY location_id, valid_time
  ` as { location_id: number; valid_time: Date; snow_cm: number }[];

  if (!rows.length) return 0;

  // Group by location_id in memory.
  const byLocation = new Map<number, HourRow[]>();
  for (const r of rows) {
    if (!byLocation.has(r.location_id)) byLocation.set(r.location_id, []);
    byLocation.get(r.location_id)!.push({ valid_time: r.valid_time, snow_cm: r.snow_cm });
  }

  let upserted = 0;

  for (const [locationId, hourRows] of byLocation) {
    const windows = detectWindows(hourRows);

    for (const w of windows) {
      const startIso = w.start.toISOString();
      const endIso   = w.end.toISOString();

      // Does an overlapping storm already exist for this location?
      const existing = await sql`
        SELECT id, window_start, window_end
        FROM   storms
        WHERE  location_id  = ${locationId}
          AND  window_start < ${endIso}::timestamptz
          AND  window_end   > ${startIso}::timestamptz
        LIMIT 1
      `;

      if (existing.length > 0) {
        const { id, window_start, window_end } = existing[0] as {
          id: number; window_start: Date; window_end: Date;
        };
        // Expand the window if this forecast extends it.
        const newStart = w.start < window_start ? startIso : window_start.toISOString();
        const newEnd   = w.end   > window_end   ? endIso   : window_end.toISOString();
        await sql`
          UPDATE storms
          SET window_start = ${newStart}::timestamptz,
              window_end   = ${newEnd}::timestamptz
          WHERE id = ${id}
        `;
      } else {
        await sql`
          INSERT INTO storms (location_id, window_start, window_end)
          VALUES (${locationId}, ${startIso}::timestamptz, ${endIso}::timestamptz)
        `;
      }
      upserted++;
    }
  }

  return upserted;
}
