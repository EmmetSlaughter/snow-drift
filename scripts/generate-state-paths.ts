#!/usr/bin/env tsx
/**
 * Generates a static JSON file of SVG path data for CONUS states.
 * Applies aggressive simplification for an abstract, rounded look.
 *
 * Run once (or after changing projection): npx tsx scripts/generate-state-paths.ts
 * Output: lib/state-paths.json
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { feature } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';
import { geoAlbers, geoPath } from 'd3-geo';
import type { Topology, GeometryCollection } from 'topojson-specification';

const FIPS_TO_ABBR: Record<string, string> = {
  '01': 'AL', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS',
  '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA',
  '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT',
  '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
  '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK',
  '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA',
  '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY',
};

const EXCLUDE = new Set(['02', '15', '60', '66', '69', '72', '78']);

async function main() {
  const res = await fetch('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json');
  const topo = await res.json() as Topology;

  // Simplify — keep ~12% of detail. Enough to lose noise but keep
  // recognizable features like Cape Cod, FL keys, Chesapeake Bay.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const presimplified = presimplify(topo as any);

  // Overview: abstract shapes for the national map
  const overviewWeight = quantile(presimplified, 0.12);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const simplified = simplify(presimplified, overviewWeight) as any as Topology;
  const states = feature(simplified, simplified.objects.states as GeometryCollection);

  // Detail: keeps coastlines, bays, peninsulas for state zoom
  const detailWeight = quantile(presimplified, 0.45);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const detailTopo = simplify(presimplified, detailWeight) as any as Topology;
  const detailStates = feature(detailTopo, detailTopo.objects.states as GeometryCollection);

  const projection = geoAlbers()
    .scale(1300)
    .translate([480, 300]);

  const pathGen = geoPath(projection);

  const output: {
    fips: string;
    abbr: string;
    name: string;
    path: string;
    labelX: number;
    labelY: number;
    anchorX?: number;
    anchorY?: number;
    external?: boolean;
  }[] = [];

  for (const feat of states.features) {
    const fips = String(feat.id);
    if (EXCLUDE.has(fips)) continue;

    const abbr = FIPS_TO_ABBR[fips];
    if (!abbr) continue;

    const d = pathGen(feat);
    if (!d) continue;

    const centroid = pathGen.centroid(feat);

    output.push({
      fips,
      abbr,
      name: (feat.properties as { name: string }).name,
      path: d,
      labelX: Math.round(centroid[0] * 10) / 10,
      labelY: Math.round(centroid[1] * 10) / 10,
      anchorX: undefined,
      anchorY: undefined,
      external: undefined,
    });
  }

  // Manual label overrides — nudge labels to better visual positions.
  // Offsets are in SVG coordinates (960×600 viewBox, Albers projection).
  const LABEL_OVERRIDES: Record<string, { x: number; y: number; external?: boolean }> = {
    // Florida — centered in the peninsula (bounds: 653-816, 460-601)
    FL: { x: 760, y: 530 },
    // Michigan — center on lower peninsula
    MI: { x: 720, y: 230 },
    // Louisiana — nudge out of coastline
    LA: { x: 620, y: 440 },
    // Idaho — centered in body (bounds: 141-249, 31-205)
    ID: { x: 192, y: 130 },
    // California — nudge right from far-left centroid (bounds: 11-155, 155-402)
    CA: { x: 95, y: 300 },

    // Tiny NE states — stacked in the "ocean", pushed out to avoid MA shape.
    VT: { x: 945, y: 148, external: true },
    NH: { x: 945, y: 163, external: true },
    MA: { x: 945, y: 178, external: true },
    RI: { x: 945, y: 193, external: true },
    CT: { x: 945, y: 208, external: true },
    NJ: { x: 945, y: 248, external: true },
    DE: { x: 945, y: 263, external: true },
    MD: { x: 945, y: 278, external: true },
    DC: { x: 945, y: 293, external: true },
  };

  for (const entry of output) {
    const override = LABEL_OVERRIDES[entry.abbr];
    if (override) {
      // Store original centroid so we can draw connector lines.
      (entry as Record<string, unknown>).anchorX = entry.labelX;
      (entry as Record<string, unknown>).anchorY = entry.labelY;
      entry.labelX = override.x;
      entry.labelY = override.y;
      (entry as Record<string, unknown>).external = !!override.external;
    }
  }

  output.sort((a, b) => a.name.localeCompare(b.name));

  const outPath = join(__dirname, '..', 'lib', 'state-paths.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${output.length} states to ${outPath}`);

  // ── Detail paths for state zoom view ──────────────────────────────────────
  const detailOutput: {
    abbr: string;
    name: string;
    path: string;
    // SVG bounding box for this state (to set viewBox)
    svgMinX: number;
    svgMinY: number;
    svgWidth: number;
    svgHeight: number;
  }[] = [];

  for (const feat of detailStates.features) {
    const fips = String(feat.id);
    if (EXCLUDE.has(fips)) continue;
    const abbr = FIPS_TO_ABBR[fips];
    if (!abbr) continue;

    const d = pathGen(feat);
    if (!d) continue;

    const bounds = pathGen.bounds(feat);
    const pad = 15;
    const minX = Math.floor(bounds[0][0]) - pad;
    const minY = Math.floor(bounds[0][1]) - pad;
    const w = Math.ceil(bounds[1][0] - bounds[0][0]) + pad * 2;
    const h = Math.ceil(bounds[1][1] - bounds[0][1]) + pad * 2;

    detailOutput.push({
      abbr,
      name: (feat.properties as { name: string }).name,
      path: d,
      svgMinX: minX,
      svgMinY: minY,
      svgWidth: w,
      svgHeight: h,
    });
  }

  const detailPath = join(__dirname, '..', 'lib', 'state-detail-paths.json');
  writeFileSync(detailPath, JSON.stringify(detailOutput, null, 2));
  console.log(`Wrote ${detailOutput.length} detail states to ${detailPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
