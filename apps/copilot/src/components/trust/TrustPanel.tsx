'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/ar';
import { formatNumber } from '@/i18n/format';
import { AuditTable } from '@/components/AuditTable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import type { AuditFilters as AuditFiltersValue, AuditRowView, AuditSummary, AuditUserRef } from '@/audit/types';
import { loadAudit, loadAuditRow } from './api';
import { AuditDetail, type AuditDetailState } from './AuditDetail';
import { AuditFilters } from './AuditFilters';

const LOGIN_PATH = '/copilot/login';

type Phase = 'loading' | 'ready' | 'error';

function hasFilter(filters: AuditFiltersValue): boolean {
  return filters.event !== undefined || filters.imageSent !== undefined || filters.npiUserId !== undefined;
}

/**
 * The client side of `/trust` (T-33, F-17): owns the one list load and the
 * detail load, "latest load wins" as in `SettingsPanel` (`loadSeq`). A filter
 * change reloads from the first page and closes the detail; «المزيد» appends
 * the next page. Four states (spec/madar/03 §3): loading, error with retry,
 * empty, and the table.
 */
export function TrustPanel() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [filters, setFilters] = useState<AuditFiltersValue>({});
  const [rows, setRows] = useState<AuditRowView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // The summary and the user list come from the list response and are kept
  // across a filter reload so the chips and the selects do not flicker.
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [users, setUsers] = useState<AuditUserRef[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetailState | null>(null);

  const loadSeq = useRef(0);
  const detailSeq = useRef(0);

  const load = useCallback(async (next: AuditFiltersValue) => {
    const seq = ++loadSeq.current;
    detailSeq.current += 1;
    setDetail(null);
    setLoadingMore(false);
    setMoreError(null);
    setPhase('loading');
    const result = await loadAudit({ filters: next, cursor: null });
    if (seq !== loadSeq.current) return;
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setErrorMessage(result.kind === 'server' ? t('state.error') : result.messageAr);
      setPhase('error');
      return;
    }
    setRows(result.view.rows);
    setNextCursor(result.view.nextCursor);
    setSummary(result.view.summary);
    setUsers(result.view.users);
    setPhase('ready');
  }, []);

  useEffect(() => {
    void load({});
  }, [load]);

  function handleFilters(next: AuditFiltersValue) {
    setFilters(next);
    void load(next);
  }

  async function handleMore() {
    if (loadingMore || nextCursor === null) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    setMoreError(null);
    const result = await loadAudit({ filters, cursor: nextCursor });
    if (seq !== loadSeq.current) return;
    setLoadingMore(false);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setMoreError(result.kind === 'server' ? t('state.error') : result.messageAr);
      return;
    }
    setRows((prev) => [...prev, ...result.view.rows]);
    setNextCursor(result.view.nextCursor);
  }

  async function handleOpen(id: string) {
    const seq = ++detailSeq.current;
    setDetail({ id, phase: 'loading' });
    const result = await loadAuditRow(id);
    if (seq !== detailSeq.current) return;
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      const messageAr =
        result.kind === 'not_found' ? t('trust.not_found') : result.kind === 'server' ? t('state.error') : result.messageAr;
      setDetail({ id, phase: 'error', messageAr });
      return;
    }
    setDetail({ id, phase: 'ready', row: result.row });
  }

  function handleClose() {
    detailSeq.current += 1;
    setDetail(null);
  }

  // First load still in flight (nothing good to show yet), or it failed.
  if (summary === null) {
    if (phase === 'error') return <ErrorState message={errorMessage} onRetry={() => load(filters)} />;
    return <LoadingState />;
  }

  return (
    <div className="flex flex-col gap-5">
      <Summary summary={summary} />
      <AuditFilters filters={filters} users={users} onChange={handleFilters} />

      {phase === 'loading' ? <LoadingState /> : null}
      {phase === 'error' ? <ErrorState message={errorMessage} onRetry={() => load(filters)} /> : null}
      {phase === 'ready' && rows.length === 0 ? (
        <div data-testid="trust-empty">
          <EmptyState message={hasFilter(filters) ? t('trust.empty_filtered') : t('trust.empty')} />
        </div>
      ) : null}
      {phase === 'ready' && rows.length > 0 ? (
        <Card>
          <AuditTable rows={rows} openId={detail?.id ?? null} onOpen={handleOpen} />
          {nextCursor !== null || moreError !== null ? (
            <div className="mt-4 flex flex-col items-center gap-2">
              {moreError !== null ? (
                <p role="alert" className="text-sm text-danger-700">
                  {moreError}
                </p>
              ) : null}
              {nextCursor !== null ? (
                <Button
                  variant="secondary"
                  size="md"
                  data-testid="trust-more"
                  disabled={loadingMore}
                  onClick={handleMore}
                >
                  {loadingMore ? t('trust.loading_more') : t('trust.more')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {detail !== null ? <AuditDetail detail={detail} onClose={handleClose} /> : null}
    </div>
  );
}

/** The organization-wide counts and the I4 integrity line. These come from
 *  the list response and do NOT change with the filters — the line is always
 *  about the whole log (G-M4-2). */
function Summary({ summary }: { summary: AuditSummary }) {
  return (
    <div data-testid="trust-summary" className="flex flex-wrap items-center gap-2">
      <Badge tone="neutral">{t('trust.summary.total', { n: formatNumber(summary.total) })}</Badge>
      <Badge tone="neutral">{t('trust.summary.images', { n: formatNumber(summary.imageSent) })}</Badge>
      <Badge tone="neutral">{t('trust.summary.errors', { n: formatNumber(summary.errors) })}</Badge>
      {summary.imageSentWithoutConsent === 0 ? (
        <span data-testid="trust-summary-images-ok">
          <Badge tone="success">{t('trust.summary.images_ok')}</Badge>
        </span>
      ) : (
        <span data-testid="trust-summary-images-missing" role="alert">
          <Badge tone="danger">
            {t('trust.summary.images_missing', { n: formatNumber(summary.imageSentWithoutConsent) })}
          </Badge>
        </span>
      )}
    </div>
  );
}
