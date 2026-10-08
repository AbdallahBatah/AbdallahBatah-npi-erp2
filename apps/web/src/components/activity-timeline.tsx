'use client';

/**
 * The communication log (CRM Phase 1 · Step 5, spec 4.4): an editor at the top for whoever
 * may write customers, and under it the timeline — grouped by day, newest first.
 *
 * An entry says what happened (note / call / meeting), when and with whom. It can carry
 * files, and can start a follow-up task in the same save. Only its author edits it, and
 * nobody deletes it — the rules are the server's, this file only draws the controls that
 * can work.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { isOpenStage } from '@npi/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { translateError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { AttachmentsCard } from '@/components/attachments';
import { useAssignees, tomorrowKey, todayKey, type Person } from '@/components/follow-up-tasks';
import { useToast } from '@/components/toast';
import { Btn, Field, Modal } from '@/components/ui';
import { Icon } from '@/components/icons';

type ActivityType = 'NOTE' | 'CALL' | 'MEETING';
const TYPES: ActivityType[] = ['NOTE', 'CALL', 'MEETING'];
const TYPE_ICON: Record<ActivityType, string> = { NOTE: 'sticky-note', CALL: 'phone', MEETING: 'users' };
const PAGE = 50;

export interface ActivityRow {
  id: string;
  activityType: ActivityType;
  occurredAt: string;
  body: string;
  createdBy: Person | null;
  contact: { id: string; name: string } | null;
  opportunity: { id: string; code: string; name: string } | null;
  attachmentsCount: number;
}

interface ContactOption {
  id: string;
  name: string;
}

export interface TimelineOpportunity {
  id: string;
  code: string;
  name: string;
  stage: string;
}

interface Page {
  items: ActivityRow[];
  nextCursor: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `<input type="datetime-local">` wants local wall-clock time, not UTC. */
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** The browser's calendar day of an instant — the key entries are grouped by. */
const dayKey = (iso: string) => toLocalInput(new Date(iso)).slice(0, 10);

