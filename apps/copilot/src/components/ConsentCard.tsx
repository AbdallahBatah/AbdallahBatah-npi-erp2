'use client';

import { useId } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { formatNumber } from '@/i18n/format';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { DocumentKind } from '@/components/chat/api';

export interface ConsentCardDocument {
  fileName: string;
  kind: DocumentKind;
  pageCount: number;
}

export interface ConsentCardProps {
  document: ConsentCardDocument;
  /** The verified provider policy line (`t('consent.policy_line')`),
   *  interpolated into `consent.body`. */
  policyLine: string;
  busy: boolean;
  errorMessage?: string | null;
  onApprove: () => void;
  onCancel: () => void;
}

const KIND_LABEL_KEY: Record<DocumentKind, ArKey> = {
  pdf_text: 'intake.kind.pdf_text',
  pdf_scanned: 'intake.kind.pdf_scanned',
  image: 'intake.kind.image',
};

/**
 * The approval card shown before a scanned PDF or photo is sent to the
 * model (spec/madar/03 §2 `ConsentCard`; spec/madar/02 §5 item 3). Carries
 * the gold approval-card edge (`03` §1) — the same treatment as
 * `setup/DiffCard.tsx`, the project's only other gold-edge card.
 *
 * Must fit a 390px viewport with no horizontal scroll (AT-16's spirit): the
 * two action buttons wrap onto their own row via `flex-wrap`, and the file
 * name breaks via `break-words` rather than overflowing.
 */
export function ConsentCard({ document, policyLine, busy, errorMessage, onApprove, onCancel }: ConsentCardProps) {
  const titleId = useId();
  const pagesLine =
    document.pageCount <= 1
      ? t('consent.page_one')
      : t('consent.pages', { n: formatNumber(document.pageCount) });

  return (
    <div data-testid="consent-card" role="group" aria-labelledby={titleId}>
      <Card edge="gold" title={t('consent.title')}>
        {/* Duplicates the visible title above for `aria-labelledby`: the
            Card component (not owned by this task) has no way to expose an
            id on its own `<h3>`, so this sr-only node supplies one. */}
        <span id={titleId} className="sr-only">
          {t('consent.title')}
        </span>
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <bdi className="break-words text-sm font-semibold text-slate-900">{document.fileName}</bdi>
            <Badge tone="neutral">{t(KIND_LABEL_KEY[document.kind])}</Badge>
          </div>
          <p className="text-sm text-slate-700">{t('consent.body', { policy_line: policyLine })}</p>
          <p className="text-sm text-slate-600">{pagesLine}</p>
          {errorMessage ? (
            <p role="alert" className="text-sm font-semibold text-danger-700">
              {errorMessage}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={onApprove} disabled={busy} loading={busy}>
              {t('consent.approve')}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
              {t('consent.cancel')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
