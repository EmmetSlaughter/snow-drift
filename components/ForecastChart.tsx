'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface Point  { fetchedAt: string; snowIn: number }
interface Series { source: string;   points: Point[] }

const SOURCE_COLOR: Record<string, string> = {
  'nws':        '#3b82f6',   // blue-500
  'open-meteo': '#f97316',   // orange-500
};
const SOURCE_LABEL: Record<string, string> = {
  'nws':        'NWS',
  'open-meteo': 'Open-Meteo',
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', hour12: true,
    timeZoneName: 'short',
  });
}

export function ForecastChart({ series }: { series: Series[] }) {
  if (!series.length) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
        No data yet — run <code className="mx-1 font-mono bg-slate-700 px-1 rounded">/api/cron</code> to seed the first snapshot.
      </div>
    );
  }

  // Merge all series into one flat array keyed by fetchedAt for recharts.
  const timeSet = new Set<string>();
  for (const s of series) for (const p of s.points) timeSet.add(p.fetchedAt);
  const allTimes = Array.from(timeSet).sort();

  const data = allTimes.map(t => {
    const entry: Record<string, string | number> = { fetchedAt: t };
    for (const s of series) {
      const pt = s.points.find(p => p.fetchedAt === t);
      if (pt !== undefined) entry[s.source] = pt.snowIn;
    }
    return entry;
  });

  return (
    <ResponsiveContainer width="100%" height={420}>
      <LineChart data={data} margin={{ top: 8, right: 24, left: 16, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis
          dataKey="fetchedAt"
          tickFormatter={fmtTime}
          tick={{ fontSize: 11, fill: '#94a3b8' }}
          minTickGap={80}
        />
        <YAxis
          unit='″'
          tick={{ fontSize: 11, fill: '#94a3b8' }}
          label={{
            value: 'Snow (inches)',
            angle: -90,
            position: 'insideLeft',
            fill: '#94a3b8',
            fontSize: 12,
            dx: -8,
          }}
          allowDecimals
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 6,
          }}
          labelStyle={{ color: '#e2e8f0', marginBottom: 4 }}
          itemStyle={{ color: '#e2e8f0' }}
          labelFormatter={fmtTime}
          formatter={(v: number, name: string) => [
            `${v.toFixed(1)}″`,
            SOURCE_LABEL[name] ?? name,
          ]}
        />
        <Legend
          formatter={value => SOURCE_LABEL[value] ?? value}
          wrapperStyle={{ color: '#94a3b8', fontSize: 13 }}
        />
        {series.map(s => (
          <Line
            key={s.source}
            type="monotone"
            dataKey={s.source}
            name={s.source}
            stroke={SOURCE_COLOR[s.source] ?? '#8884d8'}
            strokeWidth={2}
            dot={false}
            connectNulls
            activeDot={{ r: 4 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
