'use client';

/**
 * The seven company role presets and the five proposed approval rules
 * (ADR-02 §3-4, task 9). Each preset is shown against the organization's
 * role of its key — created, same or different, the keys added and removed,
 * the active users it changes at once, the sidebar it gives, its
 * separation-of-duties pairs and what would refuse it today — and applied
 * one at a time by the owner's click after a confirmation that repeats the
 * diff. The five rules are applied together, below. Nothing moves a user:
 * the owner gives each user one role from the users form.
 *
 * Under /admin, so the page guard (screenForPath) already asks for
 * admin.user.manage; applying the rules also needs admin.approval.manage.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  APPROVAL_DOCUMENT_META,
  PERMISSION_CATALOG,
  ROLE_PRESETS,
  type ApprovalDocumentType,
} from '@npi/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { Btn, LoadError, Modal, PageHeader, PageSkeleton } from '@/components/ui';
import { Icon } from '@/components/icons';

// ── the API's shapes (apps/api/src/modules/admin/role-presets.service.ts) ──

type PresetStatus = 'create' | 'same' | 'differs';
type RuleStatus = PresetStatus | 'blocked';
interface Name {
  nameAr: string;
  nameEn: string;
}
interface SeatRule {
  id: string;
  documentType: string;
  minAmount: number;
  maxAmount: number | null;
}
type PresetBlock = { code: 'LAST_ADMIN' } | { code: 'APPROVAL_SEAT'; rules: SeatRule[]; openRequests: number };
interface PresetDiff {
  key: string;
  status: PresetStatus;
  roleId: string | null;
  currentName: Name | null;
  proposedName: Name;
  renamed: boolean;
  currentCount: number | null;
  permissions: string[];
  added: string[];
  removed: string[];
  screens: number;
  totalScreens: number;
  affectedUsers: Array<Name & { id: string; email: string; primary: boolean }>;
  sodConflicts: Array<{ a: string; b: string; labelAr: string; labelEn: string }>;
  blockedBy: PresetBlock[];
}
interface NamedRole {
  key: string;
  nameAr: string | null;
  nameEn: string | null;
}
type RuleBlock =
  | { code: 'ROLE_MISSING'; role: string }
  | { code: 'ROLE_LACKS_KEY'; role: string; permission: string }
  | { code: 'ROLE_NO_USERS'; role: string };
interface RuleDiff {
  documentType: ApprovalDocumentType;
  minAmount: number;
  maxAmount: number | null;
  steps: Array<NamedRole & { roleId: string | null }>;
  status: RuleStatus;
  current: Array<{ id: string; minAmount: number; maxAmount: number | null; steps: NamedRole[] }>;
  change: { update: string | null; deactivate: string[] } | null;
  blockedBy: RuleBlock[];
}
interface Overview {
  presets: PresetDiff[];
  rules: RuleDiff[];
}
type RuleOutcome =
  | { documentType: ApprovalDocumentType; outcome: 'same' }
  | { documentType: ApprovalDocumentType; outcome: 'blocked'; blockedBy: RuleBlock[] }
  | { documentType: ApprovalDocumentType; outcome: 'created'; ruleId: string }
  | { documentType: ApprovalDocumentType; outcome: 'updated'; ruleId: string; deactivated: string[] }
  | { documentType: ApprovalDocumentType; outcome: 'failed'; error: string; deactivated: string[] };

/** The accountant note (A6) appears when the preset takes at least this many keys off the role. */
const LARGE_NARROWING = 10;

const PERM_LABEL = new Map(PERMISSION_CATALOG.map((p) => [p.key as string, p]));
const PRESET_NAME = new Map(ROLE_PRESETS.map((p) => [p.key as string, p]));

const STATUS_CLS: Record<RuleStatus, string> = {
  create: 'bg-brand-50 text-brand-700',
  same: 'bg-success-50 text-success-700',
  differs: 'bg-warning-50 text-warning-800',
  blocked: 'bg-danger-50 text-danger-700',
};

/** Fills `{n}`-style placeholders, the way the other admin strings take them. */
const fill = (s: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), s);

