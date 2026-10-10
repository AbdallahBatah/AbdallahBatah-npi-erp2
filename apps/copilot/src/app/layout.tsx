import type { Metadata } from 'next';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { headers } from 'next/headers';
import { HydrationMark } from '@/components/HydrationMark';
import { ViewportHintProvider } from '@/components/ViewportHint';
import { t } from '@/i18n/ar';
import { desktopHintFromUserAgent } from '@/viewport-hint';
import './globals.css';

// Self-hosted at build time by next/font — no runtime Google request.
const plex = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  // `optional` (D-24, owner's choice, T-39b): the font is used only when it is
  // already at hand — cached, or arrived within the browser's short block
  // period — so text never re-wraps after the first paint. A first visit on a
  // slow link reads that page in the system's Arabic font; the eight files
  // (≈197 KB) kept arriving after the first paint on a throttled phone and
  // the re-wrap was a layout shift of 0.15 on the setup screen.
  display: 'optional',
});

export const metadata: Metadata = {
  title: t('app.name'),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The server's guess at the viewport for the first paint (T-39b, see
  // `ViewportHint`); every screen renders per request already (sessions), so
  // reading a header here changes nothing else.
  const desktopHint = desktopHintFromUserAgent(headers().get('user-agent'));
  return (
    <html lang="ar" dir="rtl" className={plex.variable}>
      <body>
        <ViewportHintProvider isDesktop={desktopHint}>{children}</ViewportHintProvider>
        <HydrationMark />
      </body>
    </html>
  );
}
