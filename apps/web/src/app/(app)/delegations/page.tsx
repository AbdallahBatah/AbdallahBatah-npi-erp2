'use client';

/**
 * Temporary delegations — the register of who may sign for whom, and until
 * when. The rules card is not decoration: a delegation is the one control in
 * the system that hands one person another's authority, and an administrator
 * who does not know it lends a *role* (never a permission), never chains, and
 * never covers the delegator's own documents will grant the wrong thing.
 *
 * There is no edit: a granted window is evidence. It is ended by revoking it,
 * which leaves the original dates readable, and a different window is a new row.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import {
  Btn,
  EmptyRow,
  Field,
  LoadError,
  Modal,
  PageHeader,
  PageSkeleton,
  Tabs,
  useConfirm,
} from '@/components/ui';
import { Icon } from '@/components/icons';

type DelegationState = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'REVOKED';

interface DirectoryUser {
  id: string;
  nameAr: string;
  nameEn: string;
  email: string;
  isActive: boolean;
  departmentId: string | null;
  role: { id: string; key: string; nameAr: string; nameEn: string };
}

interface Delegation {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  isActive: boolean;
  state: DelegationState;
  fromUser: {
    id: string;
    nameAr: string;
    nameEn: string;
    isActive: boolean;
    role: { id: string; nameAr: string; nameEn: string };
  };
  toUser: { id: string; nameAr: string; nameEn: string; isActive: boolean };
  createdBy: { id: string; nameAr: string; nameEn: string } | null;
}

const STATE_CLS: Record<DelegationState, string> = {
  ACTIVE: 'bg-success-50 text-success-700',
  SCHEDULED: 'bg-info-50 text-info-700',
  EXPIRED: 'bg-slate-100 text-slate-500',
  REVOKED: 'bg-slate-100 text-slate-500',
};
const STATE_DOT: Record<DelegationState, string> = {
  ACTIVE: 'bg-success-500',
  SCHEDULED: 'bg-info-500',
  EXPIRED: 'bg-slate-400',
  REVOKED: 'bg-slate-400',
};

/** The day the user picked, read as their own midnight and end of day. */
const startOfDay = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const endOfDay = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

