/**
 * GET /api/grid-points?state=<abbr>
 *
 * Returns all grid point locations that belong to a state.
 * Uses closest-center assignment to avoid bounding box overlap
 * with neighboring states.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { STATE_BOUNDS } from '@/lib/state-bounds';

export const dynamic = 'force-dynamic';

function bestState(lat: number, lon: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [abbr, b] of Object.entries(STATE_BOUNDS)) {
    if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
    const cLat = (b.minLat + b.maxLat) / 2;
    const cLon = (b.minLon + b.maxLon) / 2;
    const d = (lat - cLat) ** 2 + (lon - cLon) ** 2;
    if (d < bestD) { bestD = d; best = abbr; }
  }
  return best;
}

export async function GET(req: NextRequest) {
  const abbr = req.nextUrl.searchParams.get('state')?.toLowerCase();
  if (!abbr || !STATE_BOUNDS[abbr]) {
    return NextResponse.json({ error: 'Valid state abbreviation required' }, { status: 400 });
  }

  const b = STATE_BOUNDS[abbr];
  const rows = await sql`
    SELECT id, lat, lon FROM locations
    WHERE lat >= ${b.minLat} AND lat <= ${b.maxLat}
      AND lon >= ${b.minLon} AND lon <= ${b.maxLon}
    ORDER BY id
  ` as { id: number; lat: number; lon: number }[];

  // Filter to points whose closest state center is this state.
  const filtered = rows.filter(r => bestState(r.lat, r.lon) === abbr);

  return NextResponse.json(
    { points: filtered },
    { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=86400' } },
  );
}
