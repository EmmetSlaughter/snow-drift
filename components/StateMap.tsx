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

// Mock data for preview when no real data is available.
const MOCK_STATES: Record<string, StateSummary> = {
  CO: { maxSnowIn: 14, pointCount: 5 },
  WY: { maxSnowIn: 8, pointCount: 3 },
  MT: { maxSnowIn: 6, pointCount: 4 },
  UT: { maxSnowIn: 18, pointCount: 6 },
  MN: { maxSnowIn: 4, pointCount: 2 },
  WI: { maxSnowIn: 3, pointCount: 2 },
  ME: { maxSnowIn: 7, pointCount: 3 },
  VT: { maxSnowIn: 10, pointCount: 2 },
  NH: { maxSnowIn: 9, pointCount: 2 },
  NY: { maxSnowIn: 5, pointCount: 3 },
  MI: { maxSnowIn: 2, pointCount: 1 },
  ID: { maxSnowIn: 11, pointCount: 3 },
  WA: { maxSnowIn: 1, pointCount: 1 },
  OR: { maxSnowIn: 3, pointCount: 2 },
  ND: { maxSnowIn: 26, pointCount: 4 },
  SD: { maxSnowIn: 4, pointCount: 2 },
  PA: { maxSnowIn: 2, pointCount: 1 },
  MA: { maxSnowIn: 5, pointCount: 2 },
};

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

          {/* Snowflake symbol — simple 6-spoke icon */}
          <symbol id="flake" viewBox="0 0 20 20">
            <g stroke="rgba(255,255,255,0.3)" strokeWidth="1.4" strokeLinecap="round" fill="none">
              <line x1="10" y1="2" x2="10" y2="18" />
              <line x1="3.07" y1="6" x2="16.93" y2="14" />
              <line x1="3.07" y1="14" x2="16.93" y2="6" />
            </g>
            <circle cx="10" cy="10" r="1.5" fill="rgba(255,255,255,0.25)" />
          </symbol>

          {/* Single tiled snowflake pattern — big flakes, slight rotation */}
          <pattern id="snowflakes" width="50" height="50" patternUnits="userSpaceOnUse" patternTransform="rotate(12)">
            <use href="#flake" x="5" y="5" width="22" height="22" />
            <use href="#flake" x="32" y="30" width="16" height="16" />
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
            const summary = data?.states[state.abbr.toLowerCase()] ?? data?.states[state.abbr] ?? MOCK_STATES[state.abbr];
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
                    fontSize={10}
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
                {!state.external && hasSnow && !isHovered && (
                  <text
                    x={state.labelX}
                    y={state.labelY + 12}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={7}
                    fontWeight={700}
                    fill="rgba(255,255,255,0.8)"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {summary.maxSnowIn.toFixed(0)}″
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* External labels */}
        {states.filter(s => s.external).map(state => {
          const summary = data?.states[state.abbr.toLowerCase()] ?? data?.states[state.abbr] ?? MOCK_STATES[state.abbr];
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
                fontSize={9}
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
