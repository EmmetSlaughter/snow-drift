/**
 * GET /api/map-data
 *
 * Returns all locations with non-zero predicted snowfall in the next 7 days.
 * Uses each location's most recent forecast — so partial batch failures in
 * one run don't wipe out data from a previous successful run.
 */
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const windowStart = new Date().toISOString();
  const windowEnd   = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();

  const rows = await sql`
    WITH latest_per_location AS (
      SELECT DISTINCT ON (location_id)
        location_id, fetched_at
      FROM   forecast_snapshots
      WHERE  source     = 'open-meteo'
        AND  fetched_at > NOW() - INTERVAL '12 hours'
      ORDER  BY location_id, fetched_at DESC
    )
    SELECT
      l.id  AS location_id,
      l.lat,
      l.lon,
      lpl.fetched_at,
      ROUND((SUM(fs.snow_cm) * 0.3937)::numeric, 2) AS snow_in
    FROM   latest_per_location lpl
    JOIN   forecast_snapshots fs
      ON   fs.location_id = lpl.location_id
     AND   fs.fetched_at  = lpl.fetched_at
     AND   fs.source      = 'open-meteo'
    JOIN   locations l ON l.id = fs.location_id
    WHERE  fs.valid_time >= ${windowStart}::timestamptz
      AND  fs.valid_time <  ${windowEnd}::timestamptz
    GROUP  BY l.id, l.lat, l.lon, lpl.fetched_at
    HAVING SUM(fs.snow_cm) > 0
    ORDER  BY snow_in DESC
  `;

  // Use the most recent fetched_at across all returned points.
  let fetchedAt: string | null = null;
  if (rows.length > 0) {
    const maxT = rows.reduce((a, b) =>
      (a.fetched_at as Date) > (b.fetched_at as Date) ? a : b,
    );
    fetchedAt = (maxT.fetched_at as Date).toISOString();
  }

  const points = rows.map(r => ({
    locationId: r.location_id as number,
    lat:        r.lat         as number,
    lon:        r.lon         as number,
    snowIn:     Number(r.snow_in),
  }));

  return NextResponse.json({ fetchedAt, points });
}
