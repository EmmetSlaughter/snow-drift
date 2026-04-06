/**
 * GET /api/storms?locationId=<id>
 *
 * Returns detected storm events for a grid point, newest first.
 * Used by the map popup to populate the storm selector.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get('locationId');

  if (!locationId) {
    return NextResponse.json({ error: 'locationId required' }, { status: 400 });
  }

  const rows = await sql`
    SELECT id, window_start, window_end, detected_at
    FROM   storms
    WHERE  location_id = ${Number(locationId)}
      AND  window_end > NOW()
    ORDER  BY window_start ASC
    LIMIT  20
  `;

  const storms = rows.map(r => ({
    id:          r.id         as number,
    windowStart: (r.window_start as Date).toISOString(),
    windowEnd:   (r.window_end   as Date).toISOString(),
    detectedAt:  (r.detected_at  as Date).toISOString(),
  }));

  return NextResponse.json({ storms });
}
