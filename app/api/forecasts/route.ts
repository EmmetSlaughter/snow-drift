/**
 * GET /api/forecasts?locationId=<id>&stormId=<id>
 *
 * Returns:
 *   series  — drift time-series (how the total forecast changed over time)
 *   hourly  — hour-by-hour snowfall from the most recent forecast (future hours)
 *             plus estimated fallen snow for past hours (from the last forecast
 *             made before each hour occurred)
 *
 * Each hourly entry has a `kind` field: "estimated" for past hours, "predicted"
 * for future hours.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const locationId = searchParams.get('locationId');
  const stormId    = searchParams.get('stormId');

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  let windowStart: string;
  let windowEnd:   string;

  if (stormId) {
    const [storm] = await sql`
      SELECT window_start, window_end FROM storms WHERE id = ${Number(stormId)}
    `;
    if (!storm) {
      return NextResponse.json({ error: 'Storm not found' }, { status: 404 });
    }
    windowStart = (storm.window_start as Date).toISOString();
    windowEnd   = (storm.window_end   as Date).toISOString();
  } else {
    windowStart = searchParams.get('start') ?? new Date().toISOString();
    windowEnd   = searchParams.get('end')   ?? new Date(Date.now() + 48 * 3_600_000).toISOString();
  }

  const now = new Date().toISOString();

  // ── Drift series ──────────────────────────────────────────────────────────
  // For drift, show storm total = estimated fallen (past hours) + predicted
  // remaining (future hours) at each fetch time.
  const driftRows = await sql`
    SELECT
      source,
      date_trunc('hour', fetched_at)             AS fetched_at,
      ROUND((SUM(snow_cm) * 0.3937)::numeric, 2) AS snow_in
    FROM forecast_snapshots
    WHERE location_id = ${Number(locationId)}
      AND valid_time >= ${windowStart}::timestamptz
      AND valid_time <  ${windowEnd}::timestamptz
    GROUP BY source, date_trunc('hour', fetched_at)
    ORDER BY source, fetched_at
  `;

  const seriesMap: Record<string, { fetchedAt: string; snowIn: number }[]> = {};
  for (const row of driftRows) {
    const src = row.source as string;
    if (!seriesMap[src]) seriesMap[src] = [];
    seriesMap[src].push({
      fetchedAt: (row.fetched_at as Date).toISOString(),
      snowIn:    Number(row.snow_in),
    });
  }
  const series = Object.entries(seriesMap).map(([source, points]) => ({ source, points }));

  // ── Hourly breakdown ──────────────────────────────────────────────────────
  // Future hours: latest forecast's hour-by-hour snowfall (as before).
  // Past hours: for each hour that has already passed, pick the snow_cm from
  // the last forecast made *before* that hour — best proxy for what actually fell.

  // 1) Past hours — estimated fallen
  const pastRows = await sql`
    SELECT DISTINCT ON (source, valid_time)
      source,
      valid_time,
      ROUND((snow_cm * 0.3937)::numeric, 2) AS snow_in
    FROM   forecast_snapshots
    WHERE  location_id = ${Number(locationId)}
      AND  valid_time >= ${windowStart}::timestamptz
      AND  valid_time <  ${now}::timestamptz
      AND  fetched_at <  valid_time
    ORDER  BY source, valid_time, fetched_at DESC
  `;

  // 2) Future hours — latest forecast
  const futureRows = await sql`
    WITH latest AS (
      SELECT source, MAX(date_trunc('hour', fetched_at)) AS fetched_at
      FROM   forecast_snapshots
      WHERE  location_id = ${Number(locationId)}
        AND  valid_time >= ${now}::timestamptz
        AND  valid_time <  ${windowEnd}::timestamptz
      GROUP  BY source
    )
    SELECT
      fs.source,
      fs.valid_time,
      ROUND((fs.snow_cm * 0.3937)::numeric, 2) AS snow_in
    FROM   forecast_snapshots fs
    JOIN   latest l
      ON   l.source     = fs.source
     AND   date_trunc('hour', fs.fetched_at) = l.fetched_at
    WHERE  fs.location_id = ${Number(locationId)}
      AND  fs.valid_time  >= ${now}::timestamptz
      AND  fs.valid_time  <  ${windowEnd}::timestamptz
    ORDER  BY fs.valid_time
  `;

  // Merge into unified hourly entries with kind markers.
  // Shape: { t, kind, "open-meteo": X, "nws": Y, ... }
  const hourlyMap = new Map<string, Record<string, string | number>>();

  for (const row of pastRows) {
    const t    = (row.valid_time as Date).toISOString();
    const src  = row.source as string;
    const key  = `${t}:estimated`;
    if (!hourlyMap.has(key)) hourlyMap.set(key, { t, kind: 'estimated' });
    hourlyMap.get(key)![src] = Number(row.snow_in);
  }

  for (const row of futureRows) {
    const t    = (row.valid_time as Date).toISOString();
    const src  = row.source as string;
    const key  = `${t}:predicted`;
    if (!hourlyMap.has(key)) hourlyMap.set(key, { t, kind: 'predicted' });
    hourlyMap.get(key)![src] = Number(row.snow_in);
  }

  const hourly = Array.from(hourlyMap.values()).sort(
    (a, b) => (a.t as string).localeCompare(b.t as string),
  );

  // ── Storm totals ──────────────────────────────────────────────────────────
  // Provide a convenience total: estimated fallen + predicted remaining.
  const estimatedIn: Record<string, number> = {};
  const predictedIn: Record<string, number> = {};
  for (const entry of hourly) {
    const bucket = entry.kind === 'estimated' ? estimatedIn : predictedIn;
    for (const [key, val] of Object.entries(entry)) {
      if (key === 't' || key === 'kind') continue;
      bucket[key] = (bucket[key] ?? 0) + (val as number);
    }
  }

  return NextResponse.json({ series, hourly, windowStart, windowEnd, estimatedIn, predictedIn });
}
