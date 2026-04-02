/**
 * GET /api/forecasts?locationId=<id>&start=<ISO>&end=<ISO>
 *
 * Returns the drift time-series for a single grid point: for each hourly
 * cron snapshot, the total predicted snowfall in the given storm window.
 * Used to render the per-point drift chart in the map popup.
 *
 * Response:
 * {
 *   series: [{ source, points: [{ fetchedAt, snowIn }] }],
 *   windowStart, windowEnd
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const locationId  = searchParams.get('locationId');
  const windowStart = searchParams.get('start') ?? new Date().toISOString();
  const windowEnd   = searchParams.get('end')   ?? new Date(Date.now() + 48 * 3_600_000).toISOString();

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const rows = await sql`
    SELECT
      source,
      date_trunc('hour', fetched_at)               AS fetched_at,
      ROUND((SUM(snow_cm) * 0.3937)::numeric, 2)   AS snow_in
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
