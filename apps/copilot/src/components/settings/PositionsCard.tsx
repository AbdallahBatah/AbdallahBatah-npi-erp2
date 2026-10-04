'use client';

import { t } from '@/i18n/ar';
import { formatDate } from '@/i18n/format';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { SettingsPosition } from '@/settings/types';

export interface PositionsCardProps {
  positions: SettingsPosition[];
  /** Rerun (step 2) only makes sense once a setup has produced positions to
   *  re-edit; shown regardless of whether any position exists yet (an empty
   *  list is itself something step 2 can fix), but hidden entirely while no
   *  `firm_config` exists (there is nothing to rerun *from*). */
  canRerun: boolean;
  onRerun: () => void;
}

/** `settings.positions`: always rendered (02 §7, T-19 spec), independent of
 *  whether `firm_config` exists — positions/assignments are copilot-only
 *  rows that can outlive a reset configuration. */
export function PositionsCard({ positions, canRerun, onRerun }: PositionsCardProps) {
  return (
    <Card title={t('settings.positions')}>
      <div className="flex flex-col gap-3">
        {positions.length === 0 ? (
          <p className="text-sm text-slate-500">{t('settings.positions.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {positions.map((position) => (
              <li
                key={position.id}
                data-testid="settings-position"
                className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="text-sm font-bold text-slate-900">{position.titleAr}</p>
                  <span className="text-xs text-slate-500">{position.roleNameAr}</span>
                  <span className="text-xs text-slate-500">
                    {position.departmentNameAr ?? t('settings.positions.no_department')}
                  </span>
                </div>
                {position.holders.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('settings.positions.no_holder')}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {position.holders.map((holder) => (
                      <span
                        key={holder.npiUserId}
                        title={t('settings.positions.since', { date: formatDate(holder.since) })}
                        className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                      >
                        {holder.nameAr ?? t('settings.positions.unknown_user')}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canRerun ? (
          <div>
            <Button type="button" variant="secondary" size="sm" onClick={onRerun}>
              {t('settings.rerun')}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
