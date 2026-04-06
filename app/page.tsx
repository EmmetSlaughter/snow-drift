'use client';

import dynamic from 'next/dynamic';

const StateMap = dynamic(
  () => import('@/components/StateMap').then(m => m.StateMap),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-[#faf7f2] text-[#bbb5a8] text-sm">
        Loading…
      </div>
    ),
  },
);

export default function HomePage() {
  return (
    <div className="h-screen bg-[#faf7f2]">
      <StateMap />
    </div>
  );
}
