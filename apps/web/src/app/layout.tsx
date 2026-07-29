import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import type { Locale } from '@/lib/messages';

// Self-hosted at build time by next/font — no runtime Google request.
const plex = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'NPI Solar ERP',
  description: 'ZATCA-native vertical solar ERP for the Saudi/GCC market',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieLocale = cookies().get('locale')?.value;
  const locale: Locale = cookieLocale === 'en' ? 'en' : 'ar';
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <html lang={locale} dir={dir} className={plex.variable}>
      <body>
        <Providers initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
