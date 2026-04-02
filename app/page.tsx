'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';

// MapLibre uses browser-only APIs — load client-side only.
const SnowMap = dynamic(
  () => import('@/components/SnowMap').then(m => m.SnowMap),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-slate-900 text-slate-500 text-sm">
        Loading map…
      </div>
    ),
  },
);

// ── Types ────────────────────────────────────────────────────────────────────

interface SnowPoint { locationId: number; lat: number; lon: number; snowIn: number }

// ── Helpers ──────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

function toDatetimeLocal(d: Date) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [windowStart, setWindowStart] = useState(() => toDatetimeLocal(new Date()));
  const [windowEnd,   setWindowEnd]   = useState(() =>
    toDatetimeLocal(new Date(Date.now() + 48 * 3_600_000)),
  );
  const [points,    setPoints]    = useState<SnowPoint[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [count,     setCount]     = useState(0);

  const loadMapData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const start = new Date(windowStart).toISOString();
      const end   = new Date(windowEnd).toISOString();
      const res   = await fetch(
        `/api/map-data?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setPoints(json.points ?? []);
      setFetchedAt(json.fetchedAt ?? null);
      setCount(json.points?.length ?? 0);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [windowStart, windowEnd]);

  useEffect(() => { loadMapData(); }, []);

  const windowStartIso = new Date(windowStart).toISOString();
  const windowEndIso   = new Date(windowEnd).toISOString();

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className="flex-none flex flex-wrap items-center gap-4 px-4 py-2.5 bg-slate-800 border-b border-slate-700 z-10">
        <div className="mr-2">
          <h1 className="text-sm font-bold text-white leading-none">Snow Drift</h1>
          <p className="text-xs text-slate-400">US snowfall forecast tracker</p>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          From
          <input
            type="datetime-local"
            value={windowStart}
            onChange={e => setWindowStart(e.target.value)}
            className="bg-slate-700 text-slate-100 rounded border border-slate-600 px-2 py-1 text-xs
                       focus:outline-none focus:border-blue-500"
          />
        </label>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          To
          <input
            type="datetime-local"
            value={windowEnd}
            onChange={e => setWindowEnd(e.target.value)}
            className="bg-slate-700 text-slate-100 rounded border border-slate-600 px-2 py-1 text-xs
                       focus:outline-none focus:border-blue-500"
          />
        </label>

        <button
          onClick={loadMapData}
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded px-3 py-1
                     text-xs font-medium transition-colors"
        >
          {loading ? 'Loading…' : 'Update'}
        </button>

        <span className="ml-auto text-xs text-slate-500">
          {loading ? '' : error ? `Error: ${error}` : count === 0
            ? 'No snow predicted in window'
            : `${count} snowy grid point${count !== 1 ? 's' : ''} · click any to see drift`}
        </span>
      </header>

      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <main className="flex-1 relative">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-red-900/40 text-red-300 rounded-lg px-4 py-3 text-sm max-w-md text-center">
              <p className="font-semibold mb-1">Failed to load map data</p>
              <p>{error}</p>
            </div>
          </div>
        ) : (
          <SnowMap
            points={points}
            windowStart={windowStartIso}
            windowEnd={windowEndIso}
            fetchedAt={fetchedAt}
          />
        )}
      </main>
    </div>
  );
}
