import { t, type ArKey } from '@/i18n/ar';
import { formatNumber } from '@/i18n/format';
import { npiWebUrl } from '@/npi/web-url';
import type { TileState } from '@/queries/home';

export interface SummaryTileProps {
  /** The tile's Arabic label key (`home.tile.*`). */
  titleKey: ArKey;
  /** Absolute path on NPI's own web app (e.g. `/inbox`) — resolved through
   *  `npiWebUrl` since this link leaves the copilot entirely. */
  npiPath: string;
  state: TileState;
}

/** Thin brand-tinted top edge shared by every tile surface — copies NPI's
 *  `.stat::before` recipe (apps/web/src/app/globals.css) as a real element,
 *  since the copilot app has no `.stat` class of its own to reuse. */
function TopEdge() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-l from-brand-400/0 via-brand-400/60 to-brand-400/0"
    />
  );
}

// Shared surface: NPI's `.card` (rounded-xl, its border, shadow-card),
// `relative overflow-hidden` (so `TopEdge` clips to the rounded corners),
// and the phones-are-lighter layout — label+number on one row at `p-3`,
// stacked from `sm` up at `p-5`.
const SURFACE =
  'relative flex items-center justify-between gap-2 overflow-hidden rounded-xl border border-slate-200/80 p-3 sm:block sm:p-5';

/**
 * One home-screen tile (spec/madar/03 §2/§3): a label, the count, and a
 * plain `<a>` to the matching NPI screen — a real cross-origin navigation,
 * not a `next/link`. `forbidden` and `error` states replace the count and
 * drop the link, since there is nothing to open.
 */
export function SummaryTile({ titleKey, npiPath, state }: SummaryTileProps) {
  if (state.state === 'forbidden') {
    return (
      <div data-testid={`tile-${titleKey}`} className={`${SURFACE} bg-slate-50`}>
        <p className="text-xs font-medium text-slate-500">{t(titleKey)}</p>
        <p className="text-lg font-semibold text-slate-600 sm:mt-1 sm:text-lg">
          {t('home.tile.no_access')}
        </p>
      </div>
    );
  }

  if (state.state === 'error') {
    return (
      <div
        data-testid={`tile-${titleKey}`}
        className="relative overflow-hidden rounded-xl border border-danger-200 bg-danger-50/40 p-3 sm:p-5"
      >
        <p className="text-xs font-medium text-slate-600">{t(titleKey)}</p>
        <p className="mt-1 text-sm text-danger-700">{t('home.error.npi')}</p>
        <a
          href="/copilot"
          className="mt-1 inline-block text-xs font-semibold text-danger-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-500"
        >
          {t('action.retry')}
        </a>
      </div>
    );
  }

  const href = npiWebUrl(npiPath);
  const countClass = state.count === 0 ? 'text-slate-400' : 'text-slate-900';

  return (
    <a
      href={href}
      data-testid={`tile-${titleKey}`}
      className={`${SURFACE} bg-white shadow-card transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}
    >
      <TopEdge />
      <p className="text-xs font-medium text-slate-500">{t(titleKey)}</p>
      <p className={`text-lg font-bold sm:mt-1 sm:text-3xl ${countClass}`}>
        {formatNumber(state.count)}
      </p>
    </a>
  );
}
