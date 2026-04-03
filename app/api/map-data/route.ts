/**
 * GET /api/map-data
 *
 * Returns all locations with non-zero predicted snowfall in the next 7 days,
 * based on the most recent cron run. Used to render the map circles.
 */
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const windowStart = new Date().toISOString();
  const windowEnd   = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();

  // Find the most recent fetch across all locations.
  const [latest] = await sql`
    SELECT MAX(fetched_at) AS t FROM forecast_snapshots WHERE source = 'open-meteo'
  `;
  const fetchedAt = latest?.t as Date | null;

  if (!fetchedAt) {
    return NextResponse.json({ fetchedAt: null, points: [] });
  }

  // Sum snow for each location within the storm window, from the latest cron run.
  const rows = await sql`
    SELECT
      l.id                                       AS location_id,
      l.lat,
      l.lon,
      ROUND((SUM(fs.snow_cm) * 0.3937)::numeric, 2) AS snow_in
    FROM forecast_snapshots fs
    JOIN locations l ON l.id = fs.location_id
    WHERE fs.source     = 'open-meteo'
      AND fs.fetched_at = ${fetchedAt.toISOString()}::timestamptz
      AND fs.valid_time >= ${windowStart}::timestamptz
      AND fs.valid_time <  ${windowEnd}::timestamptz
    GROUP BY l.id, l.lat, l.lon
    HAVING SUM(fs.snow_cm) > 0
    ORDER BY snow_in DESC
  `;

  const points = rows.map(r => ({
    locationId: r.location_id as number,
    lat:        r.lat         as number,
    lon:        r.lon         as number,
    snowIn:     Number(r.snow_in),
  }));

  return NextResponse.json({ fetchedAt: fetchedAt.toISOString(), points });
}
