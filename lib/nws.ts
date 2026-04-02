/**
 * Fetches hourly snowfall predictions from the NWS gridpoints API.
 * Values come back in whatever unit `snowfallAmount.uom` specifies
 * (usually wmoUnit:m); we normalize to cm.
 *
 * Docs: https://www.weather.gov/documentation/services-web-api
 */

const LAT = 42.3765;
const LON = -71.2356;
const USER_AGENT = 'snow-drift/1.0 (https://github.com/your-org/snow-drift)';

export interface HourlySnowCm {
  validTime: Date;
  snowCm: number;
}

// Module-level cache — refreshed each cold start, fine for serverless.
let cachedGridpoint: { office: string; gridX: number; gridY: number } | null = null;

async function getGridpoint() {
  if (cachedGridpoint) return cachedGridpoint;

  const res = await fetch(`https://api.weather.gov/points/${LAT},${LON}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
  });
  if (!res.ok) {
    throw new Error(`NWS /points error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  cachedGridpoint = {
    office: json.properties.gridId as string,
    gridX:  json.properties.gridX  as number,
    gridY:  json.properties.gridY  as number,
  };
  return cachedGridpoint;
}

/**
 * Parse ISO 8601 duration strings like PT1H, PT6H, P1D, P1DT6H.
 * Returns the number of whole hours (minimum 1).
 */
function parseDurationHours(duration: string): number {
  const m = duration.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:\d+M)?)?/);
  if (!m) return 1;
  return Math.max(1, Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0));
}

/** Convert NWS native unit to cm. */
function toCm(value: number, uom: string): number {
  if (uom.endsWith(':mm')) return value / 10;
  if (uom.endsWith(':cm')) return value;
  // default: wmoUnit:m
  return value * 100;
}

export async function fetchNWSSnowCm(): Promise<HourlySnowCm[]> {
  const { office, gridX, gridY } = await getGridpoint();

  const res = await fetch(
    `https://api.weather.gov/gridpoints/${office}/${gridX},${gridY}`,
    { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } },
  );
  if (!res.ok) {
    throw new Error(`NWS gridpoints error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();

  const snowProp = json.properties?.snowfallAmount;
  if (!snowProp?.values?.length) return [];

  const uom: string = snowProp.uom ?? 'wmoUnit:m';
  const results: HourlySnowCm[] = [];

  for (const entry of snowProp.values as { validTime: string; value: number | null }[]) {
    if (entry.value == null) continue;

    // validTime: "2024-01-15T06:00:00+00:00/PT3H"
    const slashIdx = entry.validTime.lastIndexOf('/');
    const timeStr  = entry.validTime.slice(0, slashIdx);
    const durStr   = entry.validTime.slice(slashIdx + 1);
    const hours    = parseDurationHours(durStr);
    const cmPerHour = toCm(entry.value, uom) / hours;
    const start    = new Date(timeStr);

    for (let h = 0; h < hours; h++) {
      results.push({
        validTime: new Date(start.getTime() + h * 3_600_000),
        snowCm: cmPerHour,
      });
    }
  }

  return results;
}
