'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n/ar';
import { ErrorState, Skeleton } from '@/components/ui/States';
import { PreviewCard } from '@/components/PreviewCard';
import { ExecutionCard } from '@/components/ExecutionCard';
import { WaitingIndicator } from '@/components/chat/WaitingIndicator';
import type { IntakeAction, IntakeView } from '@/intake/types';
import { actOnIntake, loadIntake, type IntakeErrorKind } from './api';

const LOGIN_PATH = '/copilot/login';

export interface IntakePanelProps {
  /** `intake_jobs.id`. */
  id: string;
  /** Inside a chat bubble: adds the link to the document's own page. */
  compact?: boolean;
  /**
   * The job as the parent already read it (T-39): the panel renders it at
   * once, with no loading skeleton and no fetch of its own. The chat passes
   * the cards of a loaded history this way so they appear at their final
   * height in the same frame as the messages, instead of each skeleton
   * swapping to a taller card a moment later and pushing the visible
   * messages down (measured CLS 0.9 on the home screen before this).
   */
  initialView?: IntakeView;
}

type Phase = 'loading' | 'error' | 'ready';

/**
 * One intake job, live (T-26, F-10): loads it, renders the `PreviewCard` and
 * — once approved — the `ExecutionCard`, and turns every card callback into
 * one `POST /copilot/api/intake` whose answer replaces the view. Used by the
 * document page (`/documents/[id]`) and, `compact`, under a chat bubble.
 */
export function IntakePanel({ id, compact = false, initialView }: IntakePanelProps) {
  const [phase, setPhase] = useState<Phase>(initialView ? 'ready' : 'loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [errorKind, setErrorKind] = useState<IntakeErrorKind | null>(null);
  const [view, setView] = useState<IntakeView | null>(initialView ?? null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    const result = await loadIntake(id);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setErrorKind(result.kind);
      setErrorMessage(result.messageAr);
      setPhase('error');
      return;
    }
    setView(result.job);
    setActionError(null);
    setPhase('ready');
  }, [id]);

  useEffect(() => {
    // A pre-read view skips the first fetch; `load` still serves retries and
    // the «state» refresh below.
    if (initialView === undefined) void load();
  }, [load, initialView]);

  async function run(action: IntakeAction) {
    if (busy) return;
    setBusy(true);
    const result = await actOnIntake(action);
    setBusy(false);

    if (result.ok) {
      setView(result.job);
      setActionError(null);
      return;
    }
    if (result.kind === 'unauthenticated') {
      window.location.assign(LOGIN_PATH);
      return;
    }
    setActionError(result.messageAr);
    if (result.kind === 'state') {
      // The job moved on (approved or cancelled elsewhere): show it as it is
      // now, keeping the explanation on the card.
      const fresh = await loadIntake(id);
      if (fresh.ok) setView(fresh.job);
    }
  }

  if (phase === 'loading') {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" data-testid="intake-loading">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (phase === 'error' || view === null) {
    return <ErrorState message={errorMessage || t('state.error')} onRetry={errorKind === 'not_found' ? undefined : load} />;
  }

  if (view.status === 'failed' && view.preview === null) {
    return <ErrorState message={view.failureAr ?? t('preview.failed')} />;
  }

  if (view.status === 'extracting') {
    return <WaitingIndicator label={t('intake.reading_text')} />;
  }

  if (view.preview === null) {
    return <ErrorState message={t('state.error')} onRetry={load} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="intake-panel">
      <PreviewCard
        view={view}
        busy={busy}
        errorAr={actionError}
        onConfirm={(path) => run({ id, action: 'confirm', path })}
        onSet={(path, value) => run({ id, action: 'set', path, value })}
        onChoose={(target, choice) => run({ id, action: 'choose', target, choice })}
        onEdit={(text) => run({ id, action: 'edit', text })}
        onApprove={() => run({ id, action: 'approve' })}
        onCancel={() => run({ id, action: 'cancel' })}
      />
      {view.status === 'cancelled' ? <p className="text-sm text-slate-600">{t('intake.cancelled')}</p> : null}
      {view.execution ? <ExecutionCard log={view.execution} flowLabelAr={view.flowLabelAr} flow={view.flow} /> : null}
      {compact ? (
        <a
          href={`/copilot/documents/${encodeURIComponent(id)}`}
          className="w-fit text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {t('preview.open_page')}
        </a>
      ) : null}
    </div>
  );
}
