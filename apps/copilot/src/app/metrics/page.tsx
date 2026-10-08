import { redirect } from 'next/navigation';
import { MetricCard } from '@/components/MetricCard';
import { Card } from '@/components/ui/Card';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import { formatDateTime } from '@/i18n/format';
import { loadMetrics } from '@/metrics/load';
import { METRICS_PERMISSION, type MetricsView } from '@/metrics/types';
import { NpiError } from '@/npi/errors';

export const dynamic = 'force-dynamic';

const LINK_CLASS =
  'text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

// The `secondary` Button recipe (src/components/ui/Button.tsx) as literal
// classes: a download link is an `<a>`, not a `<button>`.
const EXPORT_LINK_CLASS =
  'inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2';

/**
 * The metrics screen (T-35, F-19, spec/madar/01 §1 and §7): the six
 * assumptions a1-a6 as cards, computed on the server in one render — read-only,
 * so there is no client fetch. Same session/permission handling as
 * `src/app/trust/page.tsx`.
 */
export default async function MetricsPage() {
  let session;
  try {
    session = await getServerSession();
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f4f6f8] p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-card" role="alert">
          <p className="text-sm text-danger-700">{t('home.error.npi')}</p>
          <a
            href="/copilot"
            className="mt-4 inline-block text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {t('action.retry')}
          </a>
        </div>
      </div>
    );
  }

  if (!session) redirect('/login');

  if (!session.user.permissions.includes(METRICS_PERMISSION)) {
    return (
      <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
        <Card>
          <p className="text-sm text-slate-700">{t('metrics.forbidden')}</p>
          <a href="/" className={`mt-3 inline-block ${LINK_CLASS}`}>
            {t('nav.home')}
          </a>
        </Card>
      </ShellFrame>
    );
  }

  let view: MetricsView | null = null;
  try {
    view = await loadMetrics(getDb(), { npiOrgId: session.user.npiOrgId }, new Date());
  } catch (err) {
    console.error('[copilot] metrics failed', err instanceof Error ? err.message : err);
  }

  return (
    <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-bold text-slate-900">{t('metrics.title')}</h1>
            <p className="text-sm text-slate-600">{t('metrics.subtitle')}</p>
          </div>
          <div className="flex flex-col items-start gap-1">
            {/* A plain `<a>`, not `next/link`: the basePath is hardcoded here the
                way ShellFrame.tsx hardcodes its paths. */}
            <a
              href="/copilot/api/metrics/export"
              download="copilot-metrics.csv"
              data-testid="metrics-export"
              className={EXPORT_LINK_CLASS}
            >
              {t('metrics.export')}
            </a>
            <p className="text-xs text-slate-500">{t('metrics.export.hint')}</p>
          </div>
        </div>

        {view === null ? (
          <div data-testid="metrics-error">
            <Card>
              <p role="alert" className="text-sm text-danger-700">
                {t('metrics.error')}
              </p>
              <a href="/copilot/metrics" className={`mt-3 inline-block ${LINK_CLASS}`}>
                {t('action.retry')}
              </a>
            </Card>
          </div>
        ) : (
          <>
            <p data-testid="metrics-generated" className="text-xs text-slate-500">
              <time dateTime={view.generatedAt}>
                {t('metrics.measured_at', { value: formatDateTime(view.generatedAt) })}
              </time>
            </p>
            <div data-testid="metrics-grid" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {view.cards.map((card) => (
                <MetricCard key={card.assumption} card={card} />
              ))}
            </div>
          </>
        )}
      </div>
    </ShellFrame>
  );
}
