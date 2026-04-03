/**
 * Fetches hourly snowfall from Open-Meteo for a batch of locations.
 * Uses the commercial API (customer-api.open-meteo.com) when OPEN_METEO_KEY
 * is set, otherwise falls back to the free tier.
 *
 * Supports multiple models: the default GFS-based forecast and ECMWF high-res.
 *
 * Docs: https://open-meteo.com/en/docs
 */

export interface LocationSnowRow {
  locationId: number;
  validTime: Date;
  snowCm: number;
}

const API_KEY = process.env.OPEN_METEO_KEY ?? '';
const BASE    = API_KEY
  ? 'https://customer-api.open-meteo.com/v1'
  : 'https://api.open-meteo.com/v1';

/**
 * Fetch snowfall predictions for a batch of locations from a single model.
 * Only returns rows where snowCm > 0 to minimise DB storage.
 */
export async function fetchOpenMeteoSnowBatch(
  locations: { id: number; lat: number; lon: number }[],
  model: 'forecast' | 'ecmwf' = 'forecast',
): Promise<LocationSnowRow[]> {
  const lats = locations.map(l => l.lat).join(',');
  const lons = locations.map(l => l.lon).join(',');

  const endpoint = model === 'ecmwf' ? 'ecmwf' : 'forecast';
  let url = `${BASE}/${endpoint}` +
    `?latitude=${lats}&longitude=${lons}` +
    `&hourly=snowfall&forecast_days=7&timezone=UTC`;
  if (API_KEY) url += `&apikey=${API_KEY}`;

  // Retry up to 3 times on 429 with exponential backoff.
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url);
    if (res.status !== 429) break;
    const wait = (attempt + 1) * 5_000;
    console.warn(`[open-meteo:${model}] 429 on attempt ${attempt + 1}, retrying in ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
  }
  if (!res || !res.ok) throw new Error(`Open-Meteo ${model} error ${res?.status}: ${await res?.text()}`);
  const json = await res.json();

  // Single location → object; multiple → array.
  const results: { hourly: { time: string[]; snowfall: (number | null)[] } }[] =
    Array.isArray(json) ? json : [json];

  const rows: LocationSnowRow[] = [];

  for (let i = 0; i < results.length; i++) {
    const loc    = locations[i];
    const result = results[i] as Record<string, unknown> & {
      latitude?: number; longitude?: number;
      hourly?: { time: string[]; snowfall: (number | null)[] };
    };

    const snapLat = result.latitude  ?? loc.lat;
    const snapLon = result.longitude ?? loc.lon;
    if (Math.abs(snapLat - loc.lat) > 0.6 || Math.abs(snapLon - loc.lon) > 0.6) {
      continue;
    }

    const times = result.hourly?.time     ?? [];
    const snows = result.hourly?.snowfall ?? [];

    for (let t = 0; t < times.length; t++) {
      const snowCm = snows[t] ?? 0;
      if (snowCm > 0) {
        rows.push({
          locationId: loc.id,
          validTime:  new Date(times[t] + 'Z'),
          snowCm,
        });
      }
    }
  }

  return rows;
}
