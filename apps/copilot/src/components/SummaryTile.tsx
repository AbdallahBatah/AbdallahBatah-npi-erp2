import { t, type ArKey } from '@/i18n/ar';
import type { TileState } from '@/queries/home';

export interface SummaryTileProps {
  /** The tile's Arabic label key (`home.tile.*`). */
  titleKey: ArKey;
  /** Absolute path on NPI's own web app (e.g. `/inbox`) — prefixed with
   *  `NEXT_PUBLIC_NPI_WEB_URL` since this link leaves the copilot entirely. */
  npiPath: string;
  state: TileState;
}

/**
 * One home-screen tile (spec/madar/03 §2/§3): a label, the count in
 * `text-3xl`, and a plain `<a>` to the matching NPI screen — a real
 * cross-origin navigation, not a `next/link`. `forbidden` and `error` states
 * replace the count and drop the link, since there is nothing to open.
 */
export function SummaryTile({ titleKey, npiPath, state }: SummaryTileProps) {
  if (state.state === 'forbidden') {
    return (
      <div data-testid={`tile-${titleKey}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs font-medium text-slate-400">{t(titleKey)}</p>
        <p className="mt-1 text-lg font-semibold text-slate-400">{t('home.tile.no_access')}</p>
      </div>
    );
  }

  if (state.state === 'error') {
    return (
      <div data-testid={`tile-${titleKey}`} className="rounded-xl border border-danger-200 bg-danger-50/40 p-4">
        <p className="text-xs font-medium text-slate-600">{t(titleKey)}</p>
        <p className="mt-1 text-lg font-semibold text-danger-700">{t('home.tile.error')}</p>
      </div>
    );
  }

  const href = `${process.env.NEXT_PUBLIC_NPI_WEB_URL ?? ''}${npiPath}`;

  return (
    <a
      href={href}
      data-testid={`tile-${titleKey}`}
      className="block rounded-xl bg-white p-4 shadow-card transition hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <p className="text-xs font-medium text-slate-500">{t(titleKey)}</p>
      <p className="mt-1 text-3xl font-bold text-slate-900">
        {state.count.toLocaleString('ar-SA-u-nu-latn')}
      </p>
    </a>
  );
}
