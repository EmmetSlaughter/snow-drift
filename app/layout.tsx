import type { Metadata } from 'next';
import { Nunito } from 'next/font/google';
import './globals.css';

const nunito = Nunito({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'SnowDrift',
  description: 'Is it gonna snow? Track how forecasts change leading up to a storm.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={nunito.className}>
      <body className="antialiased bg-[#faf7f2]">{children}</body>
    </html>
  );
}
