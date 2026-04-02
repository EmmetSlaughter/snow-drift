/**
 * GET /api/locations/seed
 * Populates the locations table with the full US 0.5° grid (~6,000 points).
 * Safe to call multiple times — uses ON CONFLICT DO NOTHING.
 * Run this once after /api/init.
 */
import { NextResponse } from 'next/server';
import { sql, ensureSchema } from '@/lib/db';
import { generateUSGrid } from '@/lib/grid';

export const dynamic   = 'force-dynamic';
export const maxDuration = 60;

const BATCH = 500; // rows per INSERT to stay within query size limits

export async function GET() {
  await ensureSchema();

  const points = generateUSGrid(0.5);
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
  return NextResponse.json({ gridPoints: points.length, inserted, total: Number(count) });
}