export default function RolePresetsPage() {
  const { t, locale } = useI18n();
  const { can, refresh } = useAuth();
  const { act, busy } = useAct();
  const ar = locale === 'ar';
  const approvalManage = can('admin.approval.manage');

  const [data, setData] = useState<Overview | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [confirmPreset, setConfirmPreset] = useState<PresetDiff | null>(null);
  const [confirmRules, setConfirmRules] = useState(false);
  const [outcomes, setOutcomes] = useState<RuleOutcome[] | null>(null);

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Overview>('/admin/role-presets')
      .then(setData)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  const name = (n: Name) => (ar ? n.nameAr : n.nameEn);
  const permLabel = (key: string) => {
    const p = PERM_LABEL.get(key);
    return p ? (ar ? p.labelAr : p.labelEn) : key;
  };
  const docLabel = (d: ApprovalDocumentType) => {
    const m = APPROVAL_DOCUMENT_META[d];
    return m ? (ar ? m.labelAr : m.labelEn) : d;
  };
  /** A role as a rule names it: its name in the organization, else the preset's, else the key. */
  const roleLabel = (r: NamedRole) => {
    const own = ar ? r.nameAr : r.nameEn;
    if (own) return own;
    const p = PRESET_NAME.get(r.key);
    return p ? (ar ? p.nameAr : p.nameEn) : r.key;
  };
  const chain = (steps: NamedRole[]) => steps.map(roleLabel).join(ar ? ' ← ' : ' → ');
  const band = (min: number, max: number | null) => {
    if (min === 0 && max === null) return t('preset.rules.fromZero');
    if (max === null) return fill(t('preset.rules.from'), { min: formatNumber(min, locale) });
    return fill(t('preset.rules.between'), {
      min: formatNumber(min, locale),
      max: formatNumber(max, locale),
    });
  };

  function presetBlockText(b: PresetBlock): string {
    if (b.code === 'LAST_ADMIN') return t('preset.block.lastAdmin');
    // The sentence the role editor shows for the same refusal (lib/errors.ts).
    return translateError(
      new ApiError(400, 'Role signs in an approval rule', {
        code: 'APPROVAL_SEAT',
        rules: b.rules,
        openRequests: b.openRequests,
      }),
      locale,
    );
  }
  function ruleBlockText(b: RuleBlock): string {
    const named = data?.rules.flatMap((r) => r.steps).find((s) => s.key === b.role);
    const label = roleLabel(named ?? { key: b.role, nameAr: null, nameEn: null });
    if (b.code === 'ROLE_MISSING') return fill(t('preset.rule.block.missing'), { role: label });
    if (b.code === 'ROLE_LACKS_KEY') {
      return fill(t('preset.rule.block.lacksKey'), { role: label, perm: permLabel(b.permission) });
    }
    return fill(t('preset.rule.block.noUsers'), { role: label });
  }

  // Both applies answer with the fresh preview, which replaces the page's;
  // a refused one re-reads it, since the refusal may come from a change made
  // elsewhere since the page loaded.
  async function applyPreset(p: PresetDiff) {
    const res: { body?: Overview } = {};
    const ok = await act(
      `preset:${p.key}`,
      async () => {
        res.body = await api.post<Overview & { applied: boolean }>(`/admin/role-presets/${p.key}/apply`);
      },
      { success: t('preset.applied') },
    );
    setConfirmPreset(null);
    if (ok && res.body) setData({ presets: res.body.presets, rules: res.body.rules });
    else load();
    // An administrator who holds the role (as an extra one) sees the effect at once.
    if (ok) void refresh();
  }

  async function applyRules() {
    const res: { body?: Overview & { outcomes: RuleOutcome[] } } = {};
    const ok = await act(
      'rules',
      async () => {
        res.body = await api.post<Overview & { outcomes: RuleOutcome[] }>('/admin/role-presets/approval-rules/apply');
      },
      { success: t('preset.rules.applied') },
    );
    setConfirmRules(false);
    if (ok && res.body) {
      setOutcomes(res.body.outcomes);
      setData({ presets: res.body.presets, rules: res.body.rules });
    } else load();
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!data) return <PageSkeleton stats={0} />;

  const rulesToApply = data.rules.filter((r) => r.status === 'create' || r.status === 'differs');

  return (
    <div>
      <PageHeader
        title={t('preset.title')}
        subtitle={t('preset.subtitle')}
        backHref="/admin#roles"
        backLabel={t('nav.admin')}
      />

      {/* The order the guards impose (ADR-02 §3-4, hard rule 8). */}
      <section className="card mb-6 p-5" aria-labelledby="preset-order">
        <h2 id="preset-order" className="text-sm font-bold text-slate-900">
          {t('preset.order.title')}
        </h2>
        <ol className="mt-3 grid gap-3 md:grid-cols-3">
          {(['preset.order.1', 'preset.order.2', 'preset.order.3'] as const).map((k, i) => (
            <li key={k} className="flex items-start gap-3 text-sm text-slate-800">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700">
                {formatNumber(i + 1, locale)}
              </span>
              <span className="pt-1 leading-6">{t(k)}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs leading-5 text-slate-600">{t('preset.order.hint')}</p>
      </section>

      <h2 className="mb-3 text-base font-bold text-slate-900">{t('preset.section.roles')}</h2>
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {data.presets.map((p) => (
          <PresetCard
            key={p.key}
            p={p}
            ar={ar}
            t={t}
            locale={locale}
            name={name}
            permLabel={permLabel}
            blockText={presetBlockText}
            busy={busy(`preset:${p.key}`)}
            disabled={busy()}
            onApply={() => setConfirmPreset(p)}
          />
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900">{t('preset.section.rules')}</h2>
        <Btn
          variant="primary"
          icon="check"
          busy={busy('rules')}
          disabled={!approvalManage || rulesToApply.length === 0 || busy()}
          title={
            !approvalManage
              ? t('preset.rules.noManage')
              : rulesToApply.length === 0
                ? t('preset.rules.nothing')
                : undefined
          }
          onClick={() => setConfirmRules(true)}
        >
          {t('preset.rules.apply')}
        </Btn>
      </div>
      <section className="card overflow-hidden">
        <p className="border-b border-slate-100 px-5 py-3 text-xs leading-5 text-slate-600">
          {t('preset.rules.hint')}
          {!approvalManage && <span className="ms-1 font-semibold text-danger-700">{t('preset.rules.noManage')}</span>}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2 text-start font-semibold">{t('preset.rules.document')}</th>
                <th className="px-4 py-2 text-start font-semibold">{t('preset.rules.current')}</th>
                <th className="px-4 py-2 text-start font-semibold">{t('preset.rules.proposed')}</th>
                <th className="px-4 py-2 text-start font-semibold">{t('preset.rules.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rules.map((r) => (
                <tr key={r.documentType} className="align-top">
                  <td className="px-4 py-3 font-semibold text-slate-900">{docLabel(r.documentType)}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {r.current.length === 0 ? (
                      <span className="text-slate-500">{t('preset.rules.none')}</span>
                    ) : (
                      <ul className="space-y-1">
                        {r.current.map((c) => (
                          <li key={c.id}>
                            <span className="font-medium">{band(c.minAmount, c.maxAmount)}</span>
                            {': '}
                            {chain(c.steps)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <span className="font-medium">{band(r.minAmount, r.maxAmount)}</span>
                    {': '}
                    {chain(r.steps)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={r.status} t={t} />
                    {r.blockedBy.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 text-xs leading-5 text-danger-700">
                        {r.blockedBy.map((b, i) => (
                          <li key={i}>{ruleBlockText(b)}</li>
                        ))}
                      </ul>
                    )}
                    {r.change && r.status !== 'blocked' && (
                      <p className="mt-1.5 text-xs leading-5 text-slate-600">{ruleChangeText(r)}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {outcomes && (
        <section className="card mt-4 p-5" aria-live="polite">
          <h3 className="text-sm font-bold text-slate-900">{t('preset.outcome.title')}</h3>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {outcomes.map((o) => (
              <li key={o.documentType}>
                <span className="font-semibold">{docLabel(o.documentType)}</span>
                {': '}
                {outcomeText(o)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirmPreset && (
        <Modal open title={fill(t('preset.confirm.title'), { name: name(confirmPreset.proposedName) })} onClose={() => setConfirmPreset(null)}>
          <PresetConfirm p={confirmPreset} t={t} locale={locale} name={name} permLabel={permLabel} ar={ar} />
          <div className="mt-6 flex items-center justify-end gap-2">
            <Btn onClick={() => setConfirmPreset(null)}>{t('common.cancel')}</Btn>
            <Btn
              variant={confirmPreset.removed.length > 0 && confirmPreset.affectedUsers.length > 0 ? 'danger' : 'primary'}
              icon="check"
              busy={busy(`preset:${confirmPreset.key}`)}
              onClick={() => applyPreset(confirmPreset)}
            >
              {t('preset.apply')}
            </Btn>
          </div>
        </Modal>
      )}

      {confirmRules && (
        <Modal open title={t('preset.rules.confirm.title')} onClose={() => setConfirmRules(false)}>
          <p className="text-sm leading-6 text-slate-700">{t('preset.rules.confirm.msg')}</p>
          <ul className="mt-3 space-y-2 text-sm text-slate-800">
            {data.rules.map((r) => (
              <li key={r.documentType} className="rounded-lg border border-slate-100 px-3 py-2">
                <span className="font-semibold">{docLabel(r.documentType)}</span>
                {' — '}
                {r.status === 'same'
                  ? t('preset.rules.leaveSame')
                  : r.status === 'blocked'
                    ? `${t('preset.rules.skip')}: ${r.blockedBy.map(ruleBlockText).join('؛ ')}`
                    : `${ruleChangeText(r)} (${band(r.minAmount, r.maxAmount)}: ${chain(r.steps)})`}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-5 text-slate-600">{t('preset.rules.confirm.inflight')}</p>
          <div className="mt-6 flex items-center justify-end gap-2">
            <Btn onClick={() => setConfirmRules(false)}>{t('common.cancel')}</Btn>
            <Btn variant="primary" icon="check" busy={busy('rules')} onClick={applyRules}>
              {t('preset.rules.apply')}
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );

  function ruleChangeText(r: RuleDiff): string {
    if (!r.change) return t('preset.rules.leaveSame');
    if (r.change.update === null) return t('preset.rules.willCreate');
    const n = r.change.deactivate.length;
    return n === 0
      ? t('preset.rules.willUpdate')
      : fill(t('preset.rules.willUpdateDeactivate'), { n: formatNumber(n, locale) });
  }

  function outcomeText(o: RuleOutcome): string {
    switch (o.outcome) {
      case 'created':
        return t('preset.outcome.created');
      case 'updated':
        return o.deactivated.length
          ? fill(t('preset.outcome.updatedDeactivated'), { n: formatNumber(o.deactivated.length, locale) })
          : t('preset.outcome.updated');
      case 'same':
        return t('preset.outcome.same');
      case 'blocked':
        return `${t('preset.outcome.blocked')}: ${o.blockedBy.map(ruleBlockText).join('؛ ')}`;
      default:
        return `${t('preset.outcome.failed')}: ${translateError(new ApiError(400, o.error), locale)}`;
    }
  }
}

function StatusPill({ status, t }: { status: RuleStatus; t: (k: string) => string }) {
  return <span className={`badge ${STATUS_CLS[status]}`}>{t(`preset.status.${status}`)}</span>;
}

/** One preset against the organization's role of its key. */
function PresetCard({
  p,
  ar,
  t,
  locale,
  name,
  permLabel,
  blockText,
  busy,
  disabled,
  onApply,
}: {
  p: PresetDiff;
  ar: boolean;
  t: (k: string) => string;
  locale: 'ar' | 'en';
  name: (n: Name) => string;
  permLabel: (key: string) => string;
  blockText: (b: PresetBlock) => string;
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
}) {
  const blocked = p.blockedBy.length > 0;
  const status: RuleStatus = blocked ? 'blocked' : p.status;
  return (
    <article className="card flex flex-col gap-3 p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-slate-500" dir="ltr">
            {p.key}
          </p>
          <h3 className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-bold text-slate-900">
            {p.currentName && p.renamed ? (
              <>
                <span className="text-slate-500 line-through decoration-slate-300">{name(p.currentName)}</span>
                <Icon name="chevron-end" className="h-3.5 w-3.5 text-slate-400 rtl:-scale-x-100" />
                <span>{name(p.proposedName)}</span>
              </>
            ) : (
              <span>{name(p.proposedName)}</span>
            )}
            {!p.currentName && <span className="text-xs font-medium text-brand-700">({t('preset.newRole')})</span>}
          </h3>
        </div>
        <StatusPill status={status} t={t} />
      </header>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1">
          <Icon name="eye" className="h-3.5 w-3.5" />
          {fill(t('preset.screens'), { n: formatNumber(p.screens, locale), total: formatNumber(p.totalScreens, locale) })}
        </span>
        <span className="inline-flex items-center gap-1">
          <Icon name="users" className="h-3.5 w-3.5" />
          {p.currentName
            ? fill(t('preset.users'), { n: formatNumber(p.affectedUsers.length, locale) })
            : t('preset.users.newRole')}
        </span>
      </p>

      <DiffLists p={p} t={t} permLabel={permLabel} />

      {p.affectedUsers.length > 0 && (
        <p className="text-xs leading-5 text-slate-600">
          {p.affectedUsers
            .map((u) => `${ar ? u.nameAr : u.nameEn}${u.primary ? '' : ` ${t('preset.users.extra')}`}`)
            .join(ar ? '، ' : ', ')}
        </p>
      )}

      {p.key === 'accountant' && p.removed.length >= LARGE_NARROWING && p.currentCount !== null && (
        <Note tone="warning" icon="alert-triangle">
          {fill(t('preset.accountantNote'), {
            from: formatNumber(p.currentCount, locale),
            to: formatNumber(p.permissions.length, locale),
          })}
        </Note>
      )}

      {p.sodConflicts.length > 0 && (
        <Note tone="warning" icon="alert-triangle">
          <span className="font-semibold">{t('preset.sod')}</span>{' '}
          {p.sodConflicts.map((c) => (ar ? c.labelAr : c.labelEn)).join(ar ? '، ' : ', ')}
          {'. '}
          {t('preset.sod.hint')}
        </Note>
      )}

      {blocked && (
        <Note tone="danger" icon="lock">
          <ul className="space-y-1">
            {p.blockedBy.map((b) => (
              <li key={b.code}>{blockText(b)}</li>
            ))}
          </ul>
        </Note>
      )}

      <footer className="mt-auto flex items-center justify-end pt-1">
        <Btn
          variant="primary"
          sm
          icon="check"
          busy={busy}
          disabled={disabled || blocked || p.status === 'same'}
          title={p.status === 'same' ? t('preset.status.same') : undefined}
          onClick={onApply}
        >
          {t('preset.apply')}
        </Btn>
      </footer>
    </article>
  );
}

/** The keys a preset adds and takes away, by the catalogue's labels. */
function DiffLists({
  p,
  t,
  permLabel,
}: {
  p: PresetDiff;
  t: (k: string) => string;
  permLabel: (key: string) => string;
}) {
  if (p.status === 'same') return <p className="text-xs text-success-700">{t('preset.sameNote')}</p>;
  if (p.added.length === 0 && p.removed.length === 0) {
    return <p className="text-xs text-slate-600">{t('preset.renameOnly')}</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {p.added.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-success-700">
            {t('preset.added')} ({p.added.length})
          </p>
          <ul className="mt-1 space-y-0.5 text-xs leading-5 text-slate-700">
            {p.added.map((k) => (
              <li key={k}>
                <span className="font-bold text-success-700">+ </span>
                {permLabel(k)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.removed.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-danger-700">
            {t('preset.removed')} ({p.removed.length})
          </p>
          <ul className="mt-1 space-y-0.5 text-xs leading-5 text-slate-700">
            {p.removed.map((k) => (
              <li key={k}>
                <span className="font-bold text-danger-700">− </span>
                {permLabel(k)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The confirmation's body: the diff again, the rename, and whom it changes. */
function PresetConfirm({
  p,
  t,
  locale,
  name,
  permLabel,
  ar,
}: {
  p: PresetDiff;
  t: (k: string) => string;
  locale: 'ar' | 'en';
  name: (n: Name) => string;
  permLabel: (key: string) => string;
  ar: boolean;
}) {
  return (
    <div className="space-y-3 text-sm leading-6 text-slate-700">
      {p.currentName ? (
        p.renamed && (
          <p>
            {fill(t('preset.confirm.rename'), { from: name(p.currentName), to: name(p.proposedName) })}
          </p>
        )
      ) : (
        <p>{fill(t('preset.confirm.create'), { name: name(p.proposedName) })}</p>
      )}
      <DiffLists p={p} t={t} permLabel={permLabel} />
      <p className="font-semibold text-slate-900">
        {p.affectedUsers.length > 0
          ? fill(t('preset.confirm.users'), { n: formatNumber(p.affectedUsers.length, locale) })
          : t('preset.confirm.noUsers')}
      </p>
      {p.affectedUsers.length > 0 && (
        <p className="text-xs text-slate-600">
          {p.affectedUsers.map((u) => (ar ? u.nameAr : u.nameEn)).join(ar ? '، ' : ', ')}
        </p>
      )}
      {p.sodConflicts.length > 0 && <p className="text-xs text-warning-800">{t('preset.confirm.sod')}</p>}
      <p className="text-xs text-slate-500">{t('preset.confirm.audit')}</p>
    </div>
  );
}

function Note({ tone, icon, children }: { tone: 'warning' | 'danger'; icon: string; children: ReactNode }) {
  const cls =
    tone === 'danger'
      ? 'border-danger-200 bg-danger-50/60 text-danger-800'
      : 'border-warning-200 bg-warning-50/60 text-warning-900';
  return (
    <div role="note" className={`flex items-start gap-2 rounded-xl border p-3 text-xs leading-5 ${cls}`}>
      <Icon name={icon} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
