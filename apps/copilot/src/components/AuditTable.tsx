import { t, type ArKey } from '@/i18n/ar';
import { formatDateTime, formatNumber, formatUsdMicro } from '@/i18n/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { AuditRowView } from '@/audit/types';

export interface AuditTableProps {
  rows: AuditRowView[];
  openId: string | null;
  onOpen(id: string): void;
}

/** An absent value — an em dash is not a Latin letter, so the no-Latin rule
 *  lets it stand in source. */
const NONE = '—';

const ERROR_PREVIEW_CHARS = 40;

const LINK_CLASS =
  'text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

const HEADERS: ArKey[] = [
  'trust.col.time',
  'trust.col.user',
  'trust.col.event',
  'trust.col.model',
  'trust.col.tokens',
  'trust.col.cost',
  'trust.col.image_sent',
  'trust.col.consent',
  'trust.col.document',
  'trust.col.error',
];

/**
 * The trust log table (spec/madar/03 §2 `AuditTable`, with the column
 * «صورة أُرسلت»): one row per `llm_audit` row, newest first, a button per row
 * that opens its detail. Purely presentational — the panel owns the loads.
 * The wrapper scrolls horizontally on its own so the page never does.
 */
export function AuditTable({ rows, openId, onOpen }: AuditTableProps) {
  return (
    // The table scrolls inside the card, never the page: the shell's <main> is
    // a flex item with `min-w-0` (AppShell.tsx), so this overflow box cannot
    // stretch the layout to the table's intrinsic width. `relative` keeps the
    // `sr-only` (absolute) caption and header text inside the scroller.
    <div className="relative overflow-x-auto" data-testid="trust-table">
      <table className="min-w-full border-collapse text-start">
        <caption className="sr-only">{t('trust.title')}</caption>
        <thead className="bg-slate-50">
          <tr>
            {HEADERS.map((key) => (
              <th
                key={key}
                scope="col"
                className="whitespace-nowrap px-3 py-2 text-start text-xs font-semibold text-slate-600"
              >
                {t(key)}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-start text-xs font-semibold text-slate-600">
              <span className="sr-only">{t('trust.detail.open')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AuditRow key={row.id} row={row} open={row.id === openId} onOpen={onOpen} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditRow({ row, open, onOpen }: { row: AuditRowView; open: boolean; onOpen(id: string): void }) {
  const isSystem = row.kind === 'system';
  const isOtherEvent = row.eventLabelAr === t('trust.event.other');

  return (
    <tr
      data-testid="trust-row"
      data-id={row.id}
      data-event={row.event}
      data-image-sent={row.imageSent ? 'true' : 'false'}
      className={`border-t border-slate-100 align-top${open ? ' bg-brand-50/40' : ''}`}
    >
      <td className="whitespace-nowrap px-3 py-2 text-sm text-slate-700">
        <time dateTime={row.ts}>{formatDateTime(row.ts)}</time>
      </td>

      <td data-testid="trust-cell-user" className="px-3 py-2 text-sm text-slate-700">
        {row.userNameAr ?? <span className="font-mono text-xs">{row.npiUserId}</span>}
      </td>

      <td data-testid="trust-cell-event" className="px-3 py-2 text-sm text-slate-700">
        {row.eventLabelAr}
        {isOtherEvent ? <div className="font-mono text-xs text-slate-500">{row.event}</div> : null}
      </td>

      <td className="px-3 py-2 text-sm text-slate-700">
        {isSystem ? (
          <span className="text-slate-500">{t('trust.tier.none')}</span>
        ) : (
          <>
            {row.modelTier !== null ? (
              <Badge tone={row.modelTier === 'advanced' ? 'brand' : 'neutral'}>
                {t(`trust.tier.${row.modelTier}` as ArKey)}
              </Badge>
            ) : null}
            {row.modelId !== null ? <div className="font-mono text-xs text-slate-500">{row.modelId}</div> : null}
          </>
        )}
      </td>

      <td className="whitespace-nowrap px-3 py-2 text-sm text-slate-700">
        {isSystem ? NONE : `${formatNumber(row.tokensIn)} / ${formatNumber(row.tokensOut)}`}
      </td>

      <td className="whitespace-nowrap px-3 py-2 text-sm text-slate-700">
        {isSystem ? NONE : `${formatUsdMicro(row.costUsdMicro)} ${t('trust.unit.usd')}`}
      </td>

      <td data-testid="trust-cell-image-sent" className="px-3 py-2 text-sm">
        {row.imageSent ? <Badge tone="success">{t('trust.yes')}</Badge> : <Badge tone="neutral">{t('trust.no')}</Badge>}
      </td>

      <td data-testid="trust-cell-consent" className="px-3 py-2 text-sm text-slate-700">
        {row.consent !== null ? (
          <span
            className="font-mono text-xs"
            title={`${t(`trust.consent.${row.consent.decision}` as ArKey)} · ${formatDateTime(row.consent.createdAt)}`}
          >
            {row.consent.id}
          </span>
        ) : row.imageSent ? (
          // The impossible case (I4): shown, never hidden.
          <Badge tone="danger">{t('trust.detail.image_sent_without_consent')}</Badge>
        ) : (
          NONE
        )}
      </td>

      <td className="px-3 py-2 text-sm text-slate-700">
        {row.document === null ? (
          NONE
        ) : (
          <a href={`/copilot/documents/${row.document.id}`} className={LINK_CLASS}>
            {row.document.fileName}
          </a>
        )}
      </td>

      <td className="px-3 py-2 text-sm text-slate-700">
        {row.error === null ? (
          NONE
        ) : (
          <span title={row.error}>
            <Badge tone="danger">{row.error.slice(0, ERROR_PREVIEW_CHARS)}</Badge>
          </span>
        )}
      </td>

      <td className="px-3 py-2">
        <Button
          variant="secondary"
          size="sm"
          data-testid="trust-row-open"
          aria-expanded={open}
          onClick={() => onOpen(row.id)}
        >
          {t('trust.detail.open')}
        </Button>
      </td>
    </tr>
  );
}
