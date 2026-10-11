'use client';

import { useState } from 'react';
import { t } from '@/i18n/ar';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { SettingsSync, SyncActionResult } from '@/settings/types';

export type SyncOutcome = { ok: true; result: SyncActionResult } | { ok: false; messageAr: string };

export interface SyncCardProps {
  sync: SettingsSync;
  onSync: () => Promise<SyncOutcome>;
}

/**
 * `sync.title` (T-47b): when Madar last read NPI, the last change that
 * reading found, and the «حدّث من NPI» button. The times are ready Arabic text
 * from the server (`SettingsSync`), so the server render and hydration agree.
 * The button's answer replaces the card's data through `onSync` (the panel
 * swaps `view.sync`); this component only adds the one-line message.
 */
export function SyncCard({ sync, onSync }: SyncCardProps) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);

  async function handleClick() {
    setWorking(true);
    setMessage(null);
    const outcome = await onSync();
    setWorking(false);
    if (!outcome.ok) {
      if (outcome.messageAr) setMessage({ text: outcome.messageAr, tone: 'warn' });
      return;
    }
    setMessage({ text: outcome.result.messageAr, tone: outcome.result.outcome === 'synced' ? 'ok' : 'warn' });
  }

  return (
    <Card title={t('sync.title')}>
      <div className="flex flex-col gap-3" data-testid="settings-sync">
        <p className="text-sm text-slate-600">{t('sync.hint')}</p>
        <p className="text-sm font-semibold text-slate-900" data-testid="settings-sync-last">
          {sync.lastSyncAgoAr ? t('sync.last', { ago: sync.lastSyncAgoAr }) : t('sync.never')}
        </p>
        {sync.lastDiff ? (
          <div className="flex flex-col gap-1" data-testid="settings-sync-diff">
            <p className="text-xs text-slate-500">{t('sync.last_diff', { ago: sync.lastDiff.agoAr })}</p>
            <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-slate-800">
              {sync.lastDiff.summaryAr.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-slate-500">{t('sync.diff_none')}</p>
        )}
        {sync.canSync ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={handleClick} disabled={working} loading={working} data-testid="settings-sync-button">
              {working ? t('sync.working') : t('sync.button')}
            </Button>
            {message ? (
              <output
                data-testid="settings-sync-result"
                className={message.tone === 'ok' ? 'text-sm font-semibold text-success-700' : 'text-sm text-warning-700'}
              >
                {message.text}
              </output>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
