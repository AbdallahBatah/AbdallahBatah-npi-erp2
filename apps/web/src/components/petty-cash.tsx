'use client';

/**
 * Package 6 · P6-2 (ADR-06) — «العُهدة». Mounted under /payables (the
 * accountant: open, fund, take back, close) and /projects (the custodian:
 * settle his spending per project and budget line; the projects GM reads the
 * settlement he signs). The server narrows a custodian to his own custodies.
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate, formatMoney } from '@/lib/format';
import { useLookup } from '@/lib/lookups';
import { PageHeader, StatusBadge, EmptyRow, LoadError, Modal, Field, Btn, TableSkeleton, PageSkeleton } from '@/components/ui';
import { ApprovalBanner, type ApprovalRequestView } from '@/components/approvals';
import { Icon } from '@/components/icons';

interface Person { id: string; nameAr: string; nameEn: string }
interface Custody {
  id: string;
  code: string;
  status: string;
  balance: string;
  notes: string | null;
  custodianId: string;
  custodian: Person | null;
  createdAt: string;
}
interface Movement {
  id: string;
  code: string;
  kind: 'FUND' | 'SETTLEMENT' | 'RETURN';
  status: string;
  amount: string;
  memo: string | null;
  decisionNote: string | null;
  createdAt: string;
  pendingApproval: ApprovalRequestView | null;
  lines: Array<{
    id: string;
    description: string;
    amount: string;
    spentOn: string;
    project: { id: string; code: string };
    wbsElement: { code: string; nameAr: string; nameEn: string } | null;
  }>;
}
interface Detail extends Custody {
  available: number;
  movements: Movement[];
}
interface Named { id: string; code: string; nameAr: string; nameEn: string }
interface DraftLine { projectId: string; wbsElementId: string; description: string; amount: string; spentOn: string }

const today = () => new Date().toISOString().slice(0, 10);

export function CustodyList({ base }: { base: string }) {
  const { t, locale, pick } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const { act, busy } = useAct();
  const [rows, setRows] = useState<Custody[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const users = useLookup<Person>('users', { enabled: open });

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<Custody[]>('/petty-cash')
      .then(setRows)
      .catch((e) => setErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [locale]);
  useEffect(load, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let id: string | null = null;
    const ok = await act('create', async () => {
      const c = await api.post<{ id: string }>('/petty-cash', {
        custodianId: String(f.get('custodianId') || ''),
        notes: String(f.get('notes') || '').trim() || undefined,
      });
      id = c.id;
    });
    if (ok && id) router.push(`${base}/${id}`);
  }

  return (
    <div>
      <PageHeader
        title={t('pc.title')}
        subtitle={t('pc.hint')}
        action={
          can('finance.payment.write') ? (
            <Btn variant="primary" icon="plus" onClick={() => setOpen(true)}>
              {t('pc.new')}
            </Btn>
          ) : undefined
        }
      />
      {err && <LoadError message={err} onRetry={load} />}
      <div className="card table-sticky">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('common.code')}</th>
              <th scope="col" className="th">{t('pc.custodian')}</th>
              <th scope="col" className="th text-end">{t('pc.balance')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <TableSkeleton cols={4} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={4} text={t('common.none')} />
            ) : (
              rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="td">
                    <Link href={`${base}/${c.id}`} className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                      {c.code}
                    </Link>
                  </td>
                  <td className="td">{c.custodian ? pick(c.custodian, 'name') : '—'}</td>
                  <td className="td-num">{formatMoney(c.balance, locale)}</td>
                  <td className="td">
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Modal open={open} title={t('pc.new')} onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <Field label={t('pc.custodian')}>
            <select name="custodianId" className="input" required disabled={users.state !== 'ready'}>
              <option value="">—</option>
              {users.rows.map((u) => (
                <option key={u.id} value={u.id}>
                  {pick(u, 'name')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`${t('leads.notes')} (${t('common.optional')})`}>
            <textarea name="notes" className="input" rows={2} maxLength={1000} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('create')} disabled={busy()}>
              {t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function CustodyDetail({ id, base }: { id: string; base: string }) {
  const { t, locale, pick } = useI18n();
  const { user, can } = useAuth();
  const { act, busy } = useAct();
  const [c, setC] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [cashOpen, setCashOpen] = useState<'fund' | 'return' | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [wbsByProject, setWbsByProject] = useState<Record<string, Named[]>>({});
  const projects = useLookup<Named>('projects', { enabled: settleOpen });

  const load = useCallback(() => {
    api
      .get<Detail>(`/petty-cash/${id}`)
      .then(setC)
      .catch((e) => setErr(translateError(e, locale)));
  }, [id, locale]);
  useEffect(load, [load]);

  if (err && !c) return <LoadError message={err} onRetry={load} />;
  if (!c) return <PageSkeleton stats={2} />;
  const finance = can('finance.payment.write');
  const mine = c.custodianId === user?.id;
  const open = c.status === 'OPEN';

  const wbsFor = (projectId: string) => {
    if (!projectId || wbsByProject[projectId]) return;
    api
      .get<{ wbsElements: Named[] }>(`/projects/${projectId}`)
      .then((p) => setWbsByProject((m) => ({ ...m, [projectId]: p.wbsElements })))
      .catch(() => setWbsByProject((m) => ({ ...m, [projectId]: [] })));
  };
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function cash(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await act('cash', () =>
      api.post(`/petty-cash/${id}/${cashOpen}`, {
        amount: Number(f.get('amount')),
        memo: String(f.get('memo') || '').trim() || undefined,
      }),
    );
    if (ok) {
      setCashOpen(null);
      load();
    }
  }

  async function settle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const used = lines.filter((l) => l.projectId && Number(l.amount) > 0 && l.description.trim());
    if (used.length === 0) return;
    const ok = await act('settle', () =>
      api.post(`/petty-cash/${id}/settle`, {
        lines: used.map((l) => ({
          projectId: l.projectId,
          wbsElementId: l.wbsElementId || undefined,
          description: l.description.trim(),
          amount: Number(l.amount),
          spentOn: l.spentOn,
        })),
      }),
    );
    if (ok) {
      setSettleOpen(false);
      load();
    }
  }

  const settleTotal = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${t('pc.one')} ${c.code}`}
        subtitle={c.custodian ? pick(c.custodian, 'name') : undefined}
        backHref={base}
        backLabel={t('pc.title')}
        action={
          open ? (
            <div className="flex flex-wrap gap-2">
              {mine && (
                <Btn
                  variant="primary"
                  icon="receipt"
                  onClick={() => {
                    setLines([{ projectId: '', wbsElementId: '', description: '', amount: '', spentOn: today() }]);
                    setSettleOpen(true);
                  }}
                >
                  {t('pc.settle')}
                </Btn>
              )}
              {finance && !mine && (
                <>
                  <Btn icon="plus" onClick={() => setCashOpen('fund')}>
                    {t('pc.fund')}
                  </Btn>
                  <Btn onClick={() => setCashOpen('return')}>{t('pc.return')}</Btn>
                  <Btn busy={busy('close')} disabled={busy() || Number(c.balance) > 0} onClick={() => act('close', () => api.post(`/petty-cash/${id}/close`)).then((ok) => ok && load())}>
                    {t('pc.close')}
                  </Btn>
                </>
              )}
            </div>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('pc.balance')}</p>
          <p className="mt-1 text-2xl font-bold">{formatMoney(c.balance, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('pc.available')}</p>
          <p className="mt-1 text-2xl font-bold text-brand-700">{formatMoney(c.available, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500">{t('common.status')}</p>
          <div className="mt-2">
            <StatusBadge status={c.status} />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {c.movements.length === 0 ? (
          <p className="text-sm text-slate-500">{t('common.none')}</p>
        ) : (
          c.movements.map((m) => (
            <div key={m.id} className="card p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold">{m.code}</span>
                <span className="badge bg-slate-100 text-slate-700">{t(`pc.kind.${m.kind}`)}</span>
                <StatusBadge status={m.status} />
                <span className={`font-semibold ${m.kind === 'FUND' ? 'text-success-700' : 'text-slate-800'}`}>
                  {m.kind === 'FUND' ? '+' : '−'}
                  {formatMoney(m.amount, locale)}
                </span>
                <span className="ms-auto text-xs text-slate-400">{formatDate(m.createdAt, locale)}</span>
              </div>
              {m.memo && <p className="mt-1 text-xs text-slate-600">{m.memo}</p>}
              {m.decisionNote && <p className="mt-1 text-xs text-danger-700">{m.decisionNote}</p>}
              {m.lines.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                  {m.lines.map((l) => (
                    <li key={l.id}>
                      {formatDate(l.spentOn, locale)} · {l.project.code}
                      {l.wbsElement ? ` / ${l.wbsElement.code}` : ''} — {l.description}: {formatMoney(l.amount, locale)}
                    </li>
                  ))}
                </ul>
              )}
              {m.pendingApproval && (
                <div className="mt-3">
                  <ApprovalBanner request={m.pendingApproval} />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <Modal open={!!cashOpen} title={cashOpen === 'fund' ? t('pc.fund') : t('pc.return')} onClose={() => setCashOpen(null)}>
        <form onSubmit={cash} className="space-y-4">
          <p className="text-xs text-slate-500">{cashOpen === 'fund' ? t('pc.fundJournal') : t('pc.returnJournal')}</p>
          <Field label={t('vpr.amount')}>
            <input type="number" name="amount" min={0.01} step="0.01" max={cashOpen === 'return' ? c.available : undefined} className="input w-40" required />
          </Field>
          <Field label={`${t('leads.notes')} (${t('common.optional')})`}>
            <input name="memo" className="input" maxLength={500} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setCashOpen(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('cash')} disabled={busy()}>
              {t('common.save')}
            </Btn>
          </div>
        </form>
      </Modal>

      <Modal open={settleOpen} title={t('pc.settle')} onClose={() => setSettleOpen(false)}>
        <form onSubmit={settle} className="space-y-4">
          <p className="text-xs text-slate-500">{t('pc.settleHint')}</p>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-6">
                <select
                  aria-label={t('mr.project')}
                  className="input sm:col-span-2"
                  value={l.projectId}
                  onChange={(e) => {
                    setLine(i, { projectId: e.target.value, wbsElementId: '' });
                    wbsFor(e.target.value);
                  }}
                >
                  <option value="">{t('mr.project')} —</option>
                  {projects.rows.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t('mr.budgetLine')}
                  className="input sm:col-span-2"
                  value={l.wbsElementId}
                  onChange={(e) => setLine(i, { wbsElementId: e.target.value })}
                  disabled={!l.projectId}
                >
                  <option value="">{t('mr.budgetLine')} —</option>
                  {(wbsByProject[l.projectId] ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} · {pick(w, 'name')}
                    </option>
                  ))}
                </select>
                <input type="date" aria-label={t('common.date')} className="input sm:col-span-2" value={l.spentOn} max={today()} onChange={(e) => setLine(i, { spentOn: e.target.value })} />
                <input aria-label={t('pc.description')} placeholder={t('pc.description')} className="input sm:col-span-4" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                <div className="flex items-center gap-2 sm:col-span-2">
                  <input type="number" min={0.01} step="0.01" aria-label={t('vpr.amount')} placeholder={t('vpr.amount')} className="input" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} />
                  <button type="button" aria-label={t('proposals.removeLine')} className="rounded-md p-1.5 text-slate-500 hover:bg-danger-50" onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, x) => x !== i) : p))}>
                    <Icon name="x" className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="btn-ghost text-xs" onClick={() => setLines((p) => [...p, { projectId: '', wbsElementId: '', description: '', amount: '', spentOn: today() }])}>
              + {t('proposals.addLine')}
            </button>
            <span className={settleTotal > c.available ? 'text-danger-700' : ''}>
              {formatMoney(settleTotal, locale)} / {formatMoney(c.available, locale)}
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setSettleOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('settle')} disabled={busy() || settleTotal <= 0 || settleTotal > c.available}>
              {t('exe.sendForApproval')}
            </Btn>
          </div>
        </form>
      </Modal>
    </div>
  );
}
