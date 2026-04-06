'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Source, Layer } from 'react-map-gl/maplibre';
import type { FillLayer, MapLayerMouseEvent, MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';

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

interface PopupState {
  lat: number;
  lon: number;
  locationId: number;
  snowIn: number;
  storms: Storm[] | null;
  selectedStormId: number | null;
  drift: DriftSeries[] | null;
  hourly: Record<string, string | number>[] | null;
  driftLoading: boolean;
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
    month: 'short', day: 'numeric',
    hour: 'numeric', hour12: true,
  });
}

// ── Sub-components ───────────────────────────────────────────────────────────

function DriftChart({ drift }: { drift: DriftSeries[] }) {
  if (!drift.length) {
    return <p className="text-xs text-[#bbb5a8] mt-2">No drift history yet — check back after a few polls.</p>;
  }

  const timeSet = new Set<string>();
  for (const s of drift) for (const p of s.points) timeSet.add(p.fetchedAt);
  const allTimes = Array.from(timeSet).sort();

  const data = allTimes.map(t => {
    const entry: Record<string, string | number> = { t };
    for (const s of drift) {
      const pt = s.points.find(p => p.fetchedAt === t);
      if (pt) entry[s.source] = pt.snowIn;
    }
    return entry;
  });

  return (
    <div className="mt-3">
      <p className="text-[10px] text-[#bbb5a8] mb-1 font-bold uppercase tracking-widest">
        Forecast drift
      </p>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ece6da" />
          <XAxis dataKey="t" tickFormatter={fmtTick} tick={{ fontSize: 9, fill: '#bbb5a8' }} minTickGap={60} />
          <YAxis unit='″' tick={{ fontSize: 9, fill: '#bbb5a8' }} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#fffdf9',
              border: '1px solid #ece6da',
              borderRadius: 12,
              fontSize: 11,
              boxShadow: '0 4px 16px rgba(120,100,70,0.1)',
            }}
            labelFormatter={fmtTick}
            formatter={(v: number, name: string) => [
              `${v.toFixed(1)}″`,
              SOURCE_LABEL[name] ?? name,
            ]}
          />
          {drift.map(s => (
            <Line
              key={s.source}
              type="monotone"
              dataKey={s.source}
              stroke={SOURCE_COLOR[s.source] ?? '#8884d8'}
              strokeWidth={2.5}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="flex gap-3 mt-1.5">
        {drift.map(s => (
          <div key={s.source} className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-1 rounded-full" style={{ backgroundColor: SOURCE_COLOR[s.source] ?? '#8884d8' }} />
            <span className="text-[10px] text-[#9e9890]">{SOURCE_LABEL[s.source] ?? s.source}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HourlyChart({ hourly }: { hourly: Record<string, string | number>[] }) {
  if (!hourly.length) {
    return <p className="text-xs text-[#bbb5a8] mt-2">No hourly data available.</p>;
  }

  // Split into estimated (past) and predicted (future) series.
  // Each source gets two bar series: "open-meteo:est" and "open-meteo:pred".
  const sources = new Set<string>();
  for (const entry of hourly) {
    for (const key of Object.keys(entry)) {
      if (key !== 't' && key !== 'kind') sources.add(key);
    }
  }

  const hasEstimated = hourly.some(e => e.kind === 'estimated');
  const hasPredicted = hourly.some(e => e.kind === 'predicted');

  // Flatten into chart-ready data: for each timestamp, set source:est or source:pred keys.
  const chartData = hourly.map(entry => {
    const row: Record<string, string | number> = { t: entry.t };
    const suffix = entry.kind === 'estimated' ? ':est' : ':pred';
    for (const src of sources) {
      if (entry[src] !== undefined) row[src + suffix] = entry[src];
    }
    return row;
  });

  return (
    <div className="mt-3">
      <p className="text-[10px] text-[#bbb5a8] mb-1 font-bold uppercase tracking-widest">
        Snowfall by hour
      </p>
      <ResponsiveContainer width="100%" height={110}>
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ece6da" vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={(iso: string) => {
              const d = new Date(iso);
              return d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
            }}
            tick={{ fontSize: 8, fill: '#bbb5a8' }}
            minTickGap={30}
          />
          <YAxis unit='″' tick={{ fontSize: 9, fill: '#bbb5a8' }} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#fffdf9',
              border: '1px solid #ece6da',
              borderRadius: 12,
              fontSize: 11,
              boxShadow: '0 4px 16px rgba(120,100,70,0.1)',
            }}
            labelFormatter={(iso: string) =>
              new Date(iso).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric',
                hour: 'numeric', hour12: true,
              })
            }
            formatter={(v: number, name: string) => {
              const src = name.replace(/:est$|:pred$/, '');
              const label = SOURCE_LABEL[src] ?? src;
              const suffix = name.endsWith(':est') ? ' (fallen)' : ' (predicted)';
              return [`${v.toFixed(2)}″`, label + suffix];
            }}
          />
          {[...sources].map(src => (
            hasEstimated && <Bar
              key={src + ':est'}
              dataKey={src + ':est'}
              fill={SOURCE_COLOR[src] ?? '#8884d8'}
              opacity={1}
              radius={[2, 2, 0, 0]}
            />
          ))}
          {[...sources].map(src => (
            hasPredicted && <Bar
              key={src + ':pred'}
              dataKey={src + ':pred'}
              fill={SOURCE_COLOR[src] ?? '#8884d8'}
              opacity={0.45}
              radius={[2, 2, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {hasEstimated && hasPredicted && (
        <div className="flex gap-3 mt-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 rounded-sm bg-[#3b82f6]" />
            <span className="text-[10px] text-[#9e9890]">Fallen</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 rounded-sm bg-[#3b82f6] opacity-45" />
            <span className="text-[10px] text-[#9e9890]">Predicted</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

interface SnowMapProps {
  points: SnowPoint[];
  fetchedAt: string | null;
  initialView?: { longitude: number; latitude: number; zoom: number };
}

function findNearest(lat: number, lon: number, pts: SnowPoint[]): SnowPoint | null {
  if (!pts.length) return null;
  let best = pts[0];
  let bestD = Infinity;
  for (const p of pts) {
    const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

interface GeoResult { place_name: string; center: [number, number] }

export function SnowMap({ points, fetchedAt, initialView }: SnowMapProps) {
  const mapTilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';
  const mapRef = useRef<MapRef>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Fetch the base style and patch colors to match our warm palette.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [mapStyle, setMapStyle] = useState<any>(null);
  useEffect(() => {
    fetch(`https://api.maptiler.com/maps/dataviz-light/style.json?key=${mapTilerKey}`)
      .then(r => r.json())
      .then(style => {
        for (const layer of style.layers) {
          if (!layer.paint) continue;
          const id = layer.id.toLowerCase();
          if (id.includes('water') && layer.paint['fill-color']) {
            layer.paint['fill-color'] = '#e8e4dd';
          }
          if (layer.type === 'background' && layer.paint['background-color']) {
            layer.paint['background-color'] = '#faf7f2';
          }
          if (layer.type === 'fill' && (id.includes('land') || id.includes('earth') || id.includes('park'))) {
            if (layer.paint['fill-color']) layer.paint['fill-color'] = '#faf7f2';
          }
        }
        setMapStyle(style);
      })
      .catch(() => {
        setMapStyle(`https://api.maptiler.com/maps/dataviz-light/style.json?key=${mapTilerKey}`);
      });
  }, [mapTilerKey]);

  // Select a point by lat/lon: find nearest, fly to it, load storms.
  const selectByLatLon = useCallback((lat: number, lon: number) => {
    const nearest = findNearest(lat, lon, points);
    if (!nearest) return;
    mapRef.current?.flyTo({ center: [nearest.lon, nearest.lat], zoom: 7, duration: 1200 });
    setPopup({
      lat: nearest.lat, lon: nearest.lon, locationId: nearest.locationId,
      snowIn: nearest.snowIn, storms: null, selectedStormId: null,
      drift: null, hourly: null, driftLoading: false,
    });
    setResults([]);
    setQuery('');
    // fetchStormsForLocation will be called after it's defined — use a ref trick
    queueMicrotask(() => fetchStormsRef.current?.(nearest.locationId));
  }, [points]);

  // Geocoding search via MapTiler
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.length < 3) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `https://api.maptiler.com/geocoding/${encodeURIComponent(value)}.json?key=${mapTilerKey}&country=us&limit=5`,
        );
        const json = await res.json();
        setResults(
          (json.features ?? []).map((f: { place_name: string; center: [number, number] }) => ({
            place_name: f.place_name,
            center: f.center,
          })),
        );
      } catch { setResults([]); }
      setSearching(false);
    }, 300);
  }, [mapTilerKey]);

  // Browser geolocation
  const handleGeolocate = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => selectByLatLon(pos.coords.latitude, pos.coords.longitude),
      () => {},
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [selectByLatLon]);

  const GRID_STEP = 0.5;
  const HALF = GRID_STEP / 2;

  const geojson = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: points.map(p => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [p.lon - HALF, p.lat - HALF],
          [p.lon + HALF, p.lat - HALF],
          [p.lon + HALF, p.lat + HALF],
          [p.lon - HALF, p.lat + HALF],
          [p.lon - HALF, p.lat - HALF],
        ]],
      },
      properties: { locationId: p.locationId, snowIn: p.snowIn, lat: p.lat, lon: p.lon },
    })),
  }), [points]);

  // Filled grid cells with sharp color bands — TV snow forecast style.
  const fillLayer: FillLayer = {
    id: 'snow-fill',
    type: 'fill',
    source: 'snow',
    paint: {
      'fill-color': [
        'step', ['get', 'snowIn'],
        '#bde0fe',      // trace – 1″
        1,  '#74b9ff',  // 1 – 3″
        3,  '#3a86ff',  // 3 – 6″
        6,  '#1e3a8a',  // 6 – 12″
        12, '#6741d9',  // 12 – 24″
        24, '#9c36b5',  // 24″+
      ],
      'fill-opacity': [
        'interpolate', ['linear'], ['get', 'lat'],
        24.5, 0,
        26,   0.8,
        47,   0.8,
        49,   0,
      ],
      'fill-antialias': false,
    },
  };

  const fetchDrift = useCallback(async (locationId: number, stormId: number) => {
    setPopup(prev => prev?.locationId === locationId
      ? { ...prev, driftLoading: true, drift: null }
      : prev,
    );
    try {
      const res    = await fetch(`/api/forecasts?locationId=${locationId}&stormId=${stormId}`);
      const json   = await res.json();
      const series: DriftSeries[] = json.series ?? [];
      const hourly: Record<string, string | number>[] = json.hourly ?? [];
      const estimatedIn: Record<string, number> = json.estimatedIn ?? {};
      const predictedIn: Record<string, number> = json.predictedIn ?? {};

      // Storm total = estimated fallen + predicted remaining (use open-meteo as primary).
      let stormTotal: number | undefined;
      const primarySrc = 'open-meteo';
      const fallen    = estimatedIn[primarySrc] ?? 0;
      const remaining = predictedIn[primarySrc] ?? 0;
      stormTotal = Math.round((fallen + remaining) * 100) / 100;

      setPopup(prev => {
        if (prev?.locationId !== locationId) return prev;
        return {
          ...prev,
          drift: series,
          hourly,
          driftLoading: false,
          ...(stormTotal !== undefined && { snowIn: stormTotal }),
        };
      });
    } catch {
      setPopup(prev => prev?.locationId === locationId
        ? { ...prev, drift: [], hourly: [], driftLoading: false }
        : prev,
      );
    }
  }, []);

  const fetchStormsForLocation = useCallback(async (locationId: number) => {
    try {
      const res  = await fetch(`/api/storms?locationId=${locationId}`);
      const json = await res.json();
      const storms: Storm[] = json.storms ?? [];

      setPopup(prev => {
        if (prev?.locationId !== locationId) return prev;
        const updated = { ...prev, storms };
        if (storms.length > 0) {
          const selected = storms[storms.length - 1];
          updated.selectedStormId = selected.id;
          return updated;
        }
        return updated;
      });

      if (storms.length > 0) {
        fetchDrift(locationId, storms[storms.length - 1].id);
      }
    } catch {
      setPopup(prev => prev?.locationId === locationId
        ? { ...prev, storms: [] }
        : prev,
      );
    }
  }, [fetchDrift]);

  // Ref so selectByLatLon (defined before fetchStormsForLocation) can call it.
  const fetchStormsRef = useRef(fetchStormsForLocation);
  fetchStormsRef.current = fetchStormsForLocation;

  const onClick = useCallback((e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    const { locationId, snowIn, lat, lon } = f.properties as {
      locationId: number; snowIn: number; lat: number; lon: number;
    };
    setPopup({ lat, lon, locationId, snowIn, storms: null, selectedStormId: null, drift: null, hourly: null, driftLoading: false });
    fetchStormsForLocation(locationId);
  }, [fetchStormsForLocation]);

  const selectStorm = useCallback((stormId: number) => {
    setPopup(prev => {
      if (!prev) return prev;
      return { ...prev, selectedStormId: stormId, drift: null, hourly: null, driftLoading: true };
    });
    if (popup) fetchDrift(popup.locationId, stormId);
  }, [popup, fetchDrift]);

  return (
    <div className="relative w-full h-full">
      {!mapStyle ? (
        <div className="w-full h-full flex items-center justify-center bg-[#faf7f2] text-[#bbb5a8] text-sm">
          Loading map…
        </div>
      ) : null}
      {mapStyle && <Map
        ref={mapRef}
        initialViewState={initialView ?? { longitude: -96, latitude: 38.5, zoom: 3.8 }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={mapStyle}
        interactiveLayerIds={['snow-fill']}
        onClick={onClick}
        cursor="auto"
        minZoom={3.5}
      >
        <Source id="snow" type="geojson" data={geojson}>
          <Layer {...fillLayer} />
        </Source>

      </Map>}

      {/* Sidebar — collapses when empty, expands smoothly when data loads */}
      <div
        className={`absolute top-4 right-4 bg-[#fffdf9]/95 backdrop-blur-md
                    rounded-2xl shadow-lg border border-[#ece6da] text-[#4a4539] text-sm
                    flex flex-col transition-all duration-500 ease-in-out overflow-hidden
                    ${popup ? 'bottom-4 w-80' : 'w-72'}`}
      >
        {/* Search bar */}
        <div className="p-4 pb-2 flex-none">
          <div className="relative flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                value={query}
                onChange={e => handleSearch(e.target.value)}
                placeholder="Search a location…"
                className="w-full bg-[#f1ede8] text-[#4a4539] placeholder-[#bbb5a8] rounded-xl
                           px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#12b886]/30
                           border border-[#ece6da]"
              />
              {searching && (
                <span className="absolute right-2.5 top-2.5 text-[#bbb5a8] text-[10px] animate-pulse">…</span>
              )}
            </div>
            <button
              onClick={handleGeolocate}
              title="Use my location"
              className="flex-none w-9 h-9 flex items-center justify-center bg-[#f1ede8]
                         rounded-xl border border-[#ece6da] text-[#9e9890]
                         hover:bg-[#e8e2da] hover:text-[#4a4539] transition-colors"
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
          {results.length > 0 && (
            <div className="mt-1 bg-[#fffdf9] rounded-xl border border-[#ece6da] shadow-md overflow-hidden">
              {results.map((r, i) => (
                <button
                  key={i}
                  onClick={() => selectByLatLon(r.center[1], r.center[0])}
                  className="w-full text-left px-3 py-2 text-xs text-[#4a4539] hover:bg-[#f1ede8]
                             border-b border-[#ece6da] last:border-0 transition-colors"
                >
                  {r.place_name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content area */}
        <div className={`overflow-y-auto px-5 pb-5 ${popup ? 'flex-1' : ''}`}>
          {!popup ? (
            <div className="text-center py-2">
              <p className="text-[#bbb5a8] text-xs">
                Search or click the map to explore
              </p>
            </div>
          ) : (
            <>
              {/* Close / back */}
              <button
                onClick={() => setPopup(null)}
                className="text-[10px] text-[#bbb5a8] hover:text-[#7a7568] mb-3 transition-colors"
              >
                ← back to overview
              </button>

              {/* Hero number */}
              <div className="flex items-baseline gap-1.5 mb-1">
                <span className="text-5xl font-black text-[#3b82f6] leading-none tabular-nums">
                  {popup.snowIn.toFixed(1)}
                </span>
                <span className="text-2xl font-bold text-[#a5d8ff] leading-none">″</span>
              </div>
              <p className="text-[11px] text-[#bbb5a8] mb-4">
                {popup.lat.toFixed(2)}°N · {Math.abs(popup.lon).toFixed(2)}°W
              </p>

              {/* Storm list */}
              <div>
                {popup.storms === null && (
                  <p className="text-xs text-[#bbb5a8] animate-pulse">Looking for storms…</p>
                )}
                {popup.storms !== null && popup.storms.length === 0 && (
                  <p className="text-xs text-[#bbb5a8]">No storms detected yet.</p>
                )}
                {popup.storms !== null && popup.storms.length > 0 && (
                  <>
                    <p className="text-[10px] text-[#bbb5a8] font-bold uppercase tracking-widest mb-2">
                      Storms
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {popup.storms.map(storm => (
                        <button
                          key={storm.id}
                          onClick={() => selectStorm(storm.id)}
                          className={`text-xs font-bold rounded-full px-3.5 py-1.5 transition-all ${
                            popup.selectedStormId === storm.id
                              ? 'bg-[#12b886] text-white shadow-sm'
                              : 'bg-[#f1ede8] text-[#9e9890] hover:bg-[#e8e2da]'
                          }`}
                        >
                          {fmtStormLabel(storm)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Charts */}
              {popup.driftLoading && (
                <p className="text-xs text-[#bbb5a8] mt-3 animate-pulse">Loading drift…</p>
              )}
              {!popup.driftLoading && popup.hourly !== null && (
                <HourlyChart hourly={popup.hourly} />
              )}
              {!popup.driftLoading && popup.drift !== null && (
                <DriftChart drift={popup.drift} />
              )}
            </>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-8 left-4 bg-[#fffdf9]/90 backdrop-blur rounded-2xl px-4 py-3 pointer-events-none shadow-md border border-[#ece6da]">
        <p className="font-bold text-[#4a4539] mb-2 text-[11px] uppercase tracking-widest">Snow</p>
        <div
          className="h-3 w-36 rounded-full"
          style={{ background: 'linear-gradient(to right, #a5d8ff, #74c0fc, #4dabf7, #3b82f6, #6741d9, #9c36b5)' }}
        />
        <div className="flex justify-between mt-1 text-[10px] text-[#9e9890]">
          <span>Trace</span>
          <span>6″</span>
          <span>24″+</span>
        </div>
      </div>

      {fetchedAt && (
        <div className="absolute bottom-8 left-44 bg-[#fffdf9]/90 backdrop-blur rounded-xl px-3 py-2 text-xs text-[#bbb5a8] shadow-sm border border-[#ece6da] pointer-events-none">
          {new Date(fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
        </div>
      )}
    </div>
  );
}
