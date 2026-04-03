import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SnowDrift — US Snowfall Forecast Tracker',
  description: 'Track how NWS and Open-Meteo snowfall predictions change over time leading up to a storm.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-slate-100">
      <body className="antialiased">{children}</body>
    </html>
  );
}
