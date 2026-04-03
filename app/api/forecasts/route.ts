/**
 * GET /api/forecasts?locationId=<id>&stormId=<id>
 *
 * Returns:
 *   series  — drift time-series (how the total forecast changed over time)
 *   hourly  — hour-by-hour snowfall from the most recent forecast (when snow falls)
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get('locationId');
  const stormId    = searchParams.get('stormId');

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  let windowStart: string;
  let windowEnd:   string;

  if (stormId) {
    const [storm] = await sql`
      SELECT window_start, window_end FROM storms WHERE id = ${Number(stormId)}
    `;
    if (!storm) {
      return NextResponse.json({ error: 'Storm not found' }, { status: 404 });
    }
    windowStart = (storm.window_start as Date).toISOString();
    windowEnd   = (storm.window_end   as Date).toISOString();
  } else {
    windowStart = searchParams.get('start') ?? new Date().toISOString();
    windowEnd   = searchParams.get('end')   ?? new Date(Date.now() + 48 * 3_600_000).toISOString();
  }

  // ── Drift series (existing) ───────────────────────────────────────────────
  const driftRows = await sql`
    SELECT
      source,
      date_trunc('hour', fetched_at)             AS fetched_at,
      ROUND((SUM(snow_cm) * 0.3937)::numeric, 2) AS snow_in
    FROM forecast_snapshots
    WHERE location_id = ${Number(locationId)}
      AND valid_time >= ${windowStart}::timestamptz
      AND valid_time <  ${windowEnd}::timestamptz
    GROUP BY source, date_trunc('hour', fetched_at)
    ORDER BY source, fetched_at
  `;

  const seriesMap: Record<string, { fetchedAt: string; snowIn: number }[]> = {};
  for (const row of driftRows) {
    const src = row.source as string;
    if (!seriesMap[src]) seriesMap[src] = [];
    seriesMap[src].push({
      fetchedAt: (row.fetched_at as Date).toISOString(),
      snowIn:    Number(row.snow_in),
    });
  }
  const series = Object.entries(seriesMap).map(([source, points]) => ({ source, points }));

  // ── Hourly breakdown (new) ────────────────────────────────────────────────
  // For each source, get the most recent fetch's hour-by-hour snowfall.
  const hourlyRows = await sql`
    WITH latest AS (
      SELECT source, MAX(date_trunc('hour', fetched_at)) AS fetched_at
      FROM   forecast_snapshots
      WHERE  location_id = ${Number(locationId)}
        AND  valid_time >= ${windowStart}::timestamptz
        AND  valid_time <  ${windowEnd}::timestamptz
      GROUP  BY source
    )
    SELECT
      fs.source,
      fs.valid_time,
      ROUND((fs.snow_cm * 0.3937)::numeric, 2) AS snow_in
    FROM   forecast_snapshots fs
    JOIN   latest l
      ON   l.source     = fs.source
     AND   date_trunc('hour', fs.fetched_at) = l.fetched_at
    WHERE  fs.location_id = ${Number(locationId)}
      AND  fs.valid_time  >= ${windowStart}::timestamptz
      AND  fs.valid_time  <  ${windowEnd}::timestamptz
    ORDER  BY fs.valid_time
  `;

  // Group into { validTime, "open-meteo": X, "nws": Y } entries
  const hourlyMap = new Map<string, Record<string, string | number>>();
  for (const row of hourlyRows) {
    const t   = (row.valid_time as Date).toISOString();
    const src = row.source as string;
    if (!hourlyMap.has(t)) hourlyMap.set(t, { t });
    hourlyMap.get(t)![src] = Number(row.snow_in);
  }
  const hourly = Array.from(hourlyMap.values()).sort(
    (a, b) => (a.t as string).localeCompare(b.t as string),
  );

  return NextResponse.json({ series, hourly, windowStart, windowEnd });
}
