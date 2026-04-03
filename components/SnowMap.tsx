'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Map, { Source, Layer, Popup } from 'react-map-gl/maplibre';
import type { CircleLayer, HeatmapLayer, MapLayerMouseEvent } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
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
  driftLoading: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SOURCE_COLOR: Record<string, string> = {
  'open-meteo': '#f76707',
  'nws':        '#12b886',
};

const SOURCE_LABEL: Record<string, string> = {
  'open-meteo': 'Open-Meteo',
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

// ── Main component ───────────────────────────────────────────────────────────

interface SnowMapProps {
  points: SnowPoint[];
  fetchedAt: string | null;
}

export function SnowMap({ points, fetchedAt }: SnowMapProps) {
  const mapTilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';
  const [popup, setPopup] = useState<PopupState | null>(null);

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
          // Water → warm pale gray
          if (id.includes('water') && layer.paint['fill-color']) {
            layer.paint['fill-color'] = '#e8e4dd';
          }
          // Background layer
          if (layer.type === 'background' && layer.paint['background-color']) {
            layer.paint['background-color'] = '#faf7f2';
          }
          // Land / landcover / earth fills → warm off-white
          if (layer.type === 'fill' && (id.includes('land') || id.includes('earth') || id.includes('park'))) {
            if (layer.paint['fill-color']) {
              layer.paint['fill-color'] = '#faf7f2';
            }
          }
        }
        setMapStyle(style);
      })
      .catch(() => {
        // Fallback to raw URL if fetch fails
        setMapStyle(`https://api.maptiler.com/maps/dataviz-light/style.json?key=${mapTilerKey}`);
      });
  }, [mapTilerKey]);

  const geojson = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: points.map(p => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      properties: { locationId: p.locationId, snowIn: p.snowIn },
    })),
  }), [points]);

  // Heatmap: the primary visualization — continuous weather-map field.
  const heatmapLayer: HeatmapLayer = {
    id: 'snow-heat',
    type: 'heatmap',
    source: 'snow',
    paint: {
      'heatmap-weight': [
        'interpolate', ['linear'], ['get', 'snowIn'],
        0, 0,
        3, 0.4,
        6, 0.6,
        12, 0.8,
        24, 1,
      ],
      'heatmap-intensity': [
        'interpolate', ['linear'], ['zoom'],
        3, 1.2,
        6, 2,
        9, 3,
        12, 4,
      ],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0,    'rgba(0,0,0,0)',
        0.1,  'rgba(165,216,255,0.4)',
        0.25, 'rgba(116,192,252,0.6)',
        0.4,  'rgba(77,171,247,0.7)',
        0.6,  'rgba(59,130,246,0.8)',
        0.8,  'rgba(103,65,217,0.85)',
        1.0,  'rgba(156,54,181,0.9)',
      ],
      'heatmap-radius': [
        'interpolate', ['linear'], ['zoom'],
        3, 25,
        5, 40,
        7, 60,
        9, 80,
        11, 100,
      ],
      'heatmap-opacity': 0.9,
    },
  };

  // Circles: invisible click targets only — the heatmap is the visual layer.
  const circleLayer: CircleLayer = {
    id: 'snow-circles',
    type: 'circle',
    source: 'snow',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 8, 6, 12, 9, 20],
      'circle-color': 'transparent',
      'circle-opacity': 0,
      'circle-stroke-width': 0,
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
      let latestSnowIn: number | undefined;
      if (series.length > 0) {
        const allPoints = series.flatMap(s => s.points);
        if (allPoints.length > 0) {
          const latest = allPoints.reduce((a, b) => a.fetchedAt > b.fetchedAt ? a : b);
          latestSnowIn = latest.snowIn;
        }
      }
      setPopup(prev => {
        if (prev?.locationId !== locationId) return prev;
        return {
          ...prev,
          drift: series,
          driftLoading: false,
          ...(latestSnowIn !== undefined && { snowIn: latestSnowIn }),
        };
      });
    } catch {
      setPopup(prev => prev?.locationId === locationId
        ? { ...prev, drift: [], driftLoading: false }
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

  const onClick = useCallback((e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f || f.geometry.type !== 'Point') return;
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const { locationId, snowIn } = f.properties as { locationId: number; snowIn: number };
    setPopup({ lat, lon, locationId, snowIn, storms: null, selectedStormId: null, drift: null, driftLoading: false });
    fetchStormsForLocation(locationId);
  }, [fetchStormsForLocation]);

  const selectStorm = useCallback((stormId: number) => {
    setPopup(prev => {
      if (!prev) return prev;
      return { ...prev, selectedStormId: stormId, drift: null, driftLoading: true };
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
        initialViewState={{ longitude: -96, latitude: 38.5, zoom: 3.8 }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={mapStyle}
        interactiveLayerIds={['snow-circles']}
        onClick={onClick}
        cursor="auto"
      >
        <Source id="snow" type="geojson" data={geojson}>
          <Layer {...heatmapLayer} />
          <Layer {...circleLayer} />
        </Source>

        {popup && (
          <Popup
            longitude={popup.lon}
            latitude={popup.lat}
            anchor="bottom"
            onClose={() => setPopup(null)}
            closeOnClick={false}
            maxWidth="320px"
            className="snow-popup"
          >
            <div className="bg-[#fffdf9] text-[#4a4539] rounded-[20px] p-5 text-sm min-w-[280px]">

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

              {/* Drift chart */}
              {popup.driftLoading && (
                <p className="text-xs text-[#bbb5a8] mt-3 animate-pulse">Loading drift…</p>
              )}
              {!popup.driftLoading && popup.drift !== null && (
                <DriftChart drift={popup.drift} />
              )}
            </div>
          </Popup>
        )}
      </Map>}

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
        <div className="absolute top-4 right-4 bg-[#fffdf9]/90 backdrop-blur rounded-xl px-3 py-2 text-xs text-[#bbb5a8] shadow-sm border border-[#ece6da]">
          {new Date(fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
        </div>
      )}
    </div>
  );
}
