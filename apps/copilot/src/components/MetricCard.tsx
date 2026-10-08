import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { t, type ArKey } from '@/i18n/ar';
import { formatDateTime } from '@/i18n/format';
import type { MetricCardView, MetricVerdict } from '@/metrics/types';

const VERDICT_TONE: Record<MetricVerdict, BadgeTone> = {
  met: 'success',
  not_met: 'danger',
  no_data: 'neutral',
  measured: 'info',
};

/** Thin brand-tinted top edge — a local copy of `SummaryTile`'s `TopEdge`
 *  (it is not exported there). */
function TopEdge() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-l from-brand-400/0 via-brand-400/60 to-brand-400/0"
    />
  );
}

/**
 * One assumption card of the metrics screen (T-35, F-19): the headline figure,
 * the target of 01 §1, the verdict, an optional secondary figure, a few detail
 * lines and when it was measured. Presentational and read-only — no hooks, no
 * links, no fetch. `Badge` does not forward `data-testid`, so each badge is
 * wrapped in a `<span data-testid>`.
 */
export function MetricCard({ card }: { card: MetricCardView }) {
  const labelId = `metric-${card.assumption}-label`;
  const { secondary } = card;

  return (
    <article
      data-testid="metric-card"
      data-assumption={card.assumption}
      data-verdict={card.verdict}
      aria-labelledby={labelId}
      className="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-slate-200/80 bg-white p-4 shadow-card sm:p-5"
    >
      <TopEdge />
      <div className="flex items-start justify-between gap-2">
        <h2 id={labelId} data-testid="metric-label" className="text-sm font-semibold text-slate-700">
          {card.labelAr}
        </h2>
        <span data-testid="metric-verdict">
          <Badge tone={VERDICT_TONE[card.verdict]}>
            {t(`metrics.verdict.${card.verdict}` as ArKey)}
          </Badge>
        </span>
      </div>

      <p
        data-testid="metric-value"
        className={`text-3xl font-bold ${card.value === null ? 'text-slate-400' : 'text-slate-900'}`}
      >
        {card.value ?? '—'}
      </p>

      <p data-testid="metric-target" className="text-xs text-slate-500">
        {t('metrics.target', { value: card.targetAr })}
      </p>

      {secondary ? (
        <div data-testid="metric-secondary" className="rounded-lg bg-slate-50 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-slate-600">{secondary.labelAr}</p>
            <span data-testid="metric-secondary-verdict">
              <Badge tone={VERDICT_TONE[secondary.verdict]}>
                {t(`metrics.verdict.${secondary.verdict}` as ArKey)}
              </Badge>
            </span>
          </div>
          <p
            data-testid="metric-secondary-value"
            className={`text-lg font-semibold ${secondary.value === null ? 'text-slate-400' : 'text-slate-900'}`}
          >
            {secondary.value ?? '—'}
          </p>
          <p className="text-xs text-slate-500">{t('metrics.target', { value: secondary.targetAr })}</p>
        </div>
      ) : null}

      {card.detailsAr.length > 0 ? (
        <ul data-testid="metric-details" className="flex flex-col gap-1 text-xs text-slate-600">
          {card.detailsAr.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}

      {card.measuredAt ? (
        <p className="mt-auto text-xs text-slate-400">
          <time dateTime={card.measuredAt}>
            {t('metrics.measured_at', { value: formatDateTime(card.measuredAt) })}
          </time>
        </p>
      ) : null}
    </article>
  );
}
