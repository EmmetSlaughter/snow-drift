'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { contours } from 'd3-contour';
import { geoPath } from 'd3-geo';
import detailPaths from '@/lib/state-detail-paths.json';
import citiesData from '@/lib/us-cities.json';
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

interface BloopHour {
  t: string;
  snowIn: number;
  kind: string;
}

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
  bloopcast: BloopHour[] | null;
  bloopTotal: number | null;
  confidence: number | null;
  hourlyView: 'bloop' | string; // 'bloop' or a source name
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

  // Project all snow points to SVG coordinates (memoized to avoid recomputing contours).
  const projected = useMemo(() =>
    points.map(p => {
      const [x, y] = albersProject(p.lon, p.lat);
      return { ...p, svgX: x, svgY: y };
    }),
    [points],
  );

  // ── Cities for this state ─────────────────────────────────────────────────
  const cities = useMemo(() => {
    if (!detail) return [];
    const stateCities = (citiesData as { name: string; state: string; pop: number; lat: number; lon: number }[])
      .filter(c => c.state.toLowerCase() === abbr.toLowerCase());

    // Show top cities by population, scaled to state size.
    // Larger states get more cities, smaller states get fewer.
    const area = detail.svgWidth * detail.svgHeight;
    const maxCities = Math.min(25, Math.max(5, Math.round(area / 2000)));

    return stateCities.slice(0, maxCities).map(c => {
      const [x, y] = albersProject(c.lon, c.lat);
      return { ...c, svgX: x, svgY: y };
    });
  }, [abbr, detail]);

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchStorms = useCallback(async (pt: typeof projected[0]) => {
    setSelected({
      locationId: pt.locationId, lat: pt.lat, lon: pt.lon, snowIn: pt.snowIn,
      svgX: pt.svgX, svgY: pt.svgY,
      storms: null, selectedStormId: null, drift: null, hourly: null,
      bloopcast: null, bloopTotal: null, confidence: null,
      hourlyView: 'bloop', loading: true,
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
          bloopcast: json.bloopcast ?? [],
          bloopTotal: json.bloopTotal ?? null,
          confidence: json.confidence ?? null,
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

    // Grid resolution — keep low for performance. 60×60 = 3,600 cells.
    const cols = Math.min(60, Math.round(w / 3));
    const rows = Math.min(60, Math.round(h / 3));
    const cellW = w / cols;
    const cellH = h / rows;

    // Pre-compute point positions for fast lookup.
    const ptX = projected.map(p => p.svgX);
    const ptY = projected.map(p => p.svgY);
    const ptV = projected.map(p => p.snowIn);
    const n = projected.length;

    // IDW power=2 (simple, fast — no sorting needed).
    // Use a distance cutoff so far-away points don't dilute.
    const cutoff2 = (Math.max(w, h) * 0.4) ** 2;
    const values = new Float64Array(cols * rows);

    for (let j = 0; j < rows; j++) {
      const gy = y0 + (j + 0.5) * cellH;
      for (let i = 0; i < cols; i++) {
        const gx = x0 + (i + 0.5) * cellW;
        let weightSum = 0;
        let valSum = 0;
        for (let k = 0; k < n; k++) {
          const d2 = (gx - ptX[k]) ** 2 + (gy - ptY[k]) ** 2;
          if (d2 > cutoff2) continue;
          const weight = 1 / (d2 + 0.1);
          weightSum += weight;
          valSum += weight * ptV[k];
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
  const svgRef = useRef<SVGSVGElement>(null);
  const lastClickTime = useRef(0);

  const handleMapClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    // Debounce — ignore clicks within 300ms of each other.
    const now = Date.now();
    if (now - lastClickTime.current < 300) return;
    lastClickTime.current = now;

    const svg = svgRef.current;
    if (!svg) return;

    // Use SVG's built-in coordinate transform.
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const inv = ctm.inverse();
    const clickX = inv.a * e.clientX + inv.c * e.clientY + inv.e;
    const clickY = inv.b * e.clientX + inv.d * e.clientY + inv.f;

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
          ref={svgRef}
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

          {/* City labels — outside clipPath so text isn't cut off at borders */}
          {(() => {
            const r = Math.max(0.6, Math.min(detail.svgWidth, detail.svgHeight) * 0.003);
            const fontSize = Math.max(2.5, Math.min(detail.svgWidth, detail.svgHeight) * 0.012);
            const charW = fontSize * 0.55;
            // Simple collision detection: track placed label bounding boxes.
            const placed: { x: number; y: number; w: number; h: number }[] = [];
            return cities.map(city => {
              const lx = city.svgX + r + 1;
              const ly = city.svgY;
              const lw = city.name.length * charW;
              const lh = fontSize * 1.2;
              // Check overlap with already-placed labels.
              const overlaps = placed.some(p =>
                lx < p.x + p.w && lx + lw > p.x &&
                ly - lh / 2 < p.y + p.h / 2 && ly + lh / 2 > p.y - p.h / 2
              );
              if (overlaps) return null;
              placed.push({ x: lx, y: ly, w: lw, h: lh });
              return (
                <g key={`${city.name}-${city.state}`} style={{ pointerEvents: 'none' }}>
                  <circle
                    cx={city.svgX}
                    cy={city.svgY}
                    r={r}
                    fill="#4a4539"
                    fillOpacity={0.5}
                  />
                  <text
                    x={lx}
                    y={ly}
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fontWeight={600}
                    fill="#4a4539"
                    fillOpacity={0.55}
                    style={{ userSelect: 'none' }}
                  >
                    {city.name}
                  </text>
                </g>
              );
            });
          })()}

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
                {(selected.bloopTotal ?? selected.snowIn).toFixed(1)}″
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

          {/* Hero — BloopCast total + confidence */}
          <div className="flex items-baseline gap-1.5 mb-1">
            <span className="text-4xl font-black text-[#3a86ff] leading-none tabular-nums">
              {(selected.bloopTotal ?? selected.snowIn).toFixed(1)}
            </span>
            <span className="text-xl font-bold text-[#a5d8ff] leading-none">″</span>
          </div>
          {selected.confidence !== null && (
            <div className="flex items-center gap-2 mb-1">
              <div className="flex-1 h-1.5 bg-[#e8f4ff] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${selected.confidence}%`,
                    backgroundColor: selected.confidence >= 70 ? '#12b886' : selected.confidence >= 40 ? '#f59f00' : '#e03131',
                  }}
                />
              </div>
              <span className="text-[10px] font-bold text-[#7eaed4]">{selected.confidence}%</span>
            </div>
          )}
          <p className="text-[11px] text-[#7eaed4] mb-1">
            {selected.lat.toFixed(2)}°N · {Math.abs(selected.lon).toFixed(2)}°W
          </p>
          <p className="text-[9px] text-[#a5d8ff] font-semibold uppercase tracking-wider mb-4">
            BloopCast
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

          {/* Hourly chart — BloopCast default, toggleable to individual sources */}
          {!selected.loading && (selected.bloopcast?.length ?? 0) > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-[10px] text-[#7eaed4] font-bold uppercase tracking-widest">
                  Snowfall by hour
                </p>
                <div className="flex gap-1 ml-auto">
                  <button
                    onClick={() => setSelected(prev => prev ? { ...prev, hourlyView: 'bloop' } : prev)}
                    className={`text-[8px] font-bold px-2 py-0.5 rounded-full transition-all ${
                      selected.hourlyView === 'bloop'
                        ? 'bg-[#3a86ff] text-white'
                        : 'bg-[#e8f4ff] text-[#7eaed4] hover:bg-[#d0e8ff]'
                    }`}
                  >
                    Bloop
                  </button>
                  {(selected.drift ?? []).map(s => (
                    <button
                      key={s.source}
                      onClick={() => setSelected(prev => prev ? { ...prev, hourlyView: s.source } : prev)}
                      className={`text-[8px] font-bold px-2 py-0.5 rounded-full transition-all ${
                        selected.hourlyView === s.source
                          ? 'text-white'
                          : 'bg-[#e8f4ff] text-[#7eaed4] hover:bg-[#d0e8ff]'
                      }`}
                      style={selected.hourlyView === s.source ? { backgroundColor: SOURCE_COLOR[s.source] ?? '#3a86ff' } : {}}
                    >
                      {SOURCE_LABEL[s.source] ?? s.source}
                    </button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={110}>
                {selected.hourlyView === 'bloop' ? (
                  <BarChart data={selected.bloopcast ?? []} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
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
                      formatter={(v: number) => [`${v.toFixed(2)}″`, 'BloopCast']}
                    />
                    <Bar
                      dataKey="snowIn"
                      fill="#3a86ff"
                      opacity={0.85}
                      radius={[2, 2, 0, 0]}
                    />
                  </BarChart>
                ) : (
                  <BarChart
                    data={(selected.hourly ?? []).filter(h => {
                      // Show entries that have data for the selected source
                      const src = selected.hourlyView;
                      return h[src] !== undefined || h[`${src}:est`] !== undefined || h[`${src}:pred`] !== undefined;
                    })}
                    margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
                  >
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
                        SOURCE_LABEL[selected.hourlyView] ?? selected.hourlyView,
                      ]}
                    />
                    {[`${selected.hourlyView}:est`, `${selected.hourlyView}:pred`, selected.hourlyView].map(key => (
                      <Bar
                        key={key}
                        dataKey={key}
                        fill={SOURCE_COLOR[selected.hourlyView] ?? '#3a86ff'}
                        opacity={key.endsWith(':pred') ? 0.45 : 0.85}
                        radius={[2, 2, 0, 0]}
                      />
                    ))}
                  </BarChart>
                )}
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
