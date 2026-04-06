'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { contours } from 'd3-contour';
import { geoPath } from 'd3-geo';
import detailPaths from '@/lib/state-detail-paths.json';
import { albersProject } from '@/lib/albers';

// ── Types ────────────────────────────────────────────────────────────────────

interface SnowPoint {
  locationId: number;
  lat: number;
  lon: number;
  snowIn: number;
}

interface Storm {
  id: number;
  windowStart: string;
  windowEnd: string;
}

interface DriftPoint  { fetchedAt: string; snowIn: number }
interface DriftSeries { source: string; points: DriftPoint[] }

interface SelectedPoint {
  locationId: number;
  lat: number;
  lon: number;
  snowIn: number;
  svgX: number;
  svgY: number;
  storms: Storm[] | null;
  selectedStormId: number | null;
  drift: DriftSeries[] | null;
  hourly: Record<string, string | number>[] | null;
  loading: boolean;
}

interface DetailEntry {
  abbr: string;
  name: string;
  path: string;
  svgMinX: number;
  svgMinY: number;
  svgWidth: number;
  svgHeight: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SOURCE_COLOR: Record<string, string> = {
  'open-meteo': '#f76707',
  'ecmwf':      '#7c3aed',
  'nws':        '#12b886',
};

const SOURCE_LABEL: Record<string, string> = {
  'open-meteo': 'GFS',
  'ecmwf':      'ECMWF',
  'nws':        'NWS',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtStormLabel(storm: Storm): string {
  const start = new Date(storm.windowStart);
  const end   = new Date(storm.windowEnd);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  const s = start.toLocaleDateString('en-US', opts);
  const e = end.toLocaleDateString('en-US', opts);
  return s === e ? s : `${s} – ${e}`;
}

function fmtTick(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', hour12: true,
  });
}

// ── Component ────────────────────────────────────────────────────────────────

interface StateDetailProps {
  abbr: string;
  points: SnowPoint[];
  fetchedAt: string | null;
}