export default function DelegationsPage() {
  const { t, locale, pick } = useI18n();
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const [rows, setRows] = useState<Delegation[] | null>(null);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTab] = useState<'current' | 'past'>('current');

  const [open, setOpen] = useState(false);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    setLoadErr('');
    Promise.all([
      api.get<Delegation[]>('/admin/delegations'),
      api.get<DirectoryUser[]>('/admin/delegations/directory'),
    ])
      .then(([d, u]) => {
        setRows(d);
        setPeople(u);
      })
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [locale]);
  useEffect(load, [load]);

  const activePeople = useMemo(() => people.filter((p) => p.isActive), [people]);
  const current = useMemo(
    () => (rows ?? []).filter((r) => r.state === 'ACTIVE' || r.state === 'SCHEDULED'),
    [rows],
  );
  const past = useMemo(
    () => (rows ?? []).filter((r) => r.state === 'EXPIRED' || r.state === 'REVOKED'),
    [rows],
  );

  function openCreate() {
    const today = new Date().toISOString().slice(0, 10);
    setFromId('');
    setToId('');
    setStarts(today);
    setEnds('');
    setReason('');
    setOpen(true);
  }

  async function submit() {
    const ok = await act('dlg', () =>
      api.post('/admin/delegations', {
        fromUserId: fromId,
        toUserId: toId,
        startsAt: startOfDay(starts),
        // Inclusive last day: a window ending "on the 10th" must still cover a
        // signature made on the afternoon of the 10th.
        endsAt: endOfDay(ends),
        reason: reason.trim() || undefined,
      }),
    );
    if (ok) {
      setOpen(false);
      load();
    }
  }

  async function revoke(d: Delegation) {
    const yes = await confirm({
      title: t('dlg.revokeTitle'),
      message: `${t('dlg.revokeMsg')} (${pick(d.fromUser, 'name')} → ${pick(d.toUser, 'name')})`,
      danger: true,
    });
    if (!yes) return;
    if (await act(`revoke:${d.id}`, () => api.post(`/admin/delegations/${d.id}/revoke`))) load();
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!rows) return <PageSkeleton stats={0} />;

  const shown = tab === 'current' ? current : past;

  return (
    <div>
      <PageHeader
        title={t('dlg.title')}
        action={
          <Btn variant="primary" icon="plus" onClick={openCreate} disabled={activePeople.length < 2}>
            {t('dlg.new')}
          </Btn>
        }
      />
      <p className="-mt-3 mb-5 text-xs text-slate-500">{t('dlg.hint')}</p>

      {/* The guarantees, stated where the grant is made rather than in a manual. */}
      <div className="card mb-5 p-4">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <Icon name="lock" className="h-3.5 w-3.5 text-slate-400" />
          {t('dlg.rules')}
        </p>
        <ul className="grid gap-1.5 text-xs leading-5 text-slate-500 sm:grid-cols-2">
          {['roleOnly', 'window', 'noChain', 'noSelfApprove', 'recorded'].map((k) => (
            <li key={k} className="flex items-start gap-1.5">
              <Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-success-600" />
              {t(`dlg.rule.${k}`)}
            </li>
          ))}
        </ul>
      </div>

      <Tabs
        tabs={[
          { key: 'current', label: t('dlg.tab.current'), count: current.length },
          { key: 'past', label: t('dlg.tab.past'), count: past.length },
        ]}
        value={tab}
        onChange={(k) => setTab(k as 'current' | 'past')}
      />

      <div className="card overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="th">{t('dlg.from')}</th>
              <th scope="col" className="th">{t('dlg.role')}</th>
              <th scope="col" className="th">{t('dlg.to')}</th>
              <th scope="col" className="th">{t('dlg.window')}</th>
              <th scope="col" className="th">{t('dlg.reason')}</th>
              <th scope="col" className="th">{t('common.status')}</th>
              <th scope="col" className="th text-end">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.length === 0 ? (
              <EmptyRow colSpan={7} text={t('dlg.empty')} />
            ) : (
              shown.map((d) => (
                <tr key={d.id} className={tab === 'past' ? 'bg-slate-50/60 [&_td]:text-slate-500' : ''}>
                  <td className="td font-semibold text-slate-800">{pick(d.fromUser, 'name')}</td>
                  <td className="td text-xs">
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                      {pick(d.fromUser.role, 'name')}
                    </span>
                  </td>
                  <td className="td font-semibold text-slate-800">{pick(d.toUser, 'name')}</td>
                  <td className="td whitespace-nowrap text-xs">
                    {formatDate(d.startsAt, locale)} — {formatDate(d.endsAt, locale)}
                  </td>
                  <td className="td max-w-xs text-xs">
                    {d.reason || <span className="text-slate-400">—</span>}
                  </td>
                  <td className="td">
                    <span className={`badge ${STATE_CLS[d.state]}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[d.state]}`} />
                      {t(`dlg.state.${d.state}`)}
                    </span>
                    {d.createdBy && (
                      <div className="mt-1 text-xs text-slate-400">
                        {t('dlg.createdBy')}: {pick(d.createdBy, 'name')}
                      </div>
                    )}
                  </td>
                  <td className="td">
                    <div className="flex justify-end">
                      {d.isActive && d.state !== 'EXPIRED' && (
                        <Btn
                          sm
                          variant="danger"
                          busy={busy(`revoke:${d.id}`)}
                          disabled={busy()}
                          onClick={() => revoke(d)}
                        >
                          {t('dlg.revoke')}
                        </Btn>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={open}
        title={t('dlg.new')}
        onClose={() => setOpen(false)}
        dirty={!!fromId || !!toId || !!ends || reason.trim() !== ''}
      >
        <form
          className="grid gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('dlg.from')}
              hint={
                fromId
                  ? `${t('dlg.role')}: ${pick(
                      activePeople.find((p) => p.id === fromId)?.role ?? {},
                      'name',
                    )}`
                  : undefined
              }
            >
              <select
                className="input"
                required
                value={fromId}
                onChange={(e) => {
                  setFromId(e.target.value);
                  // Otherwise picking the delegate first and the delegator
                  // second leaves a self-delegation selected but unlisted.
                  if (e.target.value === toId) setToId('');
                }}
              >
                <option value="">—</option>
                {activePeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {pick(p, 'name')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('dlg.to')}>
              <select
                className="input"
                required
                value={toId}
                onChange={(e) => setToId(e.target.value)}
              >
                <option value="">—</option>
                {/* Self-delegation is a no-op that reads like a real transfer
                    of authority, so it is not offered (and the server refuses). */}
                {activePeople
                  .filter((p) => p.id !== fromId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {pick(p, 'name')}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('dlg.starts')}>
              <input
                type="date"
                className="input"
                dir="ltr"
                required
                value={starts}
                onChange={(e) => setStarts(e.target.value)}
              />
            </Field>
            <Field label={t('dlg.ends')}>
              <input
                type="date"
                className="input"
                dir="ltr"
                required
                min={starts || undefined}
                value={ends}
                onChange={(e) => setEnds(e.target.value)}
              />
            </Field>
          </div>

          <Field label={t('dlg.reason')} hint={t('dlg.reasonHint')}>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>

          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
            {t('dlg.noOverlap')}
          </p>

          <div className="flex justify-end gap-2">
            <Btn onClick={() => setOpen(false)}>{t('common.cancel')}</Btn>
            <Btn
              type="submit"
              variant="primary"
              busy={busy('dlg')}
              disabled={busy() || !fromId || !toId || !starts || !ends}
            >
              {t('common.create')}
            </Btn>
          </div>
        </form>
      </Modal>

      {confirmNode}
    </div>
  );
}
