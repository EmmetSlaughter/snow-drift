/**
 * GET /api/map-data
 *
 * Returns all locations with non-zero predicted snowfall in the next 7 days.
 * Reads from the pre-aggregated map_cache table (updated each cron run)
 * instead of scanning all forecast_snapshots.
 */
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const rows = await sql`SELECT fetched_at, data FROM map_cache WHERE id = 1`;

  if (rows.length === 0) {
    return NextResponse.json({ fetchedAt: null, points: [] });
  }

  const { fetched_at, data } = rows[0] as { fetched_at: Date; data: unknown };

  return NextResponse.json(
    { fetchedAt: fetched_at.toISOString(), points: data },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
      },
    },
  );
}
