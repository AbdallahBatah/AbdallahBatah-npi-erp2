import Link from 'next/link';
import { t } from '@/i18n/ar';

/**
 * App Router's global not-found page (fix 2 of the design-critique pass).
 * Same background/card treatment as the home page's own error card, so a
 * mistyped path does not suddenly land on an unstyled default 404.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f6f8] p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-card">
        <h1 className="text-lg font-bold text-slate-900">{t('notfound.title')}</h1>
        <p className="mt-2 text-sm text-slate-600">{t('notfound.body')}</p>
        <Link
          href="/"
          className="mt-4 inline-block text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {t('nav.home')}
        </Link>
      </div>
    </div>
  );
}
