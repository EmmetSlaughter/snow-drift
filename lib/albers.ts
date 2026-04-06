/**
 * Lightweight Albers Equal-Area Conic projection matching our SVG generation.
 * Same parameters as d3 geoAlbers() with scale(1300) translate([480,300]).
 *
 * Projects [lon, lat] → [x, y] in SVG coordinate space (960×600 viewBox).
 */

const RAD = Math.PI / 180;

// geoAlbers defaults: parallels [29.5, 45.5], rotate [96, 0], center [0, 38.5]
const phi1 = 29.5 * RAD;
const phi2 = 45.5 * RAD;
const n = 0.5 * (Math.sin(phi1) + Math.sin(phi2));
const C = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
const phi0 = 38.5 * RAD;
const rho0 = Math.sqrt(C - 2 * n * Math.sin(phi0)) / n;

const SCALE = 1300;
// Calibrated to match d3 geoAlbers().scale(1300).translate([480,300])
const TX = 490.5;
const TY = 304.6;
const LAMBDA0 = -96 * RAD;

export function albersProject(lon: number, lat: number): [number, number] {
  const lambda = lon * RAD - LAMBDA0;
  const phi = lat * RAD;
  const rho = Math.sqrt(C - 2 * n * Math.sin(phi)) / n;
  const theta = n * lambda;

  // d3 geoAlbers uses y-down convention (negated Y)
  const x = SCALE * rho * Math.sin(theta) + TX;
  const y = SCALE * (rho * Math.cos(theta) - rho0) + TY;

  return [x, y];
}
