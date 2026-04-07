'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, Area, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { contours } from 'd3-contour';
import { geoPath } from 'd3-geo';
import detailPaths from '@/lib/state-detail-paths.json';
import citiesData from '@/lib/us-cities.json';
import { albersProject } from '@/lib/albers';
import { STATE_BOUNDS } from '@/lib/state-bounds';

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
  showMarker: boolean;        // only show map marker for search/geolocate, not grid clicks
  placeName: string | null;   // reverse geocoded town name
  storms: Storm[] | null;
  selectedStormId: number | null;
  drift: DriftSeries[] | null;
  hourly: Record<string, string | number>[] | null;
  bloopcast: BloopHour[] | null;
  bloopTotal: number | null;
  confidence: number | null;
  hourlyView: 'bloop' | string;
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

interface GridPoint {
  id: number;
  lat: number;
  lon: number;
}

interface StateDetailProps {
  abbr: string;
  points: SnowPoint[];
  gridPoints: GridPoint[];
  fetchedAt: string | null;
  focusLat?: number;
  focusLon?: number;
}

interface GeoResult { place_name: string; center: [number, number] }

export function StateDetail({ abbr, points, gridPoints, fetchedAt, focusLat, focusLon }: StateDetailProps) {
  const mapTilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';
  const detail = (detailPaths as DetailEntry[]).find(
    s => s.abbr.toLowerCase() === abbr.toLowerCase(),
  );

  const [selected, setSelected] = useState<SelectedPoint | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(null);

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
    const stateCities = (citiesData as { name: string; state: string; pop?: number; lat: number; lon: number }[])
      .filter(c => c.state.toLowerCase() === abbr.toLowerCase())
      .sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0));

    // Show top cities by population, scaled to state size.
    // Larger states get more cities, smaller states get fewer.
    const area = detail.svgWidth * detail.svgHeight;
    const maxCities = Math.min(40, Math.max(8, Math.round(area / 1000)));

    return stateCities.slice(0, maxCities).map(c => {
      const [x, y] = albersProject(c.lon, c.lat);
      return { ...c, svgX: x, svgY: y };
    });
  }, [abbr, detail]);

  // ── Data fetching ─────────────────────────────────────────────────────────

  // Allow overriding the marker position (for clicks at a specific spot vs grid point).
  const fetchStorms = useCallback(async (
    pt: { locationId: number; lat: number; lon: number; snowIn: number; svgX: number; svgY: number; hasSnow?: boolean },
    markerPos?: { svgX: number; svgY: number; lat: number; lon: number },
  ) => {
    const mx = markerPos?.svgX ?? pt.svgX;
    const my = markerPos?.svgY ?? pt.svgY;
    const geoLat = markerPos?.lat ?? pt.lat;
    const geoLon = markerPos?.lon ?? pt.lon;

    setSelected({
      locationId: pt.locationId, lat: pt.lat, lon: pt.lon, snowIn: pt.snowIn,
      svgX: mx, svgY: my, showMarker: true, placeName: null,
      storms: pt.hasSnow === false ? [] : null,
      selectedStormId: null, drift: null, hourly: null,
      bloopcast: null, bloopTotal: null, confidence: null,
      hourlyView: 'bloop', loading: pt.hasSnow !== false,
    });

    // Reverse geocode at the actual click/search location.
    // Try municipality first; if nothing found, widen to county.
    if (mapTilerKey) {
      fetch(`https://api.maptiler.com/geocoding/${geoLon},${geoLat}.json?key=${mapTilerKey}&limit=1&types=municipality,county`)
        .then(r => r.json())
        .then(json => {
          const feat = json.features?.[0];
          let name: string | null = feat?.text ?? null;
          const type: string = feat?.place_type?.[0] ?? '';
          // Maine unorganized townships — fall back to county.
          if (name && /^T\d|^TA? ?R\d|WELS|TWP/i.test(name)) {
            const ctx = feat?.context as { id: string; text: string }[] | undefined;
            const county = ctx?.find((c: { id: string }) => c.id?.startsWith('county'))?.text;
            name = county ? `${county} County` : null;
          }
          // If result is a county, label it as such.
          if (type === 'county' && name && !name.includes('County')) {
            name = `${name} County`;
          }
          setSelected(prev =>
            prev?.locationId === pt.locationId ? { ...prev, placeName: name } : prev,
          );
        })
        .catch(() => {});
    }

    // Skip API calls for points with no snow data.
    if (pt.hasSnow === false) return;
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
      const driftSeries: DriftSeries[] = json.series ?? [];

      // Compute bloopTotal using the same logic as the drift chart's BloopCast line.
      // Build the exact same time-merged dataset, take the last point's value.
      const SW: Record<string, number> = { 'open-meteo': 1.0, 'ecmwf': 0.9, 'nws': 0.8 };
      const timeSet = new Set<string>();
      for (const s of driftSeries) for (const p of s.points) timeSet.add(p.fetchedAt);
      const allTimes = Array.from(timeSet).sort();
      let computedBloopTotal: number | null = null;
      if (allTimes.length > 0) {
        // Compute weighted average at the latest time point.
        const lastT = allTimes[allTimes.length - 1];
        let wSum = 0, wTot = 0;
        for (const s of driftSeries) {
          const pt = s.points.find(p => p.fetchedAt === lastT);
          if (pt) {
            const w = SW[s.source] ?? 0.5;
            wSum += pt.snowIn * w;
            wTot += w;
          }
        }
        computedBloopTotal = wTot > 0 ? Math.round((wSum / wTot) * 100) / 100 : null;
      }

      setSelected(prev => {
        if (prev?.locationId !== locationId) return prev;
        return {
          ...prev,
          drift: driftSeries,
          hourly: json.hourly ?? [],
          bloopcast: json.bloopcast ?? [],
          bloopTotal: computedBloopTotal,
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

  // ── Auto-focus from search/geolocation on the overview ─────────────────────
  const didFocus = useRef(false);
  useEffect(() => {
    if (didFocus.current || !focusLat || !focusLon || projected.length === 0) return;
    didFocus.current = true;
    selectByLatLonRef.current?.(focusLat, focusLon);
  }, [focusLat, focusLon, projected]);

  // ── Search + geolocation ───────────────────────────────────────────────────

  // Ref to projectedGrid so selectByLatLon (defined before projectedGrid) can access it.
  const projectedGridRef = useRef<typeof projectedGrid>([]);

  const selectByLatLon = useCallback((lat: number, lon: number) => {
    const grid = projectedGridRef.current;
    if (!grid.length) return;
    const [clickX, clickY] = albersProject(lon, lat);
    let best = grid[0];
    let bestD = Infinity;
    for (const p of grid) {
      const d = (p.svgX - clickX) ** 2 + (p.svgY - clickY) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    // Place the marker at the searched location, not the grid point.
    if (best) fetchStorms(best, { svgX: clickX, svgY: clickY, lat, lon });
    setQuery('');
    setSearchResults([]);
  }, [fetchStorms]);

  const selectByLatLonRef = useRef(selectByLatLon);
  selectByLatLonRef.current = selectByLatLon;

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.length < 3) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `https://api.maptiler.com/geocoding/${encodeURIComponent(value)}.json?key=${mapTilerKey}&country=us&limit=5`,
        );
        const json = await res.json();
        setSearchResults(
          (json.features ?? []).map((f: { place_name: string; center: [number, number] }) => ({
            place_name: f.place_name,
            center: f.center,
          })),
        );
      } catch { setSearchResults([]); }
      setSearching(false);
    }, 300);
  }, [mapTilerKey]);

  const handleGeolocate = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => selectByLatLon(pos.coords.latitude, pos.coords.longitude),
      () => {},
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [selectByLatLon]);

  // ── Grid points for click targets + contour anchoring ──────────────────────
  const projectedGrid = useMemo(() => {
    const snowMap = new Map(points.map(p => [`${p.lat},${p.lon}`, p]));
    return gridPoints.map(g => {
      const [x, y] = albersProject(g.lon, g.lat);
      const snowPt = snowMap.get(`${g.lat},${g.lon}`);
      return {
        id: g.id, lat: g.lat, lon: g.lon, svgX: x, svgY: y,
        snowIn: snowPt?.snowIn ?? 0,
        locationId: snowPt?.locationId ?? g.id,
        hasSnow: !!snowPt,
      };
    });
  }, [gridPoints, points]);

  projectedGridRef.current = projectedGrid;

  const hitRadius = useMemo(() => {
    if (gridPoints.length < 2) return 5;
    const [x1] = albersProject(gridPoints[0].lon, gridPoints[0].lat);
    const [x2] = albersProject(gridPoints[0].lon + 0.25, gridPoints[0].lat);
    return Math.max(3, Math.abs(x2 - x1) * 0.75);
  }, [gridPoints]);

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

    const pad = 5;
    const x0 = detail.svgMinX - pad;
    const y0 = detail.svgMinY - pad;
    const w = detail.svgWidth + pad * 2;
    const h = detail.svgHeight + pad * 2;

    const cols = Math.min(60, Math.round(w / 3));
    const rows = Math.min(60, Math.round(h / 3));
    const cellW = w / cols;
    const cellH = h / rows;

    // Only use snowy points for IDW. Cells far from any snowy point
    // get zeroed out after interpolation to prevent global bleed.
    const ptX = projected.map(p => p.svgX);
    const ptY = projected.map(p => p.svgY);
    const ptV = projected.map(p => p.snowIn);
    const n = ptX.length;

    // Max distance from nearest snowy point before forcing to zero.
    // ~1.5 grid steps — tight enough to prevent bleed into non-snowy areas.
    const fadeDist2 = (hitRadius * 2.5) ** 2;
    const cutoff2 = (Math.max(w, h) * 0.3) ** 2;
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
        if (weightSum > 0) {
          let val = valSum / weightSum;
          // Find distance to nearest snowy point — fade to zero beyond fadeDist.
          let nearestD2 = Infinity;
          for (let k = 0; k < n; k++) {
            const d2 = (gx - ptX[k]) ** 2 + (gy - ptY[k]) ** 2;
            if (d2 < nearestD2) nearestD2 = d2;
          }
          if (nearestD2 > fadeDist2) {
            val = 0;
          } else if (nearestD2 > fadeDist2 * 0.25) {
            // Smooth fade starting at 25% of fade distance.
            const t = (nearestD2 - fadeDist2 * 0.25) / (fadeDist2 * 0.75);
            val *= (1 - t);
          }
          values[j * cols + i] = val;
        }
      }
    }

    const contourGen = contours()
      .size([cols, rows])
      .thresholds(THRESHOLDS);

    const bands = contourGen(Array.from(values));

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
  }, [detail, projected, projectedGrid]);

  if (!detail) return <div className="text-center py-10 text-[#7eaed4]">State not found</div>;

  const vb = `${detail.svgMinX} ${detail.svgMinY} ${detail.svgWidth} ${detail.svgHeight}`;

  return (
    <div className="flex h-full bg-white">
      {/* Map area */}
      <div className="flex-1 relative">
        <svg
          viewBox={vb}
          className="w-full h-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <filter id="state-shadow-detail" x="-3%" y="-2%" width="106%" height="108%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#4a7eaa" floodOpacity="0.15" />
            </filter>
            {/* Clip contours to state shape */}
            <clipPath id="state-clip">
              <path d={detail.path} />
            </clipPath>
            {/* Snowflake marker for selected snowy points — white with dark outline for contrast */}
            <symbol id="flake-marker" viewBox="0 -960 960 960">
              <path
                fill="white"
                stroke="#1e3a8a"
                strokeWidth="40"
                strokeLinejoin="round"
                paintOrder="stroke fill"
                d="M450-80v-95l-73 62-39-46 112-94v-175l-151 87-26 145-59-11 17-94-82 47-30-52 82-47-90-33 20-56 138 49 150-87-150-86-138 49-20-56 90-33-82-48 30-52 82 48-17-94 59-11 26 145 151 87v-175l-112-94 39-46 73 62v-96h60v96l72-62 39 46-111 94v175l150-87 26-145 59 11-17 94 82-47 30 53-82 46 90 33-20 56-138-49-150 86 150 87 138-49 20 56-90 33 83 47-30 52-83-47 17 94-59 11-26-145-150-87v175l111 94-39 46-72-62v95h-60Z"
              />
            </symbol>
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
            // Target fixed screen-pixel sizes by estimating the SVG→screen scale.
            // The SVG uses preserveAspectRatio=meet, so the limiting dimension
            // determines how many screen pixels each SVG unit gets.
            // We target ~11px screen font and ~4px screen dot radius.
            const pxPerUnit = Math.min(900 / detail.svgWidth, 700 / detail.svgHeight);
            const baseR = 4 / pxPerUnit;
            const baseFontSize = 11 / pxPerUnit;
            const charW = baseFontSize * 0.55;
            const placed: { x: number; y: number; w: number; h: number }[] = [];

            return cities.map(city => {
              const isCap = (city as { capital?: boolean }).capital;
              const pop = (city as { pop?: number }).pop ?? 0;
              // Scale: capitals and big cities get bigger markers/text.
              const sizeScale = isCap ? 1.3 : pop > 500000 ? 1.2 : pop > 100000 ? 1.1 : 1;
              const r = baseR * sizeScale;
              const fontSize = baseFontSize * sizeScale;
              const markerW = isCap ? r * 3 : r * 2;

              const lx = city.svgX + markerW / 2 + 1;
              const ly = city.svgY;
              const lw = city.name.length * charW * sizeScale;
              const lh = fontSize * 1.3;

              const overlaps = placed.some(p =>
                lx < p.x + p.w && lx + lw > p.x &&
                ly - lh / 2 < p.y + p.h / 2 && ly + lh / 2 > p.y - p.h / 2
              );
              if (overlaps) return null;
              placed.push({ x: lx, y: ly, w: lw, h: lh });

              return (
                <g key={`${city.name}-${city.state}`} style={{ pointerEvents: 'none' }}>
                  {isCap ? (
                    // Star marker for capitals
                    <polygon
                      points={Array.from({ length: 10 }, (_, i) => {
                        const a = (i * 36 - 90) * Math.PI / 180;
                        const ra = i % 2 === 0 ? r * 1.4 : r * 0.6;
                        return `${city.svgX + Math.cos(a) * ra},${city.svgY + Math.sin(a) * ra}`;
                      }).join(' ')}
                      fill="#4a4539"
                      fillOpacity={0.65}
                    />
                  ) : (
                    <circle
                      cx={city.svgX}
                      cy={city.svgY}
                      r={r}
                      fill="#4a4539"
                      fillOpacity={pop > 100000 ? 0.55 : 0.4}
                    />
                  )}
                  <text
                    x={lx}
                    y={ly}
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fontWeight={isCap ? 800 : pop > 100000 ? 700 : 600}
                    fill="#4a4539"
                    fillOpacity={isCap ? 0.7 : pop > 100000 ? 0.6 : 0.45}
                    style={{ userSelect: 'none' }}
                  >
                    {city.name}
                  </text>
                </g>
              );
            });
          })()}

          {/* Selected point marker */}
          {selected && (() => {
            // Same pixel-targeting as city labels.
            const pxPerUnit = Math.min(900 / detail.svgWidth, 700 / detail.svgHeight);
            const markerR = 14 / pxPerUnit;
            const fontSize = 13 / pxPerUnit;
            const snowAmt = selected.bloopTotal ?? selected.snowIn;
            const hasSnow = snowAmt > 0;
            const isTrace = hasSnow && snowAmt < 0.1;

            // Label text
            const label = !hasSnow
              ? 'No snow'
              : isTrace
                ? 'Trace'
                : `${snowAmt.toFixed(1)}″`;

            return (
              <g style={{ pointerEvents: 'none' }}>
                {hasSnow ? (
                  <use
                    href="#flake-marker"
                    x={selected.svgX - markerR}
                    y={selected.svgY - markerR}
                    width={markerR * 2}
                    height={markerR * 2}
                  />
                ) : (
                  <circle
                    cx={selected.svgX}
                    cy={selected.svgY}
                    r={markerR * 0.7}
                    fill="#f59f00"
                    stroke="#ffffff"
                    strokeWidth={markerR * 0.2}
                  />
                )}
                <text
                  x={selected.svgX}
                  y={selected.svgY - markerR - fontSize * 0.2}
                  textAnchor="middle"
                  fontSize={fontSize}
                  fontWeight={800}
                  fill={hasSnow ? '#1e3a8a' : '#f59f00'}
                >
                  {label}
                </text>
              </g>
            );
          })()}

          {/* Click targets — topmost layer so they catch all clicks */}
          {/* Click targets for every grid point */}
          {projectedGrid.map(gt => (
            <circle
              key={`hit-${gt.id}`}
              cx={gt.svgX}
              cy={gt.svgY}
              r={hitRadius}
              fill="rgba(0,0,0,0)"
              style={{ cursor: 'pointer', pointerEvents: 'all' }}
              onClick={(e) => {
                // Get click position in SVG space using the circle's known position
                // as a reference. The circle's bbox tells us where it actually rendered.
                const circle = e.currentTarget;
                const bbox = circle.getBoundingClientRect();
                const circleCenterScreenX = bbox.left + bbox.width / 2;
                const circleCenterScreenY = bbox.top + bbox.height / 2;
                // Offset from circle center in screen pixels.
                const offsetScreenX = e.clientX - circleCenterScreenX;
                const offsetScreenY = e.clientY - circleCenterScreenY;
                // Convert screen offset to SVG offset using the circle's known radius.
                // bbox.width/2 in screen px = hitRadius in SVG units.
                const screenToSvg = hitRadius / (bbox.width / 2);
                const clickSvgX = gt.svgX + offsetScreenX * screenToSvg;
                const clickSvgY = gt.svgY + offsetScreenY * screenToSvg;
                // Reverse: approximate lat/lon from the SVG offset.
                // This is rough but good enough for reverse geocoding municipality level.
                const latPerSvgY = -0.25 / ((albersProject(gt.lon, gt.lat)[1] - albersProject(gt.lon, gt.lat + 0.25)[1]) || 1);
                const lonPerSvgX = 0.25 / ((albersProject(gt.lon + 0.25, gt.lat)[0] - albersProject(gt.lon, gt.lat)[0]) || 1);
                const clickLat = gt.lat + (clickSvgY - gt.svgY) * latPerSvgY;
                const clickLon = gt.lon + (clickSvgX - gt.svgX) * lonPerSvgX;
                fetchStorms(gt, { svgX: clickSvgX, svgY: clickSvgY, lat: clickLat, lon: clickLon });
              }}
            />
          ))}
        </svg>

        {/* Search bar */}
        <div className="absolute top-4 left-4 w-64">
          <div className="relative flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                value={query}
                onChange={e => handleSearch(e.target.value)}
                placeholder="Search a location…"
                className="w-full bg-white/80 backdrop-blur-sm text-[#4a4539] placeholder-[#b0bcc8]
                           rounded-full px-4 py-2 text-xs focus:outline-none focus:ring-2
                           focus:ring-[#3a86ff]/30 border border-[#d0dcea] shadow-sm"
              />
              {searching && (
                <span className="absolute right-3 top-2.5 text-[#b0bcc8] text-[10px] animate-pulse">…</span>
              )}
            </div>
            <button
              onClick={handleGeolocate}
              title="Use my location"
              className="flex-none w-9 h-9 flex items-center justify-center bg-white/80
                         backdrop-blur-sm rounded-full border border-[#d0dcea] text-[#7eaed4]
                         hover:bg-white hover:text-[#4a4539] transition-colors shadow-sm"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4" />
                <line x1="12" y1="2" x2="12" y2="6" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="2" y1="12" x2="6" y2="12" />
                <line x1="18" y1="12" x2="22" y2="12" />
              </svg>
            </button>
          </div>

          {/* Search results dropdown */}
          {searchResults.length > 0 && (
            <div className="mt-1 bg-white/95 backdrop-blur-md rounded-xl border border-[#d0dcea] shadow-md overflow-hidden">
              {searchResults.map((r, i) => (
                <button
                  key={i}
                  onClick={() => selectByLatLon(r.center[1], r.center[0])}
                  className="w-full text-left px-3 py-2 text-xs text-[#4a4539] hover:bg-[#e8f4ff]
                             border-b border-[#e8f4ff] last:border-0 transition-colors"
                >
                  {r.place_name}
                </button>
              ))}
            </div>
          )}
        </div>

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

          {/* Hero — BloopCast total, computed from drift data to match the chart */}
          {(() => {
            // Compute from drift series — same logic as the BloopCast drift line.
            let amt = selected.snowIn;
            if (selected.drift && selected.drift.length > 0) {
              const SW: Record<string, number> = { 'open-meteo': 1.0, 'ecmwf': 0.9, 'nws': 0.8 };
              const timeSet = new Set<string>();
              for (const s of selected.drift) for (const p of s.points) timeSet.add(p.fetchedAt);
              const sorted = Array.from(timeSet).sort();
              if (sorted.length > 0) {
                const lastT = sorted[sorted.length - 1];
                let wS = 0, wT = 0;
                for (const s of selected.drift) {
                  const pt = s.points.find(p => p.fetchedAt === lastT);
                  if (pt) { const w = SW[s.source] ?? 0.5; wS += pt.snowIn * w; wT += w; }
                }
                if (wT > 0) amt = Math.round((wS / wT) * 100) / 100;
              }
            }
            const noSnow = amt === 0 || amt === null;
            const trace = !noSnow && amt < 0.1;
            return (
              <div className="flex items-baseline gap-1.5 mb-1">
                {noSnow ? (
                  <span className="text-2xl font-black text-[#f59f00] leading-none">No snow</span>
                ) : trace ? (
                  <span className="text-2xl font-black text-[#3a86ff] leading-none">Trace</span>
                ) : (
                  <>
                    <span className="text-4xl font-black text-[#3a86ff] leading-none tabular-nums">
                      {amt.toFixed(1)}
                    </span>
                    <span className="text-xl font-bold text-[#a5d8ff] leading-none">″</span>
                  </>
                )}
              </div>
            );
          })()}
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
          {selected.placeName ? (
            <p className="text-[13px] text-[#4a4539] font-bold mb-0.5">{selected.placeName}</p>
          ) : (
            <p className="text-[11px] text-[#7eaed4] mb-0.5">
              {selected.lat.toFixed(2)}°N · {Math.abs(selected.lon).toFixed(2)}°W
            </p>
          )}
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
                  (() => {
                    const src = selected.hourlyView;
                    // Flatten hourly data into one bar per timestamp for this source.
                    // Merge :est and :pred into a single value per hour.
                    const srcData = (selected.hourly ?? [])
                      .filter(h => h[src] !== undefined || h[`${src}:est`] !== undefined || h[`${src}:pred`] !== undefined)
                      .map(h => ({
                        t: h.t,
                        snowIn: (h[`${src}:est`] ?? h[`${src}:pred`] ?? h[src] ?? 0) as number,
                        kind: h.kind ?? (h[`${src}:est`] !== undefined ? 'estimated' : 'predicted'),
                      }));

                    return (
                      <BarChart data={srcData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
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
                          formatter={(v: number) => [
                            `${v.toFixed(2)}″`,
                            SOURCE_LABEL[src] ?? src,
                          ]}
                        />
                        <Bar
                          dataKey="snowIn"
                          fill={SOURCE_COLOR[src] ?? '#3a86ff'}
                          opacity={0.85}
                          radius={[2, 2, 0, 0]}
                        />
                      </BarChart>
                    );
                  })()
                )}
              </ResponsiveContainer>
            </div>
          )}

          {/* Drift chart — shares toggle with hourly */}
          {!selected.loading && selected.drift && selected.drift.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] text-[#7eaed4] mb-1 font-bold uppercase tracking-widest">
                Forecast drift
              </p>
              <ResponsiveContainer width="100%" height={120}>
                {selected.hourlyView === 'bloop' ? (
                  // BloopCast drift: weighted average line + confidence band (min/max range).
                  (() => {
                    const timeSet = new Set<string>();
                    for (const s of selected.drift!) for (const p of s.points) timeSet.add(p.fetchedAt);
                    const allTimes = Array.from(timeSet).sort();

                    const SOURCE_W: Record<string, number> = { 'open-meteo': 1.0, 'ecmwf': 0.9, 'nws': 0.8 };

                    const driftData = allTimes.map(t => {
                      const vals: number[] = [];
                      let wSum = 0, vSum = 0;
                      for (const s of selected.drift!) {
                        const pt = s.points.find(p => p.fetchedAt === t);
                        if (pt) {
                          const w = SOURCE_W[s.source] ?? 0.5;
                          wSum += w;
                          vSum += pt.snowIn * w;
                          vals.push(pt.snowIn);
                        }
                      }
                      const avg = wSum > 0 ? vSum / wSum : 0;
                      const lo = vals.length > 0 ? Math.min(...vals) : avg;
                      const hi = vals.length > 0 ? Math.max(...vals) : avg;
                      return { t, bloop: Math.round(avg * 100) / 100, range: [lo, hi] as [number, number] };
                    });

                    return (
                      <ComposedChart data={driftData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e8f4ff" />
                        <XAxis dataKey="t" tickFormatter={fmtTick} tick={{ fontSize: 9, fill: '#7eaed4' }} minTickGap={60} />
                        <YAxis unit='″' tick={{ fontSize: 9, fill: '#7eaed4' }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#fff', border: '1px solid #d0dcea', borderRadius: 12, fontSize: 11 }}
                          labelFormatter={fmtTick}
                          formatter={(v: unknown, name: string) => {
                            if (name === 'range') {
                              const r = v as [number, number];
                              return [`${r[0].toFixed(1)}–${r[1].toFixed(1)}″`, 'Model range'];
                            }
                            return [`${(v as number).toFixed(1)}″`, 'BloopCast'];
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="range"
                          fill="#3a86ff"
                          fillOpacity={0.12}
                          stroke="none"
                        />
                        <Line
                          type="monotone"
                          dataKey="bloop"
                          stroke="#3a86ff"
                          strokeWidth={2.5}
                          dot={false}
                          connectNulls
                        />
                      </ComposedChart>
                    );
                  })()
                ) : (
                  // Individual source drift
                  (() => {
                    const src = selected.hourlyView;
                    const s = selected.drift!.find(d => d.source === src);
                    if (!s) return <LineChart data={[]} />;
                    const srcData = s.points.map(p => ({ t: p.fetchedAt, snowIn: p.snowIn }));
                    return (
                      <LineChart data={srcData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e8f4ff" />
                        <XAxis dataKey="t" tickFormatter={fmtTick} tick={{ fontSize: 9, fill: '#7eaed4' }} minTickGap={60} />
                        <YAxis unit='″' tick={{ fontSize: 9, fill: '#7eaed4' }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#fff', border: '1px solid #d0dcea', borderRadius: 12, fontSize: 11 }}
                          labelFormatter={fmtTick}
                          formatter={(v: number) => [`${v.toFixed(1)}″`, SOURCE_LABEL[src] ?? src]}
                        />
                        <Line
                          type="monotone"
                          dataKey="snowIn"
                          stroke={SOURCE_COLOR[src] ?? '#3a86ff'}
                          strokeWidth={2.5}
                          dot={false}
                          connectNulls
                        />
                      </LineChart>
                    );
                  })()
                )}
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
