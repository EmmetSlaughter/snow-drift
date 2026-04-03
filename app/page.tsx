'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';

const SnowMap = dynamic(
  () => import('@/components/SnowMap').then(m => m.SnowMap),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-[#faf7f2] text-[#bbb5a8] text-sm">
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
    <div className="flex flex-col h-screen bg-[#faf7f2] text-[#4a4539]">

      <header className="flex-none flex items-center gap-3 px-5 py-3 bg-[#fffdf9] border-b border-[#ece6da] z-10">
        <div className="mr-2">
          <h1 className="text-xl font-black tracking-tight leading-none">
            Snow<span className="text-[#12b886]">Drift</span>
          </h1>
          <p className="text-[11px] text-[#bbb5a8] mt-0.5">is it gonna snow?</p>
        </div>

        <span className="ml-auto text-xs text-[#bbb5a8]">
          {loading ? '' : error ? `Error: ${error}` : count === 0
            ? 'No snow in the forecast!'
            : `${count} snowy point${count !== 1 ? 's' : ''} · click any to explore`}
        </span>
      </header>

      <main className="flex-1 relative">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-[#fff5f5] text-[#e03131] rounded-2xl px-5 py-4 text-sm max-w-md text-center border border-[#ffc9c9]">
              <p className="font-bold mb-1">Something went wrong</p>
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
