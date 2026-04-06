'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import statePaths from '@/lib/state-paths.json';

interface StateSummary {
  maxSnowIn: number;
  pointCount: number;
}

interface StateData {
  fetchedAt: string | null;
  states: Record<string, StateSummary>;
}

interface StateEntry {
  fips: string;
  abbr: string;
  name: string;
  path: string;
  labelX: number;
  labelY: number;
  anchorX?: number;
  anchorY?: number;
  external?: boolean;
}

// Single snow color — no severity shading at the state level.
const SNOW_COLOR = '#3a86ff';


export function StateMap() {
  const router = useRouter();
  const [data, setData] = useState<StateData | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const states = statePaths as StateEntry[];

  useEffect(() => {
    fetch('/api/state-summary')
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-[#dbeefe]">
      {/* Title */}
      <div className="text-center mb-5 select-none">
        <h1 className="text-3xl font-black tracking-tight">
          <span className="text-[#4a4539]">snow</span>
          <span className="text-[#3a86ff]">drift</span>
        </h1>
        <p className="text-xs text-[#7eaed4] mt-1 font-semibold">
          {data?.fetchedAt
            ? `Updated ${new Date(data.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`
            : 'is it gonna snow?'}
        </p>
      </div>

      <svg viewBox="0 0 960 620" className="w-full max-w-4xl">
        <defs>
          <filter id="map-shadow" x="-3%" y="-2%" width="106%" height="110%">
            <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="#4a7eaa" floodOpacity="0.2" />
          </filter>

          {/* Google Material snowflake icon */}
          <symbol id="flake" viewBox="0 -960 960 960">
            <path
              fill="rgba(255,255,255,0.22)"
              d="M450-80v-95l-73 62-39-46 112-94v-175l-151 87-26 145-59-11 17-94-82 47-30-52 82-47-90-33 20-56 138 49 150-87-150-86-138 49-20-56 90-33-82-48 30-52 82 48-17-94 59-11 26 145 151 87v-175l-112-94 39-46 73 62v-96h60v96l72-62 39 46-111 94v175l150-87 26-145 59 11-17 94 82-47 30 53-82 46 90 33-20 56-138-49-150 86 150 87 138-49 20 56-90 33 83 47-30 52-83-47 17 94-59 11-26-145-150-87v175l111 94-39 46-72-62v95h-60Z"
            />
          </symbol>

          {/* Tiled snowflake pattern */}
          <pattern id="snowflakes" width="60" height="60" patternUnits="userSpaceOnUse" patternTransform="rotate(8)">
            <use href="#flake" x="5" y="5" width="26" height="26" />
            <use href="#flake" x="38" y="36" width="18" height="18" />
          </pattern>
        </defs>

        {/* Map group */}
        <g filter="url(#map-shadow)">
          {/* Connector lines */}
          {states.filter(s => s.external && s.anchorX != null).map(state => (
            <line
              key={`line-${state.abbr}`}
              x1={state.anchorX}
              y1={state.anchorY}
              x2={state.labelX - 12}
              y2={state.labelY}
              stroke="#a8cfee"
              strokeWidth={0.8}
              strokeDasharray="2 2"
            />
          ))}

          {/* States */}
          {states.map(state => {
            // Use real data if available, fall back to mock for preview.
            const summary = data?.states[state.abbr.toLowerCase()] ?? data?.states[state.abbr];
            const hasSnow = summary && summary.maxSnowIn > 0;
            const isHovered = hovered === state.abbr;
            const fill = hasSnow ? SNOW_COLOR : '#ffffff';
            const cx = state.anchorX ?? state.labelX;
            const cy = state.anchorY ?? state.labelY;

            return (
              <g
                key={state.abbr}
                onClick={() => router.push(`/state/${state.abbr.toLowerCase()}`)}
                onMouseEnter={() => setHovered(state.abbr)}
                onMouseLeave={() => setHovered(null)}
                className="cursor-pointer"
                style={{
                  transition: 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
                  transform: isHovered
                    ? `translate(${cx}px,${cy}px) scale(1.04) translate(${-cx}px,${-cy}px)`
                    : 'none',
                }}
              >
                {/* Base fill */}
                <path
                  d={state.path}
                  fill={isHovered && !hasSnow ? '#f0f7ff' : fill}
                  stroke={hasSnow ? 'rgba(255,255,255,0.5)' : '#d0dcea'}
                  strokeWidth={0.75}
                  strokeLinejoin="round"
                  style={{ transition: 'fill 0.15s ease' }}
                />
                {/* Snowflake pattern overlay — clipped to state shape */}
                {hasSnow && (
                  <path
                    d={state.path}
                    fill="url(#snowflakes)"
                    stroke="none"
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                {!state.external && (
                  <text
                    x={state.labelX}
                    y={state.labelY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fontWeight={800}
                    fill={
                      isHovered ? '#4a4539'
                        : hasSnow ? '#ffffff'
                        : '#b0bcc8'
                    }
                    style={{
                      pointerEvents: 'none',
                      userSelect: 'none',
                      textShadow: hasSnow && !isHovered ? '0 1px 2px rgba(0,0,0,0.3)' : 'none',
                      letterSpacing: '0.5px',
                      transition: 'fill 0.15s ease',
                    }}
                  >
                    {state.abbr}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* External labels */}
        {states.filter(s => s.external).map(state => {
          const summary = data?.states[state.abbr.toLowerCase()] ?? data?.states[state.abbr];
          const hasSnow = summary && summary.maxSnowIn > 0;
          const isHovered = hovered === state.abbr;
          const color = isHovered ? '#4a4539' : hasSnow ? SNOW_COLOR : '#7eaed4';

          return (
            <g
              key={`ext-${state.abbr}`}
              className="cursor-pointer"
              onClick={() => router.push(`/state/${state.abbr.toLowerCase()}`)}
              onMouseEnter={() => setHovered(state.abbr)}
              onMouseLeave={() => setHovered(null)}
            >
              {hasSnow && (
                <g transform={`translate(${state.labelX - 10}, ${state.labelY - 4.5})`}>
                  <line x1="4.5" y1="0.5" x2="4.5" y2="8.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
                  <line x1="1" y1="2.2" x2="8" y2="6.8" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
                  <line x1="1" y1="6.8" x2="8" y2="2.2" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
                </g>
              )}
              <text
                x={state.labelX + (hasSnow ? 2 : 0)}
                y={state.labelY}
                textAnchor="start"
                dominantBaseline="central"
                fontSize={10}
                fontWeight={isHovered ? 800 : 700}
                fill={color}
                style={{
                  pointerEvents: 'auto',
                  userSelect: 'none',
                  transition: 'fill 0.15s ease',
                }}
              >
                {state.abbr}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-5 select-none bg-white/60 backdrop-blur-sm rounded-full px-5 py-2">
        <div className="w-4 h-4 rounded-full" style={{ backgroundColor: SNOW_COLOR }} />
        <span className="text-xs text-[#7eaed4] font-bold">= snow in the forecast</span>
      </div>
    </div>
  );
}
