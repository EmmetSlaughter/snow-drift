import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Snow Forecast Drift · Waltham MA',
  description: 'Track how NWS and Open-Meteo snowfall predictions change over time leading up to a storm.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-slate-900">
      <body className="antialiased">{children}</body>
    </html>
  );
}
