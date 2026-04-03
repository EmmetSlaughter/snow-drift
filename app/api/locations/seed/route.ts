/**
 * GET /api/locations/seed?step=1.0&clear=true
 *
 * Populates the locations table with a regular US lat/lon grid.
 *
 * Params:
 *   step  — grid spacing in degrees (default: 1.0)
 *   clear — if "true", wipes all existing snapshots and locations first
 *
 * Safe to call without clear=true — uses ON CONFLICT DO NOTHING.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureSchema } from '@/lib/db';
import { generateUSGrid } from '@/lib/grid';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

const BATCH = 500;

export async function GET(req: NextRequest) {
  await ensureSchema();

  const { searchParams } = new URL(req.url);
  const step  = Math.max(0.1, Math.min(2.0, Number(searchParams.get('step') ?? 1.0)));
  const clear = searchParams.get('clear') === 'true';

  if (clear) {
    // Must delete snapshots first due to FK constraint, then locations.
    await sql`TRUNCATE forecast_snapshots, locations RESTART IDENTITY`;
  }

  const points = generateUSGrid(step);
  let inserted = 0;

  for (let i = 0; i < points.length; i += BATCH) {
    const chunk = points.slice(i, i + BATCH);
    const lats  = chunk.map(p => p.lat);
    const lons  = chunk.map(p => p.lon);

    const result = await sql`
      INSERT INTO locations (lat, lon)
      SELECT unnest(${lats}::double precision[]),
             unnest(${lons}::double precision[])
      ON CONFLICT (lat, lon) DO NOTHING
    `;
    inserted += result.length ?? 0;
  }

  const [{ count }] = await sql`SELECT COUNT(*) AS count FROM locations`;
  return NextResponse.json({ step, gridPoints: points.length, inserted, total: Number(count) });
}
