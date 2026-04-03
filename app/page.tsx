'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';

// MapLibre uses browser-only APIs — load client-side only.
const SnowMap = dynamic(
  () => import('@/components/SnowMap').then(m => m.SnowMap),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-slate-100 text-slate-400 text-sm">
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
    <div className="flex flex-col h-screen bg-slate-100 text-slate-900">

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className="flex-none flex flex-wrap items-center gap-3 px-5 py-3 bg-white border-b border-slate-200 shadow-sm z-10">
        <div className="mr-3">
          <h1 className="text-lg font-black tracking-tight text-slate-900 leading-none">
            Snow<span className="text-blue-500">Drift</span>
          </h1>
          <p className="text-[11px] text-slate-400 mt-0.5">US snowfall forecast tracker</p>
        </div>

        <div className="w-px h-6 bg-slate-200 hidden sm:block" />

        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          From
          <input
            type="datetime-local"
            value={windowStart}
            onChange={e => setWindowStart(e.target.value)}
            className="bg-slate-50 text-slate-800 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs
                       focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </label>

        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          To
          <input
            type="datetime-local"
            value={windowEnd}
            onChange={e => setWindowEnd(e.target.value)}
            className="bg-slate-50 text-slate-800 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs
                       focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </label>

        <button
          onClick={loadMapData}
          disabled={loading}
          className="bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white rounded-lg px-4 py-1.5
                     text-xs font-bold transition-colors shadow-sm"
        >
          {loading ? 'Loading…' : 'Update'}
        </button>

        <span className="ml-auto text-xs text-slate-400">
          {loading ? '' : error ? `Error: ${error}` : count === 0
            ? 'No snow predicted in window'
            : `${count} snowy point${count !== 1 ? 's' : ''} · click any to see drift`}
        </span>
      </header>

      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <main className="flex-1 relative">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-red-50 text-red-500 rounded-xl px-5 py-4 text-sm max-w-md text-center border border-red-100">
              <p className="font-bold mb-1">Failed to load map data</p>
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
