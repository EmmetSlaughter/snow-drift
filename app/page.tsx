'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';

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

interface SnowPoint { locationId: number; lat: number; lon: number; snowIn: number }

export default function HomePage() {
  const [points,    setPoints]    = useState<SnowPoint[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [count,     setCount]     = useState(0);

  const loadMapData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/map-data');
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
  }, []);

  useEffect(() => { loadMapData(); }, []);

  return (
    <div className="flex flex-col h-screen bg-slate-100 text-slate-900">

      <header className="flex-none flex items-center gap-3 px-5 py-3 bg-white border-b border-slate-200 shadow-sm z-10">
        <div className="mr-2">
          <h1 className="text-lg font-black tracking-tight text-slate-900 leading-none">
            Snow<span className="text-blue-500">Drift</span>
          </h1>
          <p className="text-[11px] text-slate-400 mt-0.5">US snowfall forecast tracker</p>
        </div>

        <div className="w-px h-6 bg-slate-200 hidden sm:block" />

        <span className="ml-auto text-xs text-slate-400">
          {loading ? '' : error ? `Error: ${error}` : count === 0
            ? 'No snow predicted in the next 7 days'
            : `${count} snowy point${count !== 1 ? 's' : ''} · click any to see drift`}
        </span>
      </header>

      <main className="flex-1 relative">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-red-50 text-red-500 rounded-xl px-5 py-4 text-sm max-w-md text-center border border-red-100">
              <p className="font-bold mb-1">Failed to load map data</p>
              <p>{error}</p>
            </div>
          </div>
        ) : (
          <SnowMap points={points} fetchedAt={fetchedAt} />
        )}
      </main>
    </div>
  );
}
