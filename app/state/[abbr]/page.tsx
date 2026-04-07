'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { STATE_BOUNDS, VALID_STATES } from '@/lib/state-bounds';

const StateDetail = dynamic(
  () => import('@/components/StateDetail').then(m => m.StateDetail),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-white text-[#7eaed4] text-sm font-semibold">
        Loading…
      </div>
    ),
  },
);

interface SnowPoint { locationId: number; lat: number; lon: number; snowIn: number }

export default function StatePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const abbr = (params.abbr as string).toLowerCase();
  const bounds = STATE_BOUNDS[abbr];
  const valid = VALID_STATES.has(abbr);

  // Optional lat/lon from search — auto-select nearest point on load.
  const focusLat = searchParams.get('lat') ? Number(searchParams.get('lat')) : undefined;
  const focusLon = searchParams.get('lon') ? Number(searchParams.get('lon')) : undefined;

  interface GridPoint { id: number; lat: number; lon: number }

  const [points, setPoints]         = useState<SnowPoint[]>([]);
  const [gridPoints, setGridPoints] = useState<GridPoint[]>([]);
  const [fetchedAt, setFetchedAt]   = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);

  const loadData = useCallback(async () => {
    if (!valid) return;
    setLoading(true);
    try {
      const [mapRes, gridRes] = await Promise.all([
        fetch('/api/map-data'),
        fetch(`/api/grid-points?state=${abbr}`),
      ]);
      // Load grid points first so we can filter snow points to only those
      // whose locationId is in this state's grid (avoids bounding box overlap).
      let stateGridIds = new Set<number>();
      if (gridRes.ok) {
        const gridJson = await gridRes.json();
        const gp = gridJson.points ?? [];
        setGridPoints(gp);
        stateGridIds = new Set(gp.map((g: { id: number }) => g.id));
      }
      if (mapRes.ok) {
        const mapJson = await mapRes.json();
        const all: SnowPoint[] = mapJson.points ?? [];
        setPoints(all.filter(p => stateGridIds.has(p.locationId)));
        setFetchedAt(mapJson.fetchedAt ?? null);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [valid, abbr, bounds]);

  useEffect(() => { loadData(); }, [loadData]);

  if (!valid) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-white text-[#4a4539]">
        <p className="text-lg font-bold mb-2">State not found</p>
        <Link href="/" className="text-sm text-[#3a86ff] hover:underline font-semibold">← Back to overview</Link>
      </div>
    );
  }

  // Only count points at or above the lowest contour threshold (0.1″).
  // Trace amounts below that don't render visually.
  const snowCount = points.filter(p => p.snowIn >= 0.1).length;

  return (
    <div className="flex flex-col h-screen bg-white">
      <header className="flex-none flex items-center gap-3 px-5 py-3 bg-white/80 backdrop-blur-md border-b border-[#d0dcea] z-10">
        <Link
          href="/"
          className="text-sm text-[#7eaed4] hover:text-[#4a4539] transition-colors font-semibold mr-2"
        >
          ← back
        </Link>
        <div>
          <h1 className="text-xl font-black tracking-tight text-[#4a4539] leading-none">
            {bounds.name}
          </h1>
          <p className="text-[11px] text-[#7eaed4] font-semibold mt-0.5">
            {loading ? 'Loading…' : snowCount === 0
              ? 'No snow in the forecast'
              : `${snowCount} snowy point${snowCount !== 1 ? 's' : ''} · click any to explore`}
          </p>
        </div>
        {fetchedAt && (
          <span className="ml-auto text-xs text-[#7eaed4] font-semibold">
            {new Date(fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
          </span>
        )}
      </header>

      <main className="flex-1 relative overflow-hidden">
        <StateDetail abbr={abbr} points={points} gridPoints={gridPoints} fetchedAt={fetchedAt} focusLat={focusLat} focusLon={focusLon} />
      </main>
    </div>
  );
}
