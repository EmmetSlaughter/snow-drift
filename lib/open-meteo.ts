/**
 * Fetches hourly snowfall from Open-Meteo for a batch of locations in one request.
 * Open-Meteo supports comma-separated lat/lon lists (no API key required).
 * Snowfall is returned in cm/h; we pass it through as-is.
 *
 * Docs: https://open-meteo.com/en/docs
 */

export interface LocationSnowRow {
  locationId: number;
  validTime: Date;
  snowCm: number;
}

/**
 * Fetch snowfall predictions for up to ~100 locations at once.
 * Only returns rows where snowCm > 0 to minimise DB storage.
 */
export async function fetchOpenMeteoSnowBatch(
  locations: { id: number; lat: number; lon: number }[],
): Promise<LocationSnowRow[]> {
  // Build URL manually — URLSearchParams encodes commas as %2C, but Open-Meteo
  // requires literal commas to recognise the multi-location batch format.
  const lats = locations.map(l => l.lat).join(',');
  const lons = locations.map(l => l.lon).join(',');
  const url  = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lats}&longitude=${lons}` +
    `&hourly=snowfall&forecast_days=7&timezone=UTC`;

  // Retry up to 3 times on 429 with exponential backoff.
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url);
    if (res.status !== 429) break;
    const wait = (attempt + 1) * 10_000;
    console.warn(`[open-meteo] 429 on attempt ${attempt + 1}, retrying in ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
  }
  if (!res || !res.ok) throw new Error(`Open-Meteo error ${res?.status}: ${await res?.text()}`);
  const json = await res.json();

  // Single location → object; multiple → array.
  const results: { hourly: { time: string[]; snowfall: (number | null)[] } }[] =
    Array.isArray(json) ? json : [json];

  const rows: LocationSnowRow[] = [];

  for (let i = 0; i < results.length; i++) {
    const loc    = locations[i];
    const times  = results[i]?.hourly?.time     ?? [];
    const snows  = results[i]?.hourly?.snowfall ?? [];

    for (let t = 0; t < times.length; t++) {
      const snowCm = snows[t] ?? 0;
      if (snowCm > 0) {
        rows.push({
          locationId: loc.id,
          validTime:  new Date(times[t] + 'Z'),  // append Z — Open-Meteo returns UTC without it
          snowCm,
        });
      }
    }
  }

  return rows;
}
