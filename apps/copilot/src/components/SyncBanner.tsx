'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { t } from '@/i18n/ar';
import { formatNumber } from '@/i18n/format';
import { Button } from '@/components/ui/Button';
import { keyedLines } from '@/components/ui/keys';
import { markSyncSeen } from '@/components/settings/api';
import type { SyncBannerView } from '@/settings/types';

/**
 * The home banner (T-47b): «تغيّرت الأدوار أو المناصب في NPI منذ آخر مزامنة»
 * with the first lines of the change, a link to /settings for the rest and
 * «تم» to acknowledge it. The home page decides on the SERVER whether to render
 * it at all, so it is in the first HTML and shifts nothing after hydration;
 * the only change it ever makes to the layout is disappearing when the
 * administrator presses «تم».
 */
export function SyncBanner({ banner }: { banner: SyncBannerView }) {
  const [dismissed, setDismissed] = useState(false);
  const [working, setWorking] = useState(false);
  const titleId = useId();

  if (dismissed) return null;

  async function handleSeen() {
    setWorking(true);
    const result = await markSyncSeen();
    setWorking(false);
    if (!result.ok && result.kind === 'unauthenticated') {
      window.location.assign('/copilot/login');
      return;
    }
    // A failed write leaves the banner for the next load; hiding it now is
    // still what the administrator asked for.
    setDismissed(true);
  }

  return (
    <section
      aria-labelledby={titleId}
      data-testid="sync-banner"
      className="flex flex-col gap-2 rounded-xl border border-info-200 bg-info-50/60 p-4"
    >
      <p id={titleId} className="text-sm font-bold text-slate-900">{t('sync.banner.title')}</p>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-slate-800">
        {keyedLines(banner.lines).map(({ key, line }) => (
          <li key={key}>{line}</li>
        ))}
      </ul>
      {banner.more > 0 ? <p className="text-xs text-slate-500">{t('sync.more', { n: formatNumber(banner.more) })}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/settings"
          className="text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {t('sync.banner.details')}
        </Link>
        <Button type="button" variant="secondary" size="sm" onClick={handleSeen} disabled={working} loading={working} data-testid="sync-banner-seen">
          {t('sync.banner.seen')}
        </Button>
      </div>
    </section>
  );
}
