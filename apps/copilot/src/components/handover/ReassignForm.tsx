'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { t } from '@/i18n/ar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import type { HandoverCandidatesView } from '@/positions/handover-types';
import { loadCandidates, reassign } from './api';

const LOGIN_PATH = '/copilot/login';
const HANDOVER_PATH = '/copilot/handover';

type Phase = 'loading' | 'ready' | 'error' | 'missing';

export interface ReassignFormProps {
  positionId: string;
}

/**
 * «تعيين شاغل جديد» (T-30, F-13, UAT 3.11): the administrator picks the new
 * holder among the NPI users who hold the position's role and confirms. The
 * server re-checks everything (the browser's list is never trusted), and the
 * call can take up to a minute — the advanced-tier model writes the narrative
 * inside it — so the button stays busy and disabled meanwhile. On success the
 * browser navigates to the new document.
 */
export function ReassignForm({ positionId }: ReassignFormProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [view, setView] = useState<HandoverCandidatesView | null>(null);
  const [selected, setSelected] = useState('');
  const [working, setWorking] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setPhase('loading');
    const result = await loadCandidates(positionId);
    if (seq !== loadSeq.current) return;
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setErrorMessage(result.kind === 'server' ? t('state.error') : result.messageAr);
      setPhase(result.kind === 'not_found' ? 'missing' : 'error');
      return;
    }
    setView(result.candidates);
    setSelected(result.candidates.candidates[0]?.npiUserId ?? '');
    setPhase('ready');
  }, [positionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (working || selected === '') return;
    setWorking(true);
    setSubmitError(null);
    const result = await reassign(positionId, selected);
    if (result.ok) {
      // A full navigation: the document page loads fresh under the new assignment.
      window.location.assign(`${HANDOVER_PATH}?id=${encodeURIComponent(result.outcome.handoverId)}`);
      return;
    }
    if (result.kind === 'unauthenticated') {
      window.location.assign(LOGIN_PATH);
      return;
    }
    setSubmitError(result.messageAr);
    setWorking(false);
  }

  if (phase === 'loading') return <LoadingState />;
  if (phase === 'missing') return <EmptyState message={errorMessage} />;
  if (phase === 'error' || !view) return <ErrorState message={errorMessage} onRetry={load} />;

  const holderNames = view.holders.map((holder) => holder.nameAr ?? t('handover.unknown_user')).join('، ');
  const noCandidates = view.candidates.length === 0;

  return (
    <Card title={t('handover.reassign.title')}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" data-testid="handover-reassign-form">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-bold text-slate-900">{t('handover.reassign.position', { title: view.position.titleAr })}</p>
          <p className="text-sm text-slate-600">
            {view.holders.length === 0
              ? t('handover.reassign.no_holder')
              : t('handover.reassign.holders', { names: holderNames })}
          </p>
        </div>

        {noCandidates ? (
          <p className="text-sm text-slate-600">{t('handover.reassign.none')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="handover-candidate" className="text-sm font-semibold text-slate-800">
              {t('handover.reassign.pick')}
            </label>
            <select
              id="handover-candidate"
              data-testid="handover-candidate"
              value={selected}
              disabled={working}
              onChange={(e) => setSelected(e.target.value)}
              className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:max-w-sm"
            >
              {view.candidates.map((candidate) => (
                <option key={candidate.npiUserId} value={candidate.npiUserId}>
                  {candidate.nameAr}
                </option>
              ))}
            </select>
          </div>
        )}

        <p className="text-xs text-slate-500">{t('handover.reassign.hint')}</p>

        {submitError ? (
          <p role="alert" className="text-sm text-danger-700">
            {submitError}
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={noCandidates || selected === ''} loading={working}>
            {working ? t('handover.reassign.working') : t('handover.reassign.submit')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