export function ActivityTimeline({
  customerId,
  opportunityId,
  initial,
  total,
  contacts,
  opportunities,
  writable,
  onChanged,
}: {
  customerId: string;
  /** Pins the log to one opportunity (the opportunity page): lists its entries, files new ones under it. */
  opportunityId?: string;
  /** The latest entries the customer overview already carries, and how many the customer has in all. */
  initial?: ActivityRow[];
  total?: number;
  /** The customer's people. Absent: fetched when the editor is shown. */
  contacts?: ContactOption[];
  /** The customer's opportunities, to file an entry under one (customer page only). */
  opportunities?: TimelineOpportunity[];
  writable: boolean;
  /** The parent reloads what it shows (the tab counts, the task list). */
  onChanged?: () => void;
}) {
  const { t, locale, pick } = useI18n();
  const { user, can } = useAuth();
  const { act, busy } = useAct();
  const toast = useToast();
  const people = useAssignees();
  const [items, setItems] = useState<ActivityRow[] | null>(initial ?? null);
  const [more, setMore] = useState<boolean>(initial ? (total ?? 0) > initial.length : false);
  const [err, setErr] = useState('');
  const [fetchedContacts, setFetchedContacts] = useState<ContactOption[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<ActivityRow | null>(null);

  // editor state
  const [type, setType] = useState<ActivityType>('CALL');
  const [when, setWhen] = useState(() => toLocalInput(new Date()));
  const [contactId, setContactId] = useState('');
  const [oppId, setOppId] = useState('');
  const [body, setBody] = useState('');
  const [withTask, setWithTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState(tomorrowKey);
  const [taskAssignee, setTaskAssignee] = useState('');

  const scope = opportunityId ? `opportunityId=${opportunityId}` : `customerId=${customerId}`;

  // The customer page hands in its overview's entries; they follow the parent's reloads.
  useEffect(() => {
    if (initial) {
      setItems(initial);
      setMore((total ?? 0) > initial.length);
    }
  }, [initial, total]);

  const loadFirst = useCallback(() => {
    setErr('');
    api
      .get<Page>(`/activities?${scope}&take=${PAGE}`)
      .then((p) => {
        setItems(p.items);
        setMore(p.nextCursor !== null);
      })
      .catch((e) => setErr(translateError(e, locale)));
  }, [scope, locale]);

  useEffect(() => {
    if (!initial) loadFirst();
  }, [initial, loadFirst]);

  // The people of the customer, for the "with whom" select.
  useEffect(() => {
    if (contacts || !writable) return;
    api
      .get<ContactOption[]>(`/customers/${customerId}/contacts`)
      .then(setFetchedContacts)
      .catch(() => setFetchedContacts([]));
  }, [contacts, writable, customerId]);
  const contactOptions = contacts ?? fetchedContacts ?? [];
  const oppOptions = (opportunities ?? []).filter((o) => isOpenStage(o.stage));

  /** After any change: reload the first page, and tell the parent (counts, tasks). */
  function refresh() {
    if (initial) onChanged?.();
    else {
      loadFirst();
      onChanged?.();
    }
  }

  async function loadMore() {
    const last = items?.[items.length - 1];
    if (!last) return;
    try {
      const p = await api.get<Page>(`/activities?${scope}&take=${PAGE}&cursor=${last.id}`);
      setItems((cur) => [...(cur ?? []), ...p.items]);
      setMore(p.nextCursor !== null);
    } catch (e) {
      toast.error(translateError(e, locale));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) {
      // The textarea is `required`, but whitespace alone satisfies that.
      toast.error(translateError(new ApiError(400, 'Body is required'), locale));
      return;
    }
    let taskCode = '';
    const ok = await act(
      'saveActivity',
      async () => {
        const res = await api.post<{ activity: ActivityRow; task?: { code: string } }>('/activities', {
          customerId,
          opportunityId: opportunityId || oppId || undefined,
          contactId: contactId || undefined,
          activityType: type,
          occurredAt: new Date(when).toISOString(),
          body: body.trim(),
          followUp: withTask
            ? {
                title: taskTitle.trim() || undefined,
                dueAt: taskDue,
                assigneeId: taskAssignee || undefined,
              }
            : undefined,
        });
        taskCode = res.task?.code ?? '';
      },
      { success: false },
    );
    if (ok) {
      toast.success(taskCode ? t('activities.savedWithTask').replace('{code}', taskCode) : t('activities.saved'));
      setBody('');
      setContactId('');
      setOppId('');
      setWithTask(false);
      setTaskTitle('');
      setTaskAssignee('');
      setTaskDue(tomorrowKey());
      setWhen(toLocalInput(new Date()));
      refresh();
    }
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editRow) return;
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const patch: Record<string, unknown> = {
      activityType: text('activityType'),
      occurredAt: new Date(text('occurredAt')).toISOString(),
      body: text('body'),
      contactId: text('contactId') || null,
    };
    if (await act('editActivity', () => api.patch(`/activities/${editRow.id}`, patch), { success: t('common.done') })) {
      setEditRow(null);
      refresh();
    }
  }

  // ── grouped by day ──
  const groups: Array<{ key: string; rows: ActivityRow[] }> = [];
  for (const row of items ?? []) {
    const key = dayKey(row.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  const today = toLocalInput(new Date()).slice(0, 10);
  const yesterday = toLocalInput(new Date(Date.now() - 86_400_000)).slice(0, 10);
  const dayLabel = (key: string, sample: string) =>
    key === today ? t('activities.today') : key === yesterday ? t('activities.yesterday') : formatDate(sample, locale);

  const canFiles = can('platform.attachment.read');

  return (
    <div className="space-y-5">
      {writable && (
        <form onSubmit={save} className="card p-5" aria-label={t('activities.editor.title')}>
          <h2 className="mb-4 text-sm font-bold text-slate-800">{t('activities.editor.title')}</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <span className="label">{t('activities.type')}</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('activities.type')}>
                {TYPES.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={type === k}
                    onClick={() => setType(k)}
                    className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      type === k ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <Icon name={TYPE_ICON[k]} className="h-4 w-4" />
                    {t(`activities.type.${k}`)}
                  </button>
                ))}
              </div>
            </div>
            <Field label={t('activities.when')}>
              <input type="datetime-local" className="input" dir="ltr" required value={when} max={toLocalInput(new Date())} onChange={(e) => setWhen(e.target.value)} />
            </Field>
            <Field label={`${t('activities.contact')} (${t('common.optional')})`}>
              <select className="input" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">{t('activities.contact.none')}</option>
                {contactOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            {!opportunityId && oppOptions.length > 0 && (
              <Field label={`${t('activities.opportunity')} (${t('common.optional')})`}>
                <select className="input" value={oppId} onChange={(e) => setOppId(e.target.value)}>
                  <option value="">{t('activities.opportunity.none')}</option>
                  {oppOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.code} · {o.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="sm:col-span-2">
              <Field label={t('activities.body')}>
                <textarea
                  className="input min-h-[6rem]"
                  required
                  maxLength={4000}
                  placeholder={t('activities.body.placeholder')}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 sm:col-span-2">
              <input type="checkbox" checked={withTask} onChange={(e) => setWithTask(e.target.checked)} />
              {t('activities.addFollowUp')}
            </label>
            {withTask && (
              <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-solar-200 bg-solar-50/50 p-4 sm:col-span-2 sm:grid-cols-3">
                <legend className="px-2 text-sm font-semibold text-solar-700">{t('activities.addFollowUp')}</legend>
                <Field label={t('activities.followUp.title')} hint={t('activities.followUp.titleHint')}>
                  <input className="input" maxLength={200} value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
                </Field>
                <Field label={t('activities.followUp.due')}>
                  <input type="date" className="input" dir="ltr" required min={todayKey()} value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
                </Field>
                <Field label={t('activities.followUp.assignee')} hint={people.length === 0 ? t('tasks.field.assigneeHint') : undefined}>
                  <select className="input" value={taskAssignee} onChange={(e) => setTaskAssignee(e.target.value)}>
                    <option value="">{t('tasks.me')}</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {pick(p, 'name')}
                      </option>
                    ))}
                  </select>
                </Field>
              </fieldset>
            )}
            <div className="flex items-center justify-between gap-3 sm:col-span-2">
              <p className="text-xs text-slate-500">{t('activities.noDelete')}</p>
              <Btn type="submit" variant="primary" icon="plus" busy={busy('saveActivity')} disabled={busy()}>
                {t('activities.save')}
              </Btn>
            </div>
          </div>
        </form>
      )}

      {err && <p role="alert" className="text-sm text-danger-600">{err}</p>}

      {items === null ? (
        <div className="card space-y-3 p-6" aria-hidden>
          <div className="skeleton h-3.5 w-1/2" />
          <div className="skeleton h-3.5 w-3/4" />
        </div>
      ) : items.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-500">{t('activities.empty')}</div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.key} aria-label={dayLabel(g.key, g.rows[0].occurredAt)}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{dayLabel(g.key, g.rows[0].occurredAt)}</h3>
              <ul className="space-y-2">
                {g.rows.map((a) => (
                  <li key={a.id} className="card p-4">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                        <Icon name={TYPE_ICON[a.activityType]} className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                          <span className="font-bold text-slate-800">{t(`activities.type.${a.activityType}`)}</span>
                          <span title={formatDateTime(a.occurredAt, locale)}>{timeOf(a.occurredAt, locale)}</span>
                          {a.createdBy && <span>{pick(a.createdBy, 'name')}</span>}
                          {a.contact && (
                            <span className="inline-flex items-center gap-1">
                              <Icon name="users" className="h-3 w-3" />
                              {a.contact.name}
                            </span>
                          )}
                          {a.opportunity && !opportunityId && (
                            <Link href={`/opportunities/${a.opportunity.id}`} className="badge bg-brand-50 text-brand-700 hover:underline">
                              {a.opportunity.code} · {a.opportunity.name}
                            </Link>
                          )}
                        </div>
                        <p className="mt-1.5 whitespace-pre-line text-sm leading-7 text-slate-800">{a.body}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                          {canFiles && (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 font-semibold text-slate-600 hover:text-brand-700"
                              aria-expanded={expanded === a.id}
                              onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                            >
                              <Icon name="paperclip" className="h-3.5 w-3.5" />
                              {a.attachmentsCount > 0
                                ? t('activities.filesCount').replace('{n}', String(a.attachmentsCount))
                                : expanded === a.id
                                  ? t('activities.collapse')
                                  : t('activities.expand')}
                            </button>
                          )}
                          {writable && user && a.createdBy?.id === user.id && (
                            <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => setEditRow(a)}>
                              {t('activities.edit')}
                            </button>
                          )}
                        </div>
                        {expanded === a.id && (
                          <div className="mt-3">
                            <AttachmentsCard entityType="ACTIVITY" entityId={a.id} onChange={refresh} />
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {more && (
            <div className="flex justify-center">
              <Btn onClick={loadMore}>{t('activities.more')}</Btn>
            </div>
          )}
        </div>
      )}

      <Modal open={!!editRow} title={t('activities.edit')} onClose={() => setEditRow(null)}>
        {editRow && (
          <form key={editRow.id} onSubmit={saveEdit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('activities.type')}>
              <select name="activityType" className="input" defaultValue={editRow.activityType}>
                {TYPES.map((k) => (
                  <option key={k} value={k}>
                    {t(`activities.type.${k}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('activities.when')}>
              <input
                name="occurredAt"
                type="datetime-local"
                className="input"
                dir="ltr"
                required
                max={toLocalInput(new Date())}
                defaultValue={toLocalInput(new Date(editRow.occurredAt))}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label={`${t('activities.contact')} (${t('common.optional')})`}>
                <select name="contactId" className="input" defaultValue={editRow.contact?.id ?? ''}>
                  <option value="">{t('activities.contact.none')}</option>
                  {contactOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label={t('activities.body')}>
                <textarea name="body" className="input min-h-[6rem]" required maxLength={4000} defaultValue={editRow.body} />
              </Field>
            </div>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Btn onClick={() => setEditRow(null)}>{t('common.cancel')}</Btn>
              <Btn type="submit" variant="primary" busy={busy('editActivity')} disabled={busy()}>
                {t('common.save')}
              </Btn>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

/** The clock time of an instant, in the browser's zone. */
function timeOf(iso: string, locale: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
