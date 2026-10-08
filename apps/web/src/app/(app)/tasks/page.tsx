'use client';

/**
 * مهام المتابعة — the follow-up task list (CRM Phase 1 · Step 5).
 *
 * «مهامي» (default) shows the caller's open tasks; «مهام الفريق» shows everybody's.
 * The filters cut on Riyadh days: late, due today, this week, all. A link from a
 * notification or the inbox arrives as `?focus=<id>`: that row is marked and scrolled to
 * (a task that is closed, or not in the current scope, is shown in its own card).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { Btn, EmptyRow, LoadError, PageHeader, TableSkeleton } from '@/components/ui';
import { DueBadge, TaskActions, TaskStatusBadge, type TaskRow } from '@/components/follow-up-tasks';

type Scope = 'mine' | 'team';
type Due = 'all' | 'overdue' | 'today' | 'week';
const DUE_FILTERS: Due[] = ['overdue', 'today', 'week', 'all'];

export default function TasksPage() {
  const { t, pick, locale } = useI18n();
  const { user, can } = useAuth();
  const canWrite = can('crm.customer.write');
  const [scope, setScope] = useState<Scope>('mine');
  const [due, setDue] = useState<Due>('all');
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const [err, setErr] = useState('');
  const [focusId, setFocusId] = useState('');
  const [focusTask, setFocusTask] = useState<TaskRow | null>(null);
  const focusRef = useRef<HTMLTableRowElement>(null);

  // The task a notification pointed at: read once, on arrival.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('focus');
    if (!id) return;
    setFocusId(id);
    api
      .get<TaskRow>(`/tasks/${id}`)
      .then((task) => {
        setFocusTask(task);
        // Somebody else's task cannot be among «مهامي»: look at the team's.
        if (user && task.assignee.id !== user.id) setScope('team');
      })
      .catch(() => setFocusTask(null));
  }, [user]);

  const load = useCallback(() => {
    setErr('');
    const q = new URLSearchParams({ status: 'OPEN', due });
    if (scope === 'mine') q.set('mine', '1');
    api
      .get<TaskRow[]>(`/tasks?${q.toString()}`)
      .then(setRows)
      .catch((e) => setErr(translateError(e, locale)));
  }, [scope, due, locale]);
  useEffect(load, [load]);

  // Scroll the marked row into view once it is on screen.
  useEffect(() => {
    if (rows && focusId) focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [rows, focusId]);

  const inList = !!focusTask && !!rows?.some((r) => r.id === focusTask.id);

  return (
    <div>
      <PageHeader
        title={t('tasks.title')}
        subtitle={t('tasks.hint')}
        action={
          <Btn variant="ghost" icon="refresh" onClick={load}>
            {t('common.refresh')}
          </Btn>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1 text-sm font-semibold" role="group" aria-label={t('tasks.scope.mine')}>
          {(['mine', 'team'] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
              className={`rounded-lg px-4 py-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                scope === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t(`tasks.scope.${s}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('tasks.col.due')}>
          {DUE_FILTERS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={due === d}
              onClick={() => setDue(d)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                due === d ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              {t(`tasks.filter.${d}`)}
            </button>
          ))}
        </div>
      </div>

      {/* A task that is closed (or filtered out) still answers the link that pointed at it. */}
      {focusTask && !inList && rows && (
        <div className="card mb-4 border-brand-200 bg-brand-50/40 p-4 text-sm" role="status">
          <div className="mb-1 text-xs font-semibold text-brand-700">{t('tasks.focused')}</div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs">{focusTask.code}</span>
            <span className="font-medium">{focusTask.title}</span>
            <TaskStatusBadge status={focusTask.status} />
            <Link href={`/customers/${focusTask.customer.id}?tab=tasks`} className="text-brand-700 hover:underline">
              {focusTask.customer.code} · {pick(focusTask.customer, 'name')}
            </Link>
          </div>
        </div>
      )}

      {err ? (
        <LoadError message={err} onRetry={load} />
      ) : (
        <div className="card overflow-hidden">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="th">{t('tasks.col.due')}</th>
                <th scope="col" className="th">{t('tasks.col.code')}</th>
                <th scope="col" className="th">{t('tasks.col.title')}</th>
                <th scope="col" className="th">{t('tasks.col.customer')}</th>
                <th scope="col" className="th">{t('tasks.col.opportunity')}</th>
                <th scope="col" className="th">{t('tasks.col.assignee')}</th>
                <th scope="col" className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows === null && <TableSkeleton cols={7} />}
              {rows?.length === 0 && <EmptyRow colSpan={7} text={due === 'all' ? t('tasks.empty') : t('tasks.empty.filter')} />}
              {rows?.map((k) => {
                const marked = k.id === focusId;
                return (
                  <tr
                    key={k.id}
                    ref={marked ? focusRef : undefined}
                    aria-current={marked ? 'true' : undefined}
                    className={`align-top ${marked ? 'bg-brand-50 ring-2 ring-inset ring-brand-300' : 'hover:bg-slate-50'}`}
                  >
                    <td className="td"><DueBadge task={k} /></td>
                    <td className="td font-mono text-xs">{k.code}</td>
                    <td className="td">
                      <div className="font-medium">{k.title}</div>
                      {k.details && <div className="mt-0.5 whitespace-pre-line text-xs text-slate-500">{k.details}</div>}
                    </td>
                    <td className="td text-xs">
                      <Link href={`/customers/${k.customer.id}?tab=tasks`} className="text-brand-700 hover:underline">
                        {k.customer.code} · {pick(k.customer, 'name')}
                      </Link>
                    </td>
                    <td className="td text-xs">
                      {k.opportunity ? (
                        <Link href={`/opportunities/${k.opportunity.id}`} className="text-brand-700 hover:underline">
                          {k.opportunity.code}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="td text-xs">{pick(k.assignee, 'name')}</td>
                    <td className="td">
                      <TaskActions task={k} canWrite={canWrite} onChanged={load} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