export function StateDetail({ abbr, points, fetchedAt }: StateDetailProps) {
  const detail = (detailPaths as DetailEntry[]).find(
    s => s.abbr.toLowerCase() === abbr.toLowerCase(),
  );

  const [selected, setSelected] = useState<SelectedPoint | null>(null);

  // Project all snow points to SVG coordinates.
  const projected = points.map(p => {
    const [x, y] = albersProject(p.lon, p.lat);
    return { ...p, svgX: x, svgY: y };
  });

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchStorms = useCallback(async (pt: typeof projected[0]) => {
    setSelected({
      locationId: pt.locationId, lat: pt.lat, lon: pt.lon, snowIn: pt.snowIn,
      svgX: pt.svgX, svgY: pt.svgY,
      storms: null, selectedStormId: null, drift: null, hourly: null, loading: true,
    });
    try {
      const res = await fetch(`/api/storms?locationId=${pt.locationId}`);
      const json = await res.json();
      const storms: Storm[] = json.storms ?? [];
      setSelected(prev => {
        if (prev?.locationId !== pt.locationId) return prev;
        const stormId = storms.length > 0 ? storms[storms.length - 1].id : null;
        return { ...prev, storms, selectedStormId: stormId, loading: storms.length > 0 };
      });
      if (storms.length > 0) {
        fetchDrift(pt.locationId, storms[storms.length - 1].id);
      }
    } catch {
      setSelected(prev => prev?.locationId === pt.locationId
        ? { ...prev, storms: [], loading: false } : prev);
    }
  }, []);

  const fetchDrift = useCallback(async (locationId: number, stormId: number) => {
    try {
      const res = await fetch(`/api/forecasts?locationId=${locationId}&stormId=${stormId}`);
      const json = await res.json();
      setSelected(prev => {
        if (prev?.locationId !== locationId) return prev;
        return {
          ...prev,
          drift: json.series ?? [],
          hourly: json.hourly ?? [],
          loading: false,
        };
      });
    } catch {
      setSelected(prev => prev?.locationId === locationId
        ? { ...prev, drift: [], hourly: [], loading: false } : prev);
    }
  }, []);

  const selectStorm = useCallback((stormId: number) => {
    if (!selected) return;
    setSelected(prev => prev ? { ...prev, selectedStormId: stormId, drift: null, hourly: null, loading: true } : prev);
    fetchDrift(selected.locationId, stormId);
  }, [selected, fetchDrift]);

  // ── Contour generation ────────────────────────────────────────────────────

  const THRESHOLDS = [0.1, 1, 3, 6, 12, 24];
  const COLORS = [
    '#bde0fe', // 0.1 – 1″  (trace)
    '#74b9ff', // 1 – 3″
    '#3a86ff', // 3 – 6″
    '#1e3a8a', // 6 – 12″
    '#6741d9', // 12 – 24″
    '#9c36b5', // 24″+
  ];

  const contourPaths = useMemo(() => {
    if (!detail || projected.length === 0) return [];

    // Build a rasterized grid in SVG coordinate space.
    // We need to cover the state's bounding box with a pixel grid,
    // interpolate snow values, then run d3-contour on it.

    const pad = 5;
    const x0 = detail.svgMinX - pad;
    const y0 = detail.svgMinY - pad;
    const w = detail.svgWidth + pad * 2;
    const h = detail.svgHeight + pad * 2;

    // Grid resolution — higher = smoother but slower
    const cols = Math.min(200, Math.round(w));
    const rows = Math.min(200, Math.round(h));
    const cellW = w / cols;
    const cellH = h / rows;

    // Build the grid with inverse distance weighting interpolation.
    const values = new Float64Array(cols * rows);
    const pts = projected.map(p => ({ x: p.svgX, y: p.svgY, v: p.snowIn }));

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const gx = x0 + (i + 0.5) * cellW;
        const gy = y0 + (j + 0.5) * cellH;

        let weightSum = 0;
        let valSum = 0;
        // Use IDW with power=3 for sharper peaks (power=2 is too smooth).
        // Also limit to nearest 8 points to avoid distant points diluting values.
        const gx2 = gx, gy2 = gy;
        const dists = pts.map(p => ({
          v: p.v,
          d2: (gx2 - p.x) ** 2 + (gy2 - p.y) ** 2,
        })).sort((a, b) => a.d2 - b.d2).slice(0, 8);

        for (const { v, d2 } of dists) {
          const weight = 1 / (d2 ** 1.5 + 0.001); // power=3 (d^2 raised to 1.5)
          weightSum += weight;
          valSum += weight * v;
        }
        values[j * cols + i] = weightSum > 0 ? valSum / weightSum : 0;
      }
    }

    // Generate contours.
    const contourGen = contours()
      .size([cols, rows])
      .thresholds(THRESHOLDS);

    const bands = contourGen(Array.from(values));

    // Create a transform that maps grid coordinates [0..cols, 0..rows]
    // back to SVG coordinates.
    const pathGen = geoPath().projection({
      stream: (output) => ({
        point(px: number, py: number) {
          output.point(x0 + px * cellW, y0 + py * cellH);
        },
        sphere() { output.sphere?.(); },
        lineStart() { output.lineStart(); },
        lineEnd() { output.lineEnd(); },
        polygonStart() { output.polygonStart(); },
        polygonEnd() { output.polygonEnd(); },
      }),
    });

    return bands.map((band, idx) => ({
      d: pathGen(band) ?? '',
      color: COLORS[idx] ?? COLORS[COLORS.length - 1],
      threshold: band.value,
    }));
  }, [detail, projected]);

  if (!detail) return <div className="text-center py-10 text-[#7eaed4]">State not found</div>;

  const vb = `${detail.svgMinX} ${detail.svgMinY} ${detail.svgWidth} ${detail.svgHeight}`;

  // Find nearest grid point to a click for loading storm data.
  const handleMapClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM()?.inverse());
    const clickX = svgPt.x;
    const clickY = svgPt.y;

    // Find nearest projected point.
    let best = projected[0];
    let bestD = Infinity;
    for (const p of projected) {
      const d = (p.svgX - clickX) ** 2 + (p.svgY - clickY) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) fetchStorms(best);
  }, [projected, fetchStorms]);

  return (
    <div className="flex h-full bg-white">
      {/* Map area */}
      <div className="flex-1 relative">
        <svg
          viewBox={vb}
          className="w-full h-full cursor-pointer"
          preserveAspectRatio="xMidYMid meet"
          onClick={handleMapClick}
        >
          <defs>
            <filter id="state-shadow-detail" x="-3%" y="-2%" width="106%" height="108%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#4a7eaa" floodOpacity="0.15" />
            </filter>
            {/* Clip contours to state shape */}
            <clipPath id="state-clip">
              <path d={detail.path} />
            </clipPath>
          </defs>

          {/* State shape background */}
          <path
            d={detail.path}
            fill="#ffffff"
            stroke="#d0dcea"
            strokeWidth={0.5}
            strokeLinejoin="round"
            filter="url(#state-shadow-detail)"
          />

          {/* Contour bands — clipped to state */}
          <g clipPath="url(#state-clip)">
            {contourPaths.map((band, i) => (
              <path
                key={i}
                d={band.d}
                fill={band.color}
                fillOpacity={0.8}
                stroke="none"
              />
            ))}
          </g>

          {/* State border on top */}
          <path
            d={detail.path}
            fill="none"
            stroke="#d0dcea"
            strokeWidth={0.5}
            strokeLinejoin="round"
          />

          {/* Selected point marker */}
          {selected && (
            <>
              <circle
                cx={selected.svgX}
                cy={selected.svgY}
                r={Math.min(detail.svgWidth, detail.svgHeight) * 0.015}
                fill="#f76707"
                stroke="#ffffff"
                strokeWidth={1}
              />
              <text
                x={selected.svgX}
                y={selected.svgY - Math.min(detail.svgWidth, detail.svgHeight) * 0.022}
                textAnchor="middle"
                fontSize={Math.min(detail.svgWidth, detail.svgHeight) * 0.03}
                fontWeight={800}
                fill="#f76707"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {selected.snowIn.toFixed(1)}″
              </text>
            </>
          )}
        </svg>

        {/* Timestamp */}
        {fetchedAt && (
          <div className="absolute bottom-4 left-4 bg-white/60 backdrop-blur-sm rounded-full px-3 py-1 text-xs text-[#7eaed4] font-semibold">
            {new Date(fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
          </div>
        )}

        {/* No data message */}
        {points.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[#7eaed4] font-semibold">No snow in the forecast</p>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="w-80 bg-white/95 backdrop-blur-md border-l border-[#d0dcea] overflow-y-auto p-5 flex flex-col">
          {/* Header */}
          <button
            onClick={() => setSelected(null)}
            className="text-[10px] text-[#7eaed4] hover:text-[#4a4539] mb-3 self-start transition-colors"
          >
            ← close
          </button>

          <div className="flex items-baseline gap-1.5 mb-1">
            <span className="text-4xl font-black text-[#3a86ff] leading-none tabular-nums">
              {selected.snowIn.toFixed(1)}
            </span>
            <span className="text-xl font-bold text-[#a5d8ff] leading-none">″</span>
          </div>
          <p className="text-[11px] text-[#7eaed4] mb-4">
            {selected.lat.toFixed(2)}°N · {Math.abs(selected.lon).toFixed(2)}°W
          </p>

          {/* Storms */}
          {selected.storms === null && (
            <p className="text-xs text-[#7eaed4] animate-pulse">Looking for storms…</p>
          )}
          {selected.storms !== null && selected.storms.length === 0 && (
            <p className="text-xs text-[#7eaed4]">No storms detected yet.</p>
          )}
          {selected.storms !== null && selected.storms.length > 0 && (
            <>
              <p className="text-[10px] text-[#7eaed4] font-bold uppercase tracking-widest mb-2">Storms</p>
              <div className="flex flex-wrap gap-2 mb-3">
                {selected.storms.map(storm => (
                  <button
                    key={storm.id}
                    onClick={() => selectStorm(storm.id)}
                    className={`text-xs font-bold rounded-full px-3.5 py-1.5 transition-all ${
                      selected.selectedStormId === storm.id
                        ? 'bg-[#3a86ff] text-white shadow-sm'
                        : 'bg-[#e8f4ff] text-[#7eaed4] hover:bg-[#d0e8ff]'
                    }`}
                  >
                    {fmtStormLabel(storm)}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Loading */}
          {selected.loading && (
            <p className="text-xs text-[#7eaed4] animate-pulse mt-2">Loading…</p>
          )}

          {/* Hourly chart */}
          {!selected.loading && selected.hourly && selected.hourly.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] text-[#7eaed4] mb-1 font-bold uppercase tracking-widest">
                Snowfall by hour
              </p>
              <ResponsiveContainer width="100%" height={110}>
                <BarChart data={selected.hourly} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e8f4ff" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickFormatter={(iso: string) =>
                      new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
                    }
                    tick={{ fontSize: 8, fill: '#7eaed4' }}
                    minTickGap={30}
                  />
                  <YAxis unit='″' tick={{ fontSize: 9, fill: '#7eaed4' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff', border: '1px solid #d0dcea',
                      borderRadius: 12, fontSize: 11,
                    }}
                    labelFormatter={(iso: string) => fmtTick(iso)}
                    formatter={(v: number, name: string) => [
                      `${v.toFixed(2)}″`,
                      SOURCE_LABEL[name.replace(/:est$|:pred$/, '')] ?? name,
                    ]}
                  />
                  {Object.keys(selected.hourly[0] ?? {})
                    .filter(k => k !== 't' && k !== 'kind')
                    .map(src => (
                      <Bar
                        key={src}
                        dataKey={src}
                        fill={SOURCE_COLOR[src.replace(/:est$|:pred$/, '')] ?? '#3a86ff'}
                        opacity={src.endsWith(':pred') ? 0.45 : 0.85}
                        radius={[2, 2, 0, 0]}
                      />
                    ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Drift chart */}
          {!selected.loading && selected.drift && selected.drift.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] text-[#7eaed4] mb-1 font-bold uppercase tracking-widest">
                Forecast drift
              </p>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart
                  data={(() => {
                    const timeSet = new Set<string>();
                    for (const s of selected.drift!) for (const p of s.points) timeSet.add(p.fetchedAt);
                    const allTimes = Array.from(timeSet).sort();
                    return allTimes.map(t => {
                      const entry: Record<string, string | number> = { t };
                      for (const s of selected.drift!) {
                        const pt = s.points.find(p => p.fetchedAt === t);
                        if (pt) entry[s.source] = pt.snowIn;
                      }
                      return entry;
                    });
                  })()}
                  margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e8f4ff" />
                  <XAxis dataKey="t" tickFormatter={fmtTick} tick={{ fontSize: 9, fill: '#7eaed4' }} minTickGap={60} />
                  <YAxis unit='″' tick={{ fontSize: 9, fill: '#7eaed4' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff', border: '1px solid #d0dcea',
                      borderRadius: 12, fontSize: 11,
                    }}
                    labelFormatter={fmtTick}
                    formatter={(v: number, name: string) => [
                      `${v.toFixed(1)}″`, SOURCE_LABEL[name] ?? name,
                    ]}
                  />
                  {selected.drift.map(s => (
                    <Line
                      key={s.source}
                      type="monotone"
                      dataKey={s.source}
                      stroke={SOURCE_COLOR[s.source] ?? '#3a86ff'}
                      strokeWidth={2.5}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              <div className="flex gap-3 mt-1.5">
                {selected.drift.map(s => (
                  <div key={s.source} className="flex items-center gap-1.5">
                    <span className="inline-block w-3 h-1 rounded-full" style={{ backgroundColor: SOURCE_COLOR[s.source] ?? '#3a86ff' }} />
                    <span className="text-[10px] text-[#7eaed4]">{SOURCE_LABEL[s.source] ?? s.source}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
