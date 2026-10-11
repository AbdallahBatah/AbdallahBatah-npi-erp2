'use client';

import { t, type ArKey } from '@/i18n/ar';
import { formatDate } from '@/i18n/format';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { lineKeys } from '@/components/ui/keys';
import type { RerunStep, SettingsConfig, SettingsLastApply, SettingsLeftover } from '@/settings/types';
import { describeGapAr } from '@/onboarding/gaps';
import { FLOW_REQUIRED_MODULE, type ModuleKey, type TermKey } from '@/onboarding/profile.schema';

// ─── Profile ────────────────────────────────────────────────────────────────

export interface ConfigCardProps {
  config: SettingsConfig;
  onRerun: () => void;
}

/** `settings.profile`: the firm's activity profile, rerun-able as step 1
 *  («غيّر النشاط») — the only card whose rerun button has its own wording. */
export function ProfileCard({ config, onRerun }: ConfigCardProps) {
  return (
    <Card title={t('settings.profile')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-slate-900">{config.profileTitleAr}</p>
        <p className="text-sm text-slate-600">
          {config.setupCompletedAt
            ? t('settings.profile.completed_at', { date: formatDate(config.setupCompletedAt) })
            : t('settings.profile.incomplete')}
        </p>
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={onRerun}>
            {t('settings.rerun.profile')}
          </Button>
        </div>
        <p className="text-xs text-slate-500">{t('settings.rerun.note')}</p>
      </div>
    </Card>
  );
}

// ─── Document types ─────────────────────────────────────────────────────────

/** `settings.doc_types`: one row per accepted document type, with a warning
 *  badge when the module its flow needs is currently hidden (`ModulesCard`
 *  may have unchecked it without re-running step 4). */
export function DocTypesCard({ config, onRerun }: ConfigCardProps) {
  const visible = new Set<ModuleKey>(config.visibleModules as ModuleKey[]);
  return (
    <div data-testid="settings-doctypes-card">
    <Card title={t('settings.doc_types')}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {config.acceptedDocTypes.map((docType) => {
            const hiddenModule = docType.flow !== null && !visible.has(FLOW_REQUIRED_MODULE[docType.flow]);
            return (
              <div
                key={docType.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"
              >
                <span className="text-sm text-slate-900">{docType.labelAr}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={docType.flow !== null ? 'brand' : 'neutral'}>
                    {docType.flow !== null ? t(`flow.${docType.flow}` as ArKey) : t('setup.doc.no_flow')}
                  </Badge>
                  {hiddenModule ? <Badge tone="warning">{t('settings.doc_types.hidden_module')}</Badge> : null}
                </div>
              </div>
            );
          })}
        </div>
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={onRerun}>
            {t('settings.rerun')}
          </Button>
        </div>
      </div>
    </Card>
    </div>
  );
}

// ─── Terminology ────────────────────────────────────────────────────────────

/** `settings.terminology`: the firm's renamed concepts, or the empty notice
 *  when none were set (the pack's own wording is used everywhere). */
export function TerminologyCard({ config, onRerun }: ConfigCardProps) {
  const entries = Object.entries(config.terminology) as [TermKey, string][];
  return (
    <div data-testid="settings-terminology-card">
    <Card title={t('settings.terminology')}>
      <div className="flex flex-col gap-3">
        {entries.length === 0 ? (
          <p className="text-sm text-slate-500">{t('settings.terminology.empty')}</p>
        ) : (
          <dl className="flex flex-col gap-1.5">
            {entries.map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-3 text-sm">
                <dt className="text-slate-600">{t(`setup.term.${key}` as ArKey)}</dt>
                <dd className="font-semibold text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={onRerun}>
            {t('settings.rerun')}
          </Button>
        </div>
      </div>
    </Card>
    </div>
  );
}

// ─── Last apply ─────────────────────────────────────────────────────────────

function GapsSection({ gaps }: { gaps: SettingsLastApply['gaps'] }) {
  if (gaps.length === 0) return null;
  const gapKeys = lineKeys(gaps.map((gap) => (gap.kind === 'workflow_definitions' ? gap.kind : `${gap.roleKey}\u0000${gap.permission}`)));
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-bold text-slate-900">{t('settings.last_apply.gaps')}</h4>
      <ul className="list-inside list-disc text-sm text-info-700">
        {gaps.map((gap, position) =>
          gap.kind === 'workflow_definitions' ? (
            <li key={gapKeys[position]}>{describeGapAr(gap, '')}</li>
          ) : (
            <li key={gapKeys[position]}>
              <code dir="ltr" className="text-xs text-slate-500">
                {gap.permission}
              </code>{' '}
              — {gap.roleKey}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function LeftoverSection({
  titleKey,
  items,
  tone,
  showNpiMessage,
  onRetryStep,
}: {
  titleKey: ArKey;
  items: SettingsLeftover[];
  tone: 'warning' | 'danger';
  showNpiMessage?: boolean;
  onRetryStep: (step: RerunStep) => void;
}) {
  if (items.length === 0) return null;
  const toneClass = tone === 'danger' ? 'text-danger-700' : 'text-warning-700';
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-bold text-slate-900">{t(titleKey)}</h4>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.stepId} className="flex flex-col gap-1 rounded-lg border border-slate-200 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-900">{item.labelAr}</p>
              {item.setupStep !== null ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => onRetryStep(item.setupStep as RerunStep)}>
                  {t('settings.last_apply.retry')}
                </Button>
              ) : null}
            </div>
            <p className={`text-sm ${toneClass}`}>{item.reasonAr}</p>
            {showNpiMessage && item.npiMessage ? (
              <code dir="ltr" className="text-xs text-slate-500">
                {item.npiMessage}
              </code>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface LastApplyCardProps {
  lastApply: SettingsLastApply | null;
  onRetryStep: (step: RerunStep) => void;
}

/** `settings.last_apply`: what the last apply left blocked or refused, per
 *  `SettingsLastApply`. Renders nothing when the firm has never applied a
 *  setup yet (`lastApply === null`) — `ProfileCard`'s `settings.profile.
 *  incomplete` already covers that case. */
export function LastApplyCard({ lastApply, onRetryStep }: LastApplyCardProps) {
  if (!lastApply) return null;
  const clean = lastApply.gaps.length === 0 && lastApply.blocked.length === 0 && lastApply.failed.length === 0;
  return (
    <Card title={t('settings.last_apply')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">{t('settings.last_apply.at', { date: formatDate(lastApply.appliedAt) })}</p>
        {clean ? (
          <p className="text-sm font-bold text-success-700">{t('settings.last_apply.clean')}</p>
        ) : (
          <>
            <GapsSection gaps={lastApply.gaps} />
            <LeftoverSection titleKey="settings.last_apply.blocked" items={lastApply.blocked} tone="warning" onRetryStep={onRetryStep} />
            <LeftoverSection
              titleKey="settings.last_apply.failed"
              items={lastApply.failed}
              tone="danger"
              showNpiMessage
              onRetryStep={onRetryStep}
            />
          </>
        )}
      </div>
    </Card>
  );
}
