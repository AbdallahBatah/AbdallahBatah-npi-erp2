'use client';

import { useState, type ReactNode } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { formatDateTime, formatNumber, formatUsdMicro } from '@/i18n/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorState, LoadingState } from '@/components/ui/States';
import type { AuditDetailView, AuditOutbound, AuditOutboundBlock } from '@/audit/types';

/** The state of the open detail, owned by `TrustPanel`. */
export interface AuditDetailState {
  id: string;
  phase: 'loading' | 'ready' | 'error';
  row?: AuditDetailView;
  messageAr?: string;
}

export interface AuditDetailProps {
  detail: AuditDetailState;
  onClose(): void;
}

const NONE = '—';

const PRE_CLASS = 'max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs';

const LINK_CLASS =
  'text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * One audit row in full (D-T33-19): the facts of the row, the consent behind
 * an image send, and «ما أُرسل خارجياً» — the redacted text exactly as it
 * left the building. Loading and error render in place of the body.
 */
export function AuditDetail({ detail, onClose }: AuditDetailProps) {
  return (
    <Card>
      <section data-testid="trust-detail" aria-labelledby="trust-detail-title" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="trust-detail-title" className="text-base font-bold text-slate-900">
            {t('trust.detail.title')}
          </h2>
          <Button variant="secondary" size="sm" data-testid="trust-detail-close" onClick={onClose}>
            {t('trust.detail.close')}
          </Button>
        </div>
        {detail.phase === 'loading' ? <LoadingState /> : null}
        {detail.phase === 'error' ? <ErrorState message={detail.messageAr ?? t('state.error')} /> : null}
        {detail.phase === 'ready' && detail.row ? <DetailBody row={detail.row} /> : null}
      </section>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{children}</dd>
    </div>
  );
}

function DetailBody({ row }: { row: AuditDetailView }) {
  const isSystem = row.kind === 'system';
  const isOtherEvent = row.eventLabelAr === t('trust.event.other');

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t('trust.col.time')}>
          <time dateTime={row.ts}>{formatDateTime(row.ts)}</time>
        </Field>
        <Field label={t('trust.col.user')}>
          {row.userNameAr ?? <span className="font-mono text-xs">{row.npiUserId}</span>}
        </Field>
        <Field label={t('trust.col.event')}>
          {row.eventLabelAr}
          {isOtherEvent ? <div className="font-mono text-xs text-slate-500">{row.event}</div> : null}
        </Field>
        <Field label={t('trust.col.model')}>
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
        </Field>
        <Field label={t('trust.col.tokens')}>
          {isSystem ? NONE : `${formatNumber(row.tokensIn)} / ${formatNumber(row.tokensOut)}`}
        </Field>
        <Field label={t('trust.col.cost')}>
          {isSystem ? NONE : `${formatUsdMicro(row.costUsdMicro)} ${t('trust.unit.usd')}`}
        </Field>
        <Field label={t('trust.col.latency')}>
          {row.latencyMs === null ? NONE : `${formatNumber(row.latencyMs)} ${t('trust.unit.ms')}`}
        </Field>
        <Field label={t('trust.col.document')}>
          {row.document === null ? (
            NONE
          ) : (
            <a href={`/copilot/documents/${row.document.id}`} className={LINK_CLASS}>
              {row.document.fileName}
            </a>
          )}
        </Field>
        <Field label={t('trust.col.error')}>
          {row.error === null ? NONE : <span className="whitespace-pre-wrap">{row.error}</span>}
        </Field>
      </dl>

      <ConsentLine row={row} />

      <Outbound outbound={row.outbound} />
    </div>
  );
}

function ConsentLine({ row }: { row: AuditDetailView }) {
  if (!row.imageSent) return null;
  if (row.consent === null) {
    // The impossible case (I4): shown, never hidden.
    return (
      <p role="alert" className="rounded-lg border border-danger-200 bg-danger-50/40 px-3 py-2 text-sm text-danger-700">
        {t('trust.detail.image_sent_without_consent')}
      </p>
    );
  }
  return (
    <p data-testid="trust-detail-consent" className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
      <span>{t('trust.detail.image_sent_with_consent', { consent: row.consent.id })}</span>
      <Badge tone={row.consent.decision === 'approved' ? 'success' : 'neutral'}>
        {t(`trust.consent.${row.consent.decision}` as ArKey)}
      </Badge>
      <span className="text-xs text-slate-500">{formatDateTime(row.consent.createdAt)}</span>
    </p>
  );
}

function Outbound({ outbound }: { outbound: AuditOutbound | null }) {
  const [showSystem, setShowSystem] = useState(false);

  return (
    <div data-testid="trust-detail-outbound" className="flex flex-col gap-3">
      <h3 className="text-sm font-bold text-slate-900">{t('trust.col.outbound')}</h3>
      {outbound === null ? (
        <p className="text-sm text-slate-600">{t('trust.detail.nothing_sent')}</p>
      ) : (
        <>
          <p data-testid="trust-detail-placeholders" className="text-sm text-slate-700">
            {t('trust.detail.placeholders', { n: formatNumber(outbound.placeholderCount) })}
          </p>
          {outbound.kind === 'parsed' ? (
            <>
              <div className="flex flex-col gap-2">
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="trust-detail-system-toggle"
                    aria-expanded={showSystem}
                    onClick={() => setShowSystem((v) => !v)}
                  >
                    {showSystem ? t('trust.detail.hide_system') : t('trust.detail.show_system')}
                  </Button>
                </div>
                {showSystem ? (
                  <pre className={PRE_CLASS} dir="auto">
                    {outbound.system}
                  </pre>
                ) : null}
              </div>
              <h4 className="text-sm font-semibold text-slate-800">{t('trust.detail.messages')}</h4>
              <div className="flex flex-col gap-3">
                {outbound.messages.map((message, index) => (
                  <div key={index} className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold text-slate-500">
                      {message.role === 'user' ? t('trust.detail.role.user') : t('trust.detail.role.assistant')}
                    </p>
                    {typeof message.content === 'string' ? (
                      <pre className={PRE_CLASS} dir="auto">
                        {message.content}
                      </pre>
                    ) : (
                      message.content.map((block, blockIndex) => <Block key={blockIndex} block={block} />)
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <h4 className="text-sm font-semibold text-slate-800">{t('trust.detail.raw')}</h4>
              <pre className={PRE_CLASS} dir="auto">
                {outbound.text}
              </pre>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Block({ block }: { block: AuditOutboundBlock }) {
  if (block.type === 'text') {
    return (
      <pre className={PRE_CLASS} dir="auto">
        {block.text}
      </pre>
    );
  }
  const key: ArKey = block.type === 'image' ? 'trust.detail.block.image' : 'trust.detail.block.document';
  return (
    <p
      data-testid="trust-detail-block-image"
      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
    >
      {t(key, {
        mediaType: block.mediaType,
        size: formatNumber(block.sizeBytes),
        consent: block.consentEventId,
      })}
    </p>
  );
}
