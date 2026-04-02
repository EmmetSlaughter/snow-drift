/**
 * GET /api/init
 * One-time endpoint to create the database schema.
 * Hit this once after setting DATABASE_URL, or just let /api/cron do it.
 */
import { NextResponse } from 'next/server';
import { ensureSchema } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  await ensureSchema();
  return NextResponse.json({ ok: true, message: 'Schema ready.' });
}
