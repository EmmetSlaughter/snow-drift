/**
 * GET /api/grid-points?state=<abbr>
 *
 * Returns all grid point locations within a state's bounding box.
 * Used by the state detail page to make every grid cell clickable,
 * regardless of whether it has snow data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { STATE_BOUNDS } from '@/lib/state-bounds';

export const dynamic = 'force-dynamic';

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

  return NextResponse.json(
    { points: rows },
    { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=86400' } },
  );
}
