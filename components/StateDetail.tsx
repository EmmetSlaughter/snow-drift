'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
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

  if (!detail) return <div className="text-center py-10 text-[#7eaed4]">State not found</div>;

  // Add some padding to the viewBox
  const vb = `${detail.svgMinX} ${detail.svgMinY} ${detail.svgWidth} ${detail.svgHeight}`;

  // Scale dot radius relative to the viewBox so they look good at any state size.
  const dotR = Math.max(2, Math.min(detail.svgWidth, detail.svgHeight) * 0.012);

  return (
    <div className="flex h-full bg-[#dbeefe]">
      {/* Map area */}
      <div className="flex-1 relative">
        <svg viewBox={vb} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="state-shadow-detail" x="-3%" y="-2%" width="106%" height="108%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#4a7eaa" floodOpacity="0.15" />
            </filter>
          </defs>

          {/* State shape */}
          <path
            d={detail.path}
            fill="#ffffff"
            stroke="#d0dcea"
            strokeWidth={0.5}
            strokeLinejoin="round"
            filter="url(#state-shadow-detail)"
          />

          {/* Snow dots */}
          {projected.map(pt => {
            const isSelected = selected?.locationId === pt.locationId;
            return (
              <circle
                key={pt.locationId}
                cx={pt.svgX}
                cy={pt.svgY}
                r={isSelected ? dotR * 1.5 : dotR}
                fill={isSelected ? '#f76707' : '#3a86ff'}
                fillOpacity={isSelected ? 1 : 0.7}
                stroke="#ffffff"
                strokeWidth={isSelected ? 1.5 : 0.5}
                className="cursor-pointer"
                style={{ transition: 'r 0.15s ease, fill 0.15s ease' }}
                onClick={() => fetchStorms(pt)}
              />
            );
          })}

          {/* Snow amount labels on dots */}
          {projected.filter(p => p.snowIn >= 1).map(pt => (
            <text
              key={`lbl-${pt.locationId}`}
              x={pt.svgX}
              y={pt.svgY - dotR - 2}
              textAnchor="middle"
              fontSize={dotR * 1.8}
              fontWeight={700}
              fill="#3a86ff"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              {pt.snowIn.toFixed(0)}″
            </text>
          ))}
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
