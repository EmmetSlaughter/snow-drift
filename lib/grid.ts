/**
 * Generates a regular lat/lon grid covering the contiguous United States.
 * Default step: 0.5° ≈ 55 km, producing ~6,000 points.
 */

export interface GridPoint {
  lat: number;
  lon: number;
}

const LAT_MIN =  24.5;
const LAT_MAX =  49.5;
const LON_MIN = -125.0;
const LON_MAX =  -66.5;

export function generateUSGrid(stepDeg = 0.5): GridPoint[] {
  const points: GridPoint[] = [];
  // Use integer loop counters to avoid floating-point accumulation drift.
  const latSteps = Math.round((LAT_MAX - LAT_MIN) / stepDeg);
  const lonSteps = Math.round((LON_MAX - LON_MIN) / stepDeg);

  for (let i = 0; i <= latSteps; i++) {
    for (let j = 0; j <= lonSteps; j++) {
      points.push({
        lat: Math.round((LAT_MIN + i * stepDeg) * 1000) / 1000,
        lon: Math.round((LON_MIN + j * stepDeg) * 1000) / 1000,
      });
    }
  }
  return points;
}
