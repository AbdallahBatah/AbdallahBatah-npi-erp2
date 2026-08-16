'use client';

/**
 * The administrator's half of package و: the amount bands and the signature
 * chain attached to each.
 *
 * The role dropdown is filtered client-side to roles that hold the document
 * type's write permission and have at least one active user — the same two
 * conditions the server enforces. Offering an ineligible role and then
 * rejecting the save would be a worse way to teach the same rule.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { Btn, EmptyRow, LoadError, Modal, TableSkeleton, useConfirm } from '@/components/ui';
import { Icon } from '@/components/icons';

interface DocMeta {
  value: string;
  labelAr: string;
  labelEn: string;
  permission: string;
  amountLabelAr: string;
  amountLabelEn: string;
}
interface RuleStep {
  sequence: number;
  roleId: string;
  role: { id: string; key: string; nameAr: string; nameEn: string };
}
interface Rule {
  id: string;
  documentType: string;
  minAmount: string;
  maxAmount: string | null;
  isActive: boolean;
  steps: RuleStep[];
  _count: { requests: number };
}
interface RoleRow {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
  permissions: string[];
  _count: { users: number };
}

export function ApprovalMatrixCard({ roles }: { roles: RoleRow[] }) {
  const { locale, t } = useI18n();
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();
  const ar = locale === 'ar';

  const [rules, setRules] = useState<Rule[] | null>(null);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [err, setErr] = useState('');

  // rule modal
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Rule | null>(null);
  const [docType, setDocType] = useState('');
  const [min, setMin] = useState('0');
  const [max, setMax] = useState('');
  const [active, setActive] = useState(true);
  const [stepRoles, setStepRoles] = useState<string[]>([]);

  const load = useCallback(() => {
    setErr('');
    Promise.all([api.get<Rule[]>('/approvals/rules'), api.get<DocMeta[]>('/approvals/documents')])
      .then(([r, d]) => {
        setRules(r);
        setDocs(d);
      })
      .catch((e) => setErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  const docMeta = useMemo(() => new Map(docs.map((d) => [d.value, d])), [docs]);

  /** Roles that could actually sign this document type. */
  const eligible = useMemo(() => {
    const perm = docMeta.get(docType)?.permission;
    if (!perm) return [];
    return roles.filter((r) => r.permissions.includes(perm) && r._count.users > 0);
  }, [roles, docType, docMeta]);

  function openCreate() {
    setEdit(null);
    setDocType(docs[0]?.value ?? '');
    setMin('0');
    setMax('');
    setActive(true);
    setStepRoles([]);
    setOpen(true);
  }
  function openEdit(r: Rule) {
    setEdit(r);
    setDocType(r.documentType);
    setMin(String(Number(r.minAmount)));
    setMax(r.maxAmount === null ? '' : String(Number(r.maxAmount)));
    setActive(r.isActive);
    setStepRoles(r.steps.map((s) => s.roleId));
    setOpen(true);
  }

  async function submit() {
    const body = {
      minAmount: Number(min || 0),
      maxAmount: max.trim() === '' ? null : Number(max),
      isActive: active,
      steps: stepRoles.map((roleId) => ({ roleId })),
    };
    const ok = edit
      ? await act('rule', () => api.patch(`/approvals/rules/${edit.id}`, body))
      : await act('rule', () => api.post('/approvals/rules', { ...body, documentType: docType }));
    if (ok) {
      setOpen(false);
      load();
    }
  }

  async function remove(r: Rule) {
    const yes = await confirm({
      title: t('apr.rule.deleteTitle'),
      message: t('apr.rule.deleteMsg'),
      danger: true,
    });
    if (!yes) return;
    if (await act(`delRule:${r.id}`, () => api.del(`/approvals/rules/${r.id}`))) load();
  }

  if (err) return <LoadError message={err} onRetry={load} />;

  const band = (r: Rule) =>
    `${formatMoney(Number(r.minAmount), locale)} — ${
      r.maxAmount === null ? t('apr.rule.andAbove') : formatMoney(Number(r.maxAmount), locale)
    }`;

  return (
    <>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div className="max-w-2xl">
            <p className="text-xs leading-6 text-slate-500">{t('apr.rule.hint')}</p>
            <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-5 text-slate-400">
              <Icon name="lock" className="mt-0.5 h-3 w-3 shrink-0" />
              {t('apr.rule.selfApproval')}
            </p>
          </div>
          <Btn variant="primary" sm icon="plus" onClick={openCreate} disabled={docs.length === 0}>
            {t('apr.rule.new')}
          </Btn>
        </div>

        {!rules ? (
          <TableSkeleton cols={5} />
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">{t('apr.rule.docType')}</th>
                <th className="th">{t('apr.rule.band')}</th>
                <th className="th">{t('apr.rule.steps')}</th>
                <th className="th">{t('common.status')}</th>
                <th className="th text-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rules.length === 0 ? (
                <EmptyRow colSpan={5} text={t('apr.rule.empty')} />
              ) : (
                rules.map((r) => {
                  const meta = docMeta.get(r.documentType);
                  return (
                    <tr key={r.id} className={r.isActive ? '' : 'bg-slate-50/60 text-slate-400'}>
                      <td className="td font-semibold text-slate-800">
                        {meta ? (ar ? meta.labelAr : meta.labelEn) : r.documentType}
                        <div className="text-[11px] font-normal text-slate-400">
                          {meta ? (ar ? meta.amountLabelAr : meta.amountLabelEn) : ''}
                        </div>
                      </td>
                      <td className="td whitespace-nowrap text-xs">{band(r)}</td>
                      <td className="td">
                        <div className="flex flex-wrap items-center gap-1">
                          {r.steps.map((s, i) => (
                            <span key={s.sequence} className="flex items-center gap-1">
                              {i > 0 && (
                                <Icon name="chevron-end" className="h-3 w-3 text-slate-300 rtl:-scale-x-100" />
                              )}
                              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                                {ar ? s.role.nameAr : s.role.nameEn}
                              </span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="td">
                        <span
                          className={`badge ${
                            r.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${r.isActive ? 'bg-emerald-500' : 'bg-slate-400'}`}
                          />
                          {r.isActive ? t('apr.rule.active') : t('apr.rule.inactive')}
                        </span>
                        {r._count.requests > 0 && (
                          <div className="mt-1 text-[11px] text-slate-400">
                            {/* "count: N", not "N nouns" — Arabic numeral
                                agreement changes the noun by count band. */}
                            {t('apr.rule.used')}: {r._count.requests}
                          </div>
                        )}
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-1.5 text-[11px]">
                          <Btn sm onClick={() => openEdit(r)}>
                            {t('common.edit')}
                          </Btn>
                          <Btn
                            sm
                            icon="trash"
                            className="!text-rose-600"
                            busy={busy(`delRule:${r.id}`)}
                            disabled={busy()}
                            onClick={() => remove(r)}
                          >
                            {t('apr.rule.delete')}
                          </Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={open} title={edit ? t('apr.rule.edit') : t('apr.rule.new')} onClose={() => setOpen(false)}>
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            submit();
          }}
        >
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600">{t('apr.rule.docType')}</span>
            <select
              className="input"
              required
              // The document type decides which roles are eligible, so changing
              // it after steps are chosen would leave an invalid chain behind.
              disabled={!!edit}
              value={docType}
              onChange={(e) => {
                setDocType(e.target.value);
                setStepRoles([]);
              }}
            >
              {docs.map((d) => (
                <option key={d.value} value={d.value}>
                  {ar ? d.labelAr : d.labelEn}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-slate-400">
              {docMeta.get(docType) ? (ar ? docMeta.get(docType)!.amountLabelAr : docMeta.get(docType)!.amountLabelEn) : ''}
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('apr.rule.min')}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                className="input font-mono"
                dir="ltr"
                required
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-slate-600">{t('apr.rule.max')}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                className="input font-mono"
                dir="ltr"
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-slate-400">{t('apr.rule.maxHint')}</span>
            </label>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">{t('apr.rule.steps')}</span>
              <Btn
                sm
                icon="plus"
                disabled={eligible.length === 0 || stepRoles.length >= eligible.length}
                onClick={() => setStepRoles([...stepRoles, ''])}
              >
                {t('apr.rule.addStep')}
              </Btn>
            </div>
            <p className="mb-2 text-[11px] leading-5 text-slate-400">{t('apr.rule.stepsHint')}</p>

            {eligible.length === 0 ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t('apr.rule.noEligibleRoles')}
              </p>
            ) : (
              <div className="grid gap-2">
                {stepRoles.map((roleId, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-500">
                      {i + 1}
                    </span>
                    <select
                      className="input flex-1"
                      required
                      value={roleId}
                      onChange={(e) => {
                        const next = [...stepRoles];
                        next[i] = e.target.value;
                        setStepRoles(next);
                      }}
                    >
                      <option value="">—</option>
                      {eligible
                        // A role signing twice is one signature wearing two hats.
                        .filter((r) => r.id === roleId || !stepRoles.includes(r.id))
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {ar ? r.nameAr : r.nameEn}
                          </option>
                        ))}
                    </select>
                    <Btn
                      sm
                      icon="trash"
                      className="!text-rose-600"
                      onClick={() => setStepRoles(stepRoles.filter((_, j) => j !== i))}
                    >
                      {t('common.delete')}
                    </Btn>
                  </div>
                ))}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {t('apr.rule.active')}
          </label>

          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn
              type="submit"
              variant="primary"
              busy={busy('rule')}
              disabled={busy() || stepRoles.length === 0 || stepRoles.some((r) => !r)}
            >
              {edit ? t('common.save') : t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>

      {confirmNode}
    </>
  );
}
