'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/ar';
import { formatDate } from '@/i18n/format';
import { HandoverDoc } from '@/components/HandoverDoc';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import type { HandoverSummary, HandoverView } from '@/positions/handover-types';
import { loadHandover, loadHandovers, narrate } from './api';
import { ReassignForm } from './ReassignForm';

const LOGIN_PATH = '/copilot/login';

export type HandoverMode =
  | { kind: 'list' }
  | { kind: 'doc'; id: string }
  | { kind: 'reassign'; positionId: string };

export interface HandoverPanelProps {
  mode: HandoverMode;
  isAdmin: boolean;
}

type Phase = 'loading' | 'ready' | 'empty' | 'error';

/**
 * The client side of `/handover` (T-30, F-13): owns the loads (latest load
 * wins, as in `SettingsPanel`) and the four states of every screen — loading,
 * error with retry, empty, normal. Three modes: the list of documents the
 * user may read, one document, and (administrators) the reassignment form.
 */
export function HandoverPanel({ mode, isAdmin }: HandoverPanelProps) {
  if (mode.kind === 'reassign') return <ReassignForm positionId={mode.positionId} />;
  if (mode.kind === 'doc') return <DocPanel id={mode.id} isAdmin={isAdmin} />;
  return <ListPanel />;
}

function ListPanel() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [handovers, setHandovers] = useState<HandoverSummary[]>([]);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setPhase('loading');
    const result = await loadHandovers();
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
    setHandovers(result.handovers);
    setPhase(result.handovers.length === 0 ? 'empty' : 'ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-600">{t('handover.intro')}</p>
      {phase === 'loading' ? <LoadingState /> : null}
      {phase === 'error' ? <ErrorState message={errorMessage} onRetry={load} /> : null}
      {phase === 'empty' ? <EmptyState message={t('handover.list.empty')} /> : null}
      {phase === 'ready' ? (
        <Card title={t('handover.list.title')}>
          <ul data-testid="handover-list" className="flex flex-col gap-2">
            {handovers.map((handover) => (
              <li key={handover.id}>
                <Link
                  href={`/handover?id=${encodeURIComponent(handover.id)}`}
                  data-testid="handover-list-item"
                  className="flex min-h-11 items-center rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {t('handover.list.item', {
                    position: handover.positionTitleAr,
                    date: formatDate(handover.createdAt),
                  })}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

type DocPhase = Phase | 'missing';

function DocPanel({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const [phase, setPhase] = useState<DocPhase>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [view, setView] = useState<HandoverView | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [narrateError, setNarrateError] = useState<string | null>(null);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setPhase('loading');
    const result = await loadHandover(id);
    if (seq !== loadSeq.current) return;
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      if (result.kind === 'not_found') {
        setPhase('missing');
        return;
      }
      setErrorMessage(result.kind === 'server' ? t('state.error') : result.messageAr);
      setPhase('error');
      return;
    }
    setView(result.handover);
    setPhase('ready');
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleNarrate() {
    if (narrating) return;
    setNarrating(true);
    setNarrateError(null);
    const result = await narrate(id);
    setNarrating(false);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setNarrateError(result.kind === 'server' ? t('state.error') : result.messageAr);
      return;
    }
    setView(result.handover);
  }

  if (phase === 'missing') return <EmptyState message={t('handover.not_found')} />;
  if (phase === 'error') return <ErrorState message={errorMessage} onRetry={load} />;
  if (phase === 'loading' || !view) return <LoadingState />;

  return (
    <div className="flex flex-col gap-3">
      {narrateError ? (
        <p role="alert" className="rounded-lg border border-danger-200 bg-danger-50/40 px-3 py-2 text-sm text-danger-700">
          {narrateError}
        </p>
      ) : null}
      <HandoverDoc view={view} isAdmin={isAdmin} onNarrate={handleNarrate} narrating={narrating} />
    </div>
  );
}
