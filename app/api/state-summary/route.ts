/**
 * GET /api/state-summary
 *
 * Returns snow summary per state from the map cache.
 * Uses percentage of grid points with ≥1″ to determine whether a state
 * gets the "solid snow" treatment vs "trace" on the overview map.
 *
 * Response: { fetchedAt, states: { [abbr]: { maxSnowIn, pointCount, snowPct } } }
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

  // Count total grid points per state (from the locations table).
  const allLocs = await sql`SELECT lat, lon FROM locations` as { lat: number; lon: number }[];

  const totalByState: Record<string, number> = {};
  for (const loc of allLocs) {
    for (const abbr of assignStates(loc.lat, loc.lon)) {
      totalByState[abbr] = (totalByState[abbr] ?? 0) + 1;
    }
  }

  // Summarize snowy points per state.
  const stateSummary: Record<string, {
    maxSnowIn: number;
    pointCount: number;   // points with any snow
    points1in: number;    // points with ≥1″
    totalPoints: number;  // total grid points in state
    snowPct: number;      // % of points with ≥1″
  }> = {};

  for (const pt of data) {
    const states = assignStates(pt.lat, pt.lon);
    for (const abbr of states) {
      if (!stateSummary[abbr]) {
        stateSummary[abbr] = {
          maxSnowIn: 0, pointCount: 0, points1in: 0,
          totalPoints: totalByState[abbr] ?? 1, snowPct: 0,
        };
      }
      const s = stateSummary[abbr];
      if (pt.snowIn > s.maxSnowIn) s.maxSnowIn = pt.snowIn;
      s.pointCount++;
      if (pt.snowIn >= 1) s.points1in++;
    }
  }

  // Compute snowPct.
  for (const s of Object.values(stateSummary)) {
    s.snowPct = Math.round((s.points1in / s.totalPoints) * 100);
  }

  return NextResponse.json(
    { fetchedAt: fetched_at.toISOString(), states: stateSummary },
    { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } },
  );
}
