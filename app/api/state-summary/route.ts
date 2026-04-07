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

// Assign a point to the single best-matching state (closest center).
// Avoids double-counting points in overlapping bounding boxes.
function assignState(lat: number, lon: number): string | null {
  let bestAbbr: string | null = null;
  let bestDist = Infinity;
  for (const [abbr, b] of Object.entries(STATE_BOUNDS)) {
    if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
    const cLat = (b.minLat + b.maxLat) / 2;
    const cLon = (b.minLon + b.maxLon) / 2;
    const d = (lat - cLat) ** 2 + (lon - cLon) ** 2;
    if (d < bestDist) { bestDist = d; bestAbbr = abbr; }
  }
  return bestAbbr;
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

  // Count total grid points per state (single assignment per point).
  const allLocs = await sql`SELECT lat, lon FROM locations` as { lat: number; lon: number }[];

  const totalByState: Record<string, number> = {};
  for (const loc of allLocs) {
    const abbr = assignState(loc.lat, loc.lon);
    if (abbr) totalByState[abbr] = (totalByState[abbr] ?? 0) + 1;
  }

  // Summarize snowy points per state (single assignment per point).
  const stateSummary: Record<string, {
    maxSnowIn: number;
    pointCount: number;
    points1in: number;
    totalPoints: number;
    snowPct: number;
  }> = {};

  for (const pt of data) {
    const abbr = assignState(pt.lat, pt.lon);
    if (!abbr) continue;
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

  // Compute snowPct.
  for (const s of Object.values(stateSummary)) {
    s.snowPct = Math.round((s.points1in / s.totalPoints) * 100);
  }

  return NextResponse.json(
    { fetchedAt: fetched_at.toISOString(), states: stateSummary },
    { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } },
  );
}
