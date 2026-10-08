'use client';

/**
 * Follow-up tasks (CRM Phase 1 · Step 5) — the pieces every screen that shows a task
 * shares: the due-date badge, the status badge, the create/edit window, the cancel
 * window, the row actions, and the «المهام» panel of the customer and opportunity pages.
 *
 * The rules are the server's (a due date is a day and cannot be in the past, a closed task
 * is final, cancelling needs a reason); this file only draws the controls that can work.
 */
import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { riyadhDateKey } from '@npi/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { formatDate, formatDay } from '@/lib/format';
import { Btn, EmptyRow, Field, Modal } from '@/components/ui';
import { useToast } from '@/components/toast';
import { Icon } from '@/components/icons';

export interface Person {
  id: string;
  nameAr: string;
  nameEn: string;
}

export interface TaskRow {
  id: string;
  code: string;
  title: string;
  details: string | null;
  dueAt: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  completedAt: string | null;
  cancelReason: string | null;
  dueState: 'OVERDUE' | 'TODAY' | 'UPCOMING' | null;
  daysOverdue: number;
  customer: { id: string; code: string; nameAr: string; nameEn: string };
  opportunity: { id: string; code: string; name: string } | null;
  assignee: Person;
  createdBy: Person | null;
  completedBy: Person | null;
}

export interface OpportunityOption {
  id: string;
  code: string;
  name: string;
}

const DAY_MS = 86_400_000;

