'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/ar';
import { ErrorState, LoadingState, EmptyState } from '@/components/ui/States';
import type { RerunStep, SettingsView } from '@/settings/types';
import type { ModuleKey } from '@/onboarding/profile.schema';
import type { FlowType } from '@/agents/router';
import { loadSettings, saveVisibleModules, saveBaseline, rerunStep, runSync } from './api';
import { ProfileCard, DocTypesCard, TerminologyCard, LastApplyCard } from './ConfigCards';
import { ModulesCard } from './ModulesCard';
import { PositionsCard } from './PositionsCard';
import { BaselinesCard } from './BaselinesCard';
import { SyncCard, type SyncOutcome } from './SyncCard';

const LOGIN_PATH = '/copilot/login';
const SETUP_PATH = '/copilot/setup';

type Phase = 'loading' | 'ready' | 'error';

export type SaveOutcome = { ok: true } | { ok: false; messageAr: string };

/**
 * The settings screen (T-19, F-15, spec/madar/02 §5.9 and §7
 * "re-runnable per step from /settings"): owns the one load and every write
 * against `/copilot/api/settings`, same "latest load wins" pattern as
 * `SetupWizard` (`loadSeq`). A `rerun` of any step is a full navigation to
 * the wizard — there is no partial state to reconcile here, the setup
 * session itself holds it.
 *
 * T-39b (D-23): the page reads the view on the server and passes it as
 * `initialData`, so the cards are in the first HTML; the component then
 * starts `ready` and makes no GET on mount. Without it (the server read
 * failed) it loads itself as before.
 */
export function SettingsPanel({ initialData }: { initialData?: SettingsView } = {}) {
  const [phase, setPhase] = useState<Phase>(initialData ? 'ready' : 'loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [view, setView] = useState<SettingsView | null>(initialData ?? null);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setPhase('loading');
    const result = await loadSettings();
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
    setView(result.view);
    setPhase('ready');
  }, []);

  // With server-provided first data (T-39b, D-23) the mount needs no GET;
  // `load` stays for the error state's retry. Same pattern as `IntakePanel`.
  useEffect(() => {
    if (initialData === undefined) load();
  }, [load, initialData]);

  async function handleSaveModules(modules: ModuleKey[]): Promise<SaveOutcome> {
    const result = await saveVisibleModules(modules);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return { ok: false, messageAr: '' };
      }
      return { ok: false, messageAr: result.kind === 'server' ? t('state.error') : result.messageAr };
    }
    setView(result.view);
    return { ok: true };
  }

  async function handleSaveBaseline(flow: FlowType, minutes: number): Promise<SaveOutcome> {
    const result = await saveBaseline(flow, minutes);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return { ok: false, messageAr: '' };
      }
      return { ok: false, messageAr: result.kind === 'server' ? t('state.error') : result.messageAr };
    }
    setView(result.view);
    return { ok: true };
  }

  async function handleSync(): Promise<SyncOutcome> {
    const result = await runSync();
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return { ok: false, messageAr: '' };
      }
      return { ok: false, messageAr: result.kind === 'server' ? t('state.error') : result.messageAr };
    }
    // The answer carries the refreshed card data; the positions below it are
    // reloaded from the same GET the page uses so a new holder shows at once.
    setView((current) => (current ? { ...current, sync: result.result.sync } : current));
    if (result.result.outcome === 'synced' && result.result.changed) {
      const fresh = await loadSettings();
      if (fresh.ok) setView(fresh.view);
    }
    return { ok: true, result: result.result };
  }

  async function handleRerun(step: RerunStep): Promise<void> {
    const result = await rerunStep(step);
    if (!result.ok) {
      if (result.kind === 'unauthenticated') {
        window.location.assign(LOGIN_PATH);
        return;
      }
      setErrorMessage(result.kind === 'server' ? t('state.error') : result.messageAr);
      setPhase('error');
      return;
    }
    window.location.assign(SETUP_PATH);
  }

  if (phase === 'loading' || !view) {
    return <LoadingState />;
  }
  if (phase === 'error') {
    return <ErrorState message={errorMessage} onRetry={load} />;
  }

  const { config, positions, baselines, openSetup, sync } = view;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-slate-600">{t('settings.intro')}</p>

      {openSetup ? (
        <div role="status" className="rounded-lg border border-info-200 bg-info-50/60 px-3 py-2 text-sm text-info-700">
          {t('settings.open_setup_note')}
        </div>
      ) : null}

      {config === null ? (
        <EmptyState message={t('settings.no_config')}>
          <a
            href="/setup"
            className="text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {t('settings.go_setup')}
          </a>
        </EmptyState>
      ) : (
        <>
          <ProfileCard config={config} onRerun={() => handleRerun(1)} />
          <ModulesCard visibleModules={config.visibleModules} onSave={handleSaveModules} />
          <DocTypesCard config={config} onRerun={() => handleRerun(4)} />
          <TerminologyCard config={config} onRerun={() => handleRerun(6)} />
          <LastApplyCard lastApply={config.lastApply} onRetryStep={handleRerun} />
        </>
      )}

      {config !== null && sync.canSync ? <SyncCard sync={sync} onSync={handleSync} /> : null}

      <PositionsCard positions={positions} canRerun={config !== null} onRerun={() => handleRerun(2)} isAdmin />
      <BaselinesCard baselines={baselines} onSave={handleSaveBaseline} />
    </div>
  );
}
