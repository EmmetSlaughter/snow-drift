'use client';

import { useCallback, useMemo, useState } from 'react';
import Map, { Source, Layer, Popup } from 'react-map-gl/maplibre';
import type { CircleLayer, MapLayerMouseEvent } from 'react-map-gl/maplibre';
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
  storms: Storm[] | null;       // null = loading
  selectedStormId: number | null;
  drift: DriftSeries[] | null;  // null = not yet loaded
  driftLoading: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SOURCE_COLOR: Record<string, string> = {
  'open-meteo': '#f97316',
  'nws':        '#3b82f6',
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
    return <p className="text-xs text-slate-400 mt-2">No drift history yet — check back after a few more hourly polls.</p>;
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
      <p className="text-xs text-slate-400 mb-1 font-semibold uppercase tracking-wide">
        Forecast drift
      </p>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="t" tickFormatter={fmtTick} tick={{ fontSize: 9, fill: '#64748b' }} minTickGap={60} />
          <YAxis unit='″' tick={{ fontSize: 9, fill: '#64748b' }} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 4, fontSize: 11 }}
            labelFormatter={fmtTick}
            formatter={(v: number, name: string) => [`${v.toFixed(1)}″`, name]}
          />
          {drift.map(s => (
            <Line
              key={s.source}
              type="monotone"
              dataKey={s.source}
              stroke={SOURCE_COLOR[s.source] ?? '#8884d8'}
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

interface SnowMapProps {
  points: SnowPoint[];
  windowStart: string;
  windowEnd: string;
  fetchedAt: string | null;
}

export function SnowMap({ points, windowStart, windowEnd, fetchedAt }: SnowMapProps) {
  const mapTilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? '';
  const [popup, setPopup] = useState<PopupState | null>(null);

  const geojson = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: points.map(p => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      properties: { locationId: p.locationId, snowIn: p.snowIn },
    })),
  }), [points]);

  const circleLayer: CircleLayer = {
    id: 'snow-circles',
    type: 'circle',
    source: 'snow',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4, 6, 8, 9, 14],
      'circle-color': [
        'interpolate', ['linear'], ['get', 'snowIn'],
         0.1, '#bfdbfe',
         1,   '#60a5fa',
         3,   '#2563eb',
         6,   '#1e3a8a',
        12,   '#4c1d95',
        24,   '#7e22ce',
      ],
      'circle-opacity': 0.85,
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(0,0,0,0.25)',
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
      // Derive the latest forecast value from the most-recent fetched point across all sources.
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
        // Auto-select if there's exactly one storm, or the soonest upcoming one.
        if (storms.length > 0) {
          const selected = storms[storms.length - 1]; // last = most recent window
          updated.selectedStormId = selected.id;
          return updated;
        }
        return updated;
      });

      // Kick off drift fetch for the auto-selected storm.
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
      <Map
        initialViewState={{ longitude: -96, latitude: 38.5, zoom: 3.8 }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={`https://api.maptiler.com/maps/dataviz-dark/style.json?key=${mapTilerKey}`}
        interactiveLayerIds={['snow-circles']}
        onClick={onClick}
        cursor="auto"
      >
        <Source id="snow" type="geojson" data={geojson}>
          <Layer {...circleLayer} />
        </Source>

        {popup && (
          <Popup
            longitude={popup.lon}
            latitude={popup.lat}
            anchor="bottom"
            onClose={() => setPopup(null)}
            closeOnClick={false}
            maxWidth="300px"
            className="snow-popup"
          >
            <div className="bg-slate-800 text-slate-100 rounded-lg p-3 text-sm min-w-[260px]">
              {/* Header */}
              <p className="font-semibold text-white text-base">
                {popup.snowIn.toFixed(1)}″ predicted
              </p>
              <p className="text-xs text-slate-400">
                {popup.lat.toFixed(1)}°N, {Math.abs(popup.lon).toFixed(1)}°W
              </p>

              {/* Storm list */}
              <div className="mt-3">
                {popup.storms === null && (
                  <p className="text-xs text-slate-400 animate-pulse">Loading storms…</p>
                )}
                {popup.storms !== null && popup.storms.length === 0 && (
                  <p className="text-xs text-slate-400">No storms detected yet.</p>
                )}
                {popup.storms !== null && popup.storms.length > 0 && (
                  <>
                    <p className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-1">
                      Detected storms
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {popup.storms.map(storm => (
                        <button
                          key={storm.id}
                          onClick={() => selectStorm(storm.id)}
                          className={`text-xs rounded px-2 py-0.5 transition-colors ${
                            popup.selectedStormId === storm.id
                              ? 'bg-blue-600 text-white'
                              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
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
                <p className="text-xs text-slate-400 mt-3 animate-pulse">Loading drift history…</p>
              )}
              {!popup.driftLoading && popup.drift !== null && (
                <DriftChart drift={popup.drift} />
              )}
            </div>
          </Popup>
        )}
      </Map>

      {/* Legend */}
      <div className="absolute bottom-8 left-4 bg-slate-900/90 backdrop-blur rounded-lg px-3 py-2 text-xs text-slate-300 space-y-1 pointer-events-none">
        <p className="font-semibold text-slate-200 mb-1">Predicted snow</p>
        {[
          ['#bfdbfe', 'Trace – 1″'],
          ['#60a5fa', '1 – 3″'],
          ['#2563eb', '3 – 6″'],
          ['#1e3a8a', '6 – 12″'],
          ['#4c1d95', '12 – 24″'],
          ['#7e22ce', '24″+'],
        ].map(([color, label]) => (
          <div key={label} className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
            {label}
          </div>
        ))}
      </div>

      {fetchedAt && (
        <div className="absolute top-4 right-4 bg-slate-900/90 backdrop-blur rounded px-2 py-1 text-xs text-slate-400">
          Data as of {new Date(fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
        </div>
      )}
    </div>
  );
}