/** Today's date in Riyadh as yyyy-mm-dd — what a due date is measured against. */
export const todayKey = () => riyadhDateKey(new Date());
/** The day after, as yyyy-mm-dd. */
export const tomorrowKey = () => new Date(Date.parse(`${todayKey()}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** «متأخرة يوم / يومين / 3 أيام / 11 يوماً» — the counted noun, in both languages. */
export function useLateLabel() {
  const { t } = useI18n();
  return (days: number) => {
    if (days === 1) return t('tasks.due.late1');
    if (days === 2) return t('tasks.due.late2');
    return t(days <= 10 ? 'tasks.due.lateFew' : 'tasks.due.lateMany').replace('{n}', String(days));
  };
}

/** The due day with its state: red when late («متأخرة n يوم»), amber on the day, plain after. */
export function DueBadge({ task }: { task: Pick<TaskRow, 'dueAt' | 'dueState' | 'daysOverdue' | 'status'> }) {
  const { t, locale } = useI18n();
  const late = useLateLabel();
  const date = formatDay(task.dueAt, locale);
  if (task.status === 'OPEN' && task.dueState === 'OVERDUE') {
    return (
      <span className="inline-flex flex-col">
        <span className="badge bg-danger-50 text-danger-700">{late(task.daysOverdue)}</span>
        <span className="mt-0.5 text-xs text-slate-500">{date}</span>
      </span>
    );
  }
  if (task.status === 'OPEN' && task.dueState === 'TODAY') {
    return (
      <span className="inline-flex flex-col">
        <span className="badge bg-warning-50 text-warning-700">{t('tasks.due.today')}</span>
        <span className="mt-0.5 text-xs text-slate-500">{date}</span>
      </span>
    );
  }
  return <span className="text-xs text-slate-700">{date}</span>;
}

const STATUS_CLS: Record<TaskRow['status'], string> = {
  OPEN: 'bg-info-50 text-info-700',
  DONE: 'bg-success-50 text-success-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
};

/** Local to tasks: the shared StatusBadge's «مفتوح» is masculine and has no «منجزة». */
export function TaskStatusBadge({ status }: { status: TaskRow['status'] }) {
  const { t } = useI18n();
  return <span className={`badge ${STATUS_CLS[status]}`}>{t(`tasks.status.${status}`)}</span>;
}

/**
 * The people a task may be given to: the active users of the organization, from the
 * tasks module's own list (it needs only the key to create tasks — not user administration).
 * "Me" is left out; the form offers it as the default.
 */
export function useAssignees(): Person[] {
  const { can, user } = useAuth();
  const [people, setPeople] = useState<Person[]>([]);
  const canList = can('crm.customer.write');
  useEffect(() => {
    if (!canList) return;
    api
      .get<Person[]>('/tasks/assignees')
      .then((rows) => setPeople(rows.filter((r) => r.id !== user?.id)))
      .catch(() => setPeople([]));
  }, [canList, user?.id]);
  return people;
}

// ── create / edit ───────────────────────────────────────────────────────────

export function TaskFormModal({
  open,
  onClose,
  task,
  customerId,
  opportunityId,
  opportunities,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Given: edit this task. Absent: create one for `customerId`. */
  task?: TaskRow | null;
  customerId?: string;
  /** Pins the new task to this opportunity (the opportunity page). */
  opportunityId?: string;
  /** Offered when creating from the customer page. */
  opportunities?: OpportunityOption[];
  onSaved: () => void;
}) {
  const { t, pick } = useI18n();
  const { user } = useAuth();
  const { act, busy } = useAct();
  const toast = useToast();
  const people = useAssignees();
  const [err, setErr] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    if (!text('title')) {
      setErr(t('tasks.field.title'));
      return;
    }
    setErr('');
    if (task) {
      const body: Record<string, string> = {};
      if (text('title') !== task.title) body.title = text('title');
      if (text('details') !== (task.details ?? '')) body.details = text('details');
      if (text('dueAt') && text('dueAt') !== task.dueAt.slice(0, 10)) body.dueAt = text('dueAt');
      if (text('assigneeId') && text('assigneeId') !== task.assignee.id) body.assigneeId = text('assigneeId');
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      if (await act('saveTask', () => api.patch(`/tasks/${task.id}`, body), { success: t('common.done') })) {
        onClose();
        onSaved();
      }
      return;
    }
    let code = '';
    const ok = await act(
      'saveTask',
      async () => {
        const made = await api.post<{ code: string }>('/tasks', {
          customerId,
          opportunityId: opportunityId || text('opportunityId') || undefined,
          title: text('title'),
          details: text('details') || undefined,
          dueAt: text('dueAt'),
          assigneeId: text('assigneeId') || undefined,
        });
        code = made.code;
      },
      { success: false },
    );
    if (ok) {
      toast.success(t('tasks.created').replace('{code}', code));
      onClose();
      onSaved();
    }
  }

  return (
    <Modal open={open} title={task ? t('tasks.edit') : t('tasks.new')} onClose={onClose}>
      <form key={`${task?.id ?? 'new'}:${open}`} onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label={t('tasks.field.title')} error={err}>
            <input name="title" className="input" maxLength={200} defaultValue={task?.title ?? ''} onChange={() => setErr('')} />
          </Field>
        </div>
        <Field label={t('tasks.field.due')}>
          <input
            name="dueAt"
            type="date"
            className="input"
            dir="ltr"
            required
            // An overdue task keeps its date unless the user picks another; a new date may not be past.
            min={task && task.dueState === 'OVERDUE' ? undefined : todayKey()}
            defaultValue={task ? task.dueAt.slice(0, 10) : tomorrowKey()}
          />
        </Field>
        <Field label={t('tasks.field.assignee')} hint={people.length === 0 ? t('tasks.field.assigneeHint') : undefined}>
          <select name="assigneeId" className="input" defaultValue={task?.assignee.id ?? user?.id ?? ''}>
            {task && task.assignee.id !== user?.id && !people.some((p) => p.id === task.assignee.id) && (
              <option value={task.assignee.id}>{pick(task.assignee, 'name')}</option>
            )}
            {user && <option value={user.id}>{t('tasks.me')}</option>}
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {pick(p, 'name')}
              </option>
            ))}
          </select>
        </Field>
        {!task && !opportunityId && opportunities && opportunities.length > 0 && (
          <div className="sm:col-span-2">
            <Field label={`${t('tasks.field.opportunity')} (${t('common.optional')})`}>
              <select name="opportunityId" className="input" defaultValue="">
                <option value="">{t('activities.opportunity.none')}</option>
                {opportunities.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} · {o.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        <div className="sm:col-span-2">
          <Field label={`${t('tasks.field.details')} (${t('common.optional')})`}>
            <textarea name="details" className="input min-h-[5rem]" maxLength={4000} defaultValue={task?.details ?? ''} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Btn onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn type="submit" variant="primary" busy={busy('saveTask')} disabled={busy()}>
            {t('common.save')}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

// ── row actions: done / cancel / edit ──────────────────────────────────────

/** «تم»، «إلغاء»، «تعديل» for an OPEN task — drawn only for someone who may write customers. */
export function TaskActions({
  task,
  onChanged,
  canWrite,
  opportunities,
}: {
  task: TaskRow;
  onChanged: () => void;
  canWrite: boolean;
  opportunities?: OpportunityOption[];
}) {
  const { t } = useI18n();
  const { act, busy } = useAct();
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');

  if (!canWrite || task.status !== 'OPEN') return null;

  async function complete() {
    if (await act('completeTask', () => api.post(`/tasks/${task.id}/complete`), { success: t('tasks.completed') })) onChanged();
  }

  async function cancel(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setReasonErr(t('tasks.cancel.reason'));
      return;
    }
    const ok = await act('cancelTask', () => api.post(`/tasks/${task.id}/cancel`, { reason: reason.trim() }), {
      success: t('tasks.cancelled'),
    });
    if (ok) {
      setCancelOpen(false);
      setReason('');
      onChanged();
    }
  }

  return (
    <>
      <span className="flex flex-wrap justify-end gap-2">
        <Btn sm variant="success" icon="check" busy={busy('completeTask')} disabled={busy()} onClick={complete}>
          {t('tasks.complete')}
        </Btn>
        <Btn sm onClick={() => setEditOpen(true)} disabled={busy()}>
          {t('common.edit')}
        </Btn>
        <Btn
          sm
          variant="danger"
          disabled={busy()}
          onClick={() => {
            setReason('');
            setReasonErr('');
            setCancelOpen(true);
          }}
        >
          {t('tasks.cancel')}
        </Btn>
      </span>

      <TaskFormModal open={editOpen} onClose={() => setEditOpen(false)} task={task} opportunities={opportunities} onSaved={onChanged} />

      <Modal open={cancelOpen} title={`${t('tasks.cancel.title')} — ${task.code}`} onClose={() => setCancelOpen(false)}>
        <form onSubmit={cancel} className="grid grid-cols-1 gap-4">
          <p className="rounded-lg bg-warning-50 p-3 text-xs text-warning-900">{t('tasks.cancel.warn')}</p>
          <Field label={t('tasks.cancel.reason')} error={reasonErr}>
            <textarea
              className="input min-h-[5rem]"
              maxLength={1000}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonErr('');
              }}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="danger" busy={busy('cancelTask')} disabled={busy()}>
              {t('tasks.cancel.confirm')}
            </Btn>
          </div>
        </form>
      </Modal>
    </>
  );
}

// ── the «المهام» tab ────────────────────────────────────────────────────────

const CLOSED_SHOWN = 20;

/**
 * The tasks of one customer or one opportunity: the open ones (with their actions), a
 * «+ مهمة» button, and a collapsed «المنجزة والملغاة» section fetched when opened.
 * The customer page hands in the open tasks it already loaded; the opportunity page
 * lets the panel fetch its own.
 */
export function FollowUpTasksPanel({
  customerId,
  opportunityId,
  openTasks,
  opportunities,
  writable,
  onChanged,
}: {
  customerId: string;
  opportunityId?: string;
  /** From the customer overview. Absent: the panel fetches `GET /tasks?opportunityId=`. */
  openTasks?: TaskRow[];
  opportunities?: OpportunityOption[];
  writable: boolean;
  /** The parent reloads what it shows (counts, the overview). */
  onChanged?: () => void;
}) {
  const { t, pick } = useI18n();
  const [own, setOwn] = useState<TaskRow[] | null>(null);
  const [closed, setClosed] = useState<TaskRow[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [version, setVersion] = useState(0);

  const scope = opportunityId ? `opportunityId=${opportunityId}` : `customerId=${customerId}`;

  // The opportunity page: one request brings the open and the closed tasks together.
  useEffect(() => {
    if (openTasks) return;
    api
      .get<TaskRow[]>(`/tasks?${scope}&status=ALL`)
      .then((rows) => {
        setOwn(rows.filter((r) => r.status === 'OPEN'));
        setClosed(rows.filter((r) => r.status !== 'OPEN').slice(0, CLOSED_SHOWN));
      })
      .catch(() => {
        setOwn([]);
        setClosed([]);
      });
  }, [openTasks, scope, version]);

  // The customer page: the closed ones are fetched when the section is opened.
  useEffect(() => {
    if (!openTasks || !showClosed) return;
    api
      .get<TaskRow[]>(`/tasks?${scope}&status=ALL`)
      .then((rows) => setClosed(rows.filter((r) => r.status !== 'OPEN').slice(0, CLOSED_SHOWN)))
      .catch(() => setClosed([]));
  }, [openTasks, showClosed, scope, version]);

  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    onChanged?.();
  }, [onChanged]);

  const rows = openTasks ?? own;
  const withOpp = !opportunityId;

  const head = [
    t('tasks.col.code'),
    t('tasks.col.title'),
    t('tasks.col.due'),
    t('tasks.col.assignee'),
    ...(withOpp ? [t('tasks.col.opportunity')] : []),
    '',
  ];

  return (
    <div>
      <div className="mb-3 flex justify-end">
        {writable && (
          <Btn variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
            {t('tasks.new')}
          </Btn>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              {head.map((h, i) => (
                <th key={i} scope="col" className="th">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows === null ? (
              <EmptyRow colSpan={head.length} text={t('common.loading')} />
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={head.length} text={t('tasks.empty')} />
            ) : (
              rows.map((k) => (
                <tr key={k.id} className="align-top hover:bg-slate-50">
                  <td className="td font-mono text-xs">{k.code}</td>
                  <td className="td">
                    <div className="font-medium">{k.title}</div>
                    {k.details && <div className="mt-0.5 whitespace-pre-line text-xs text-slate-500">{k.details}</div>}
                  </td>
                  <td className="td">
                    <DueBadge task={k} />
                  </td>
                  <td className="td text-xs">{pick(k.assignee, 'name')}</td>
                  {withOpp && (
                    <td className="td text-xs">
                      {k.opportunity ? (
                        <Link href={`/opportunities/${k.opportunity.id}`} className="text-brand-700 hover:underline">
                          {k.opportunity.code}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  )}
                  <td className="td">
                    <TaskActions task={k} canWrite={writable} onChanged={changed} opportunities={opportunities} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-900"
          aria-expanded={showClosed}
          onClick={() => setShowClosed((v) => !v)}
        >
          <Icon name="chevron-end" className={`h-4 w-4 transition ${showClosed ? 'rotate-90' : 'rtl:-scale-x-100'}`} />
          {t('tasks.closed')}
        </button>
        {showClosed && (
          <div className="card mt-2 overflow-hidden">
            {closed === null ? (
              <p className="p-4 text-xs text-slate-500">{t('common.loading')}</p>
            ) : closed.length === 0 ? (
              <p className="p-4 text-center text-xs text-slate-500">{t('tasks.closed.empty')}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {closed.map((k) => (
                  <ClosedTaskRow key={k.id} task={k} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <TaskFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        customerId={customerId}
        opportunityId={opportunityId}
        opportunities={opportunities}
        onSaved={changed}
      />
    </div>
  );
}

function ClosedTaskRow({ task }: { task: TaskRow }): ReactNode {
  const { t, locale, pick } = useI18n();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-500">{task.code}</span>
          <span className="font-medium text-slate-700">{task.title}</span>
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          {task.status === 'DONE' && task.completedBy
            ? t('tasks.closed.done').replace('{name}', pick(task.completedBy, 'name'))
            : task.status === 'CANCELLED' && task.cancelReason
              ? t('tasks.closed.cancelled').replace('{reason}', task.cancelReason)
              : ''}
          {task.completedAt && <> · {formatDate(task.completedAt, locale)}</>}
        </div>
      </div>
      <TaskStatusBadge status={task.status} />
    </li>
  );
}
