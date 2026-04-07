#!/usr/bin/env tsx
/**
 * Fetches top 1,000 US cities with population and writes a static JSON file.
 * Run once: npx tsx scripts/generate-cities.ts
 * Output: lib/us-cities.json
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

const STATE_ABBR: Record<string, string> = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
  'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
  'District of Columbia': 'DC', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI',
  'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
  'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME',
  'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN',
  'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE',
  'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
  'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
  'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX',
  'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA',
  'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
};

async function main() {
  const res = await fetch('https://raw.githubusercontent.com/plotly/datasets/master/us-cities-top-1k.csv');
  const text = await res.text();
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');

  const cities: { name: string; state: string; pop: number; lat: number; lon: number }[] = [];

  for (let i = 1; i < lines.length; i++) {
    // CSV parsing — handle quoted fields
    const parts = lines[i].match(/(".*?"|[^,]+)/g) ?? [];
    const city = parts[0]?.replace(/"/g, '').trim();
    const stateFull = parts[1]?.replace(/"/g, '').trim();
    const pop = Number(parts[2]?.trim());
    const lat = Number(parts[3]?.trim());
    const lon = Number(parts[4]?.trim());

    const abbr = STATE_ABBR[stateFull];
    if (!abbr || !city || !pop || !lat) continue;
    // Exclude Alaska and Hawaii
    if (abbr === 'AK' || abbr === 'HI') continue;

    cities.push({ name: city, state: abbr, pop, lat, lon });
  }

  // Sort by population descending
  cities.sort((a, b) => b.pop - a.pop);

  const outPath = join(__dirname, '..', 'lib', 'us-cities.json');
  writeFileSync(outPath, JSON.stringify(cities, null, 2));
  console.log(`Wrote ${cities.length} cities to ${outPath}`);
  console.log('Top 5:', cities.slice(0, 5).map(c => `${c.name}, ${c.state} (${c.pop})`).join('; '));
}

main().catch(e => { console.error(e); process.exit(1); });
