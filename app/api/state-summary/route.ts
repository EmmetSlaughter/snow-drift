/**
 * GET /api/state-summary
 *
 * Returns max predicted snowfall per state from the map cache.
 * Used by the national overview to color state buttons by severity.
 *
 * Response: { fetchedAt, states: { [abbr]: { maxSnowIn, pointCount } } }
 */
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { STATE_BOUNDS } from '@/lib/state-bounds';

export const dynamic = 'force-dynamic';

function assignStates(lat: number, lon: number): string[] {
  const matches: string[] = [];
  for (const [abbr, b] of Object.entries(STATE_BOUNDS)) {
    if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) {
      matches.push(abbr);
    }
  }
  return matches;
}

export async function GET() {
  const rows = await sql`SELECT fetched_at, data FROM map_cache WHERE id = 1`;

  if (rows.length === 0) {
    return NextResponse.json({ fetchedAt: null, states: {} });
  }

  const { fetched_at, data } = rows[0] as {
    fetched_at: Date;
    data: { locationId: number; lat: number; lon: number; snowIn: number }[];
  };

  const stateSummary: Record<string, { maxSnowIn: number; pointCount: number }> = {};

  for (const pt of data) {
    const states = assignStates(pt.lat, pt.lon);
    for (const abbr of states) {
      if (!stateSummary[abbr]) stateSummary[abbr] = { maxSnowIn: 0, pointCount: 0 };
      if (pt.snowIn > stateSummary[abbr].maxSnowIn) {
        stateSummary[abbr].maxSnowIn = pt.snowIn;
      }
      stateSummary[abbr].pointCount++;
    }
  }

  return NextResponse.json(
    { fetchedAt: fetched_at.toISOString(), states: stateSummary },
    { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } },
  );
}
