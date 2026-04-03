/**
 * GET /api/forecasts?locationId=<id>&stormId=<id>
 *   or
 * GET /api/forecasts?locationId=<id>&start=<ISO>&end=<ISO>
 *
 * Returns the drift time-series for a single grid point: for each hourly
 * snapshot, the total predicted snowfall in the storm window.
 *
 * When stormId is provided the window is read from the storms table,
 * giving a stable fixed window that doesn't expire as real time advances.
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
    // Use the storm's fixed window — never expires as real time advances.
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

  const rows = await sql`
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
  for (const row of rows) {
    const src = row.source as string;
    if (!seriesMap[src]) seriesMap[src] = [];
    seriesMap[src].push({
      fetchedAt: (row.fetched_at as Date).toISOString(),
      snowIn:    Number(row.snow_in),
    });
  }

  const series = Object.entries(seriesMap).map(([source, points]) => ({ source, points }));
  return NextResponse.json({ series, windowStart, windowEnd });
}
