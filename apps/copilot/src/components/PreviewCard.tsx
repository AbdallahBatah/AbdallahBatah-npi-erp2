'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Pencil } from 'lucide-react';
import { t } from '@/i18n/ar';
import { formatNumber } from '@/i18n/format';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DocumentChip } from '@/components/DocumentChip';
import { WaitingIndicator } from '@/components/chat/WaitingIndicator';
import type { IntakeView, PreviewChoice, PreviewField, PreviewLineRow } from '@/intake/types';

export interface PreviewCardProps {
  view: IntakeView;
  /** An action is in flight: every control is disabled. */
  busy: boolean;
  /** The last action's failure (Arabic), cleared by the parent on success. */
  errorAr: string | null;
  onConfirm(path: string): void;
  onSet(path: string, value: string): void;
  onChoose(target: string, choice: string): void;
  onEdit(text: string): void;
  onApprove(): void;
  onCancel(): void;
}

// ─── Layout switch ──────────────────────────────────────────────────────────

const DESKTOP_QUERY = '(min-width: 768px)';

function subscribeDesktop(onChange: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function desktopSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** One layout is rendered, never both (a hidden duplicate would double every
 *  field in the DOM — and in the accessibility tree). The card only mounts on
 *  the client after its data arrived, so the server snapshot is never shown. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
}

// ─── One field ──────────────────────────────────────────────────────────────

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
const TEXTAREA_THRESHOLD = 60;

/** The raw value the inline editor starts from. */
function rawValue(field: PreviewField): string {
  if (field.value === null) return '';
  if (Array.isArray(field.value)) return field.value.join(';');
  return String(field.value);
}

interface FieldBodyProps {
  field: PreviewField;
  readOnly: boolean;
  busy: boolean;
  onConfirm(path: string): void;
  onSet(path: string, value: string): void;
}

/** Value, status, warnings and the inline editor of one leaf. Shared by the
 *  definition-list rows and the table cells. */
function FieldBody({ field, readOnly, busy, onConfirm, onSet }: FieldBodyProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const evidenceTitle =
    field.evidence !== null && field.evidence.length > 0
      ? field.page === null
        ? field.evidence
        : t('preview.evidence', { page: field.page, quote: field.evidence })
      : undefined;
  const hasValue = field.value !== null;
  const multiline = field.kind === 'serials' || (field.kind === 'text' && rawValue(field).length > TEXTAREA_THRESHOLD);
  // A blank optional field is not a problem worth a badge or a warning line.
  const showStatus = hasValue;
  const showWarnings = field.warningsAr.length > 0 && (hasValue || field.required);

  function startEdit() {
    setDraft(rawValue(field));
    setEditing(true);
  }

  function save() {
    onSet(field.path, draft);
    setEditing(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <bdi className={`break-words text-sm ${hasValue ? 'text-slate-900' : 'text-slate-400'}`}>{field.displayAr}</bdi>
        {showStatus && field.status === 'confirmed' ? <Badge tone="success">✓ {t('preview.confirmed')}</Badge> : null}
        {showStatus && field.status === 'unconfirmed' ? (
          field.confirmable && !readOnly ? (
            <button
              type="button"
              title={evidenceTitle}
              disabled={busy}
              onClick={() => onConfirm(field.path)}
              className={`inline-flex min-h-11 items-center gap-1 rounded-full bg-warning-50 px-3 py-0.5 text-xs font-semibold text-warning-700 hover:bg-warning-100 disabled:cursor-not-allowed disabled:opacity-60 md:min-h-7 ${FOCUS_RING}`}
            >
              ⚠ {t('preview.unconfirmed')}
            </button>
          ) : (
            <span title={evidenceTitle}>
              <Badge tone="warning">⚠ {readOnly ? t('preview.unconfirmed') : t('preview.unconfirmed_fix')}</Badge>
            </span>
          )
        ) : null}
        {showStatus && field.status === 'confirmed' && evidenceTitle ? (
          <span className="sr-only">{evidenceTitle}</span>
        ) : null}
        {!readOnly && field.editable && !editing ? (
          <button
            type="button"
            aria-label={t('preview.edit_field')}
            title={t('preview.edit_field')}
            disabled={busy}
            onClick={startEdit}
            className={`inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:w-8 ${FOCUS_RING}`}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {showWarnings
        ? field.warningsAr.map((warning, i) => (
            <p key={i} className="break-words text-xs text-warning-700">
              {warning}
            </p>
          ))
        : null}
      {editing ? (
        <div className="flex min-w-0 flex-col gap-2">
          {multiline ? (
            <textarea
              autoFocus
              rows={3}
              value={draft}
              aria-label={field.labelAr}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              className={`w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ${FOCUS_RING}`}
            />
          ) : (
            <input
              autoFocus
              type="text"
              value={draft}
              aria-label={field.labelAr}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              className={`h-11 w-full min-w-[8rem] rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 ${FOCUS_RING}`}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={save} disabled={busy}>
              {t('preview.save_field')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('preview.cancel_field')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A labelled row of a `<dl>`. */
function FieldRow(props: FieldBodyProps) {
  const { field } = props;
  return (
    <div
      data-testid="preview-field"
      data-path={field.path}
      data-status={field.status}
      className="grid grid-cols-1 gap-x-3 gap-y-0.5 border-b border-slate-100 py-2 last:border-b-0 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]"
    >
      <dt className={`min-w-0 break-words text-sm text-slate-600 ${field.required ? 'font-semibold' : ''}`}>{field.labelAr}</dt>
      <dd className="min-w-0">
        <FieldBody {...props} />
      </dd>
    </div>
  );
}

// ─── Lines ──────────────────────────────────────────────────────────────────

interface LinesProps {
  titleAr: string;
  rows: PreviewLineRow[];
  readOnly: boolean;
  busy: boolean;
  onConfirm(path: string): void;
  onSet(path: string, value: string): void;
}

function LinesTable({ rows, readOnly, busy, onConfirm, onSet }: Omit<LinesProps, 'titleAr'>) {
  // One column per distinct label, in order of first appearance.
  const columns: string[] = [];
  for (const row of rows) {
    for (const field of row.fields) {
      if (!columns.includes(field.labelAr)) columns.push(field.labelAr);
    }
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full border-collapse text-start">
        <thead className="bg-slate-50">
          <tr>
            <th scope="col" className="px-3 py-2 text-start text-xs font-semibold text-slate-600">
              #
            </th>
            {columns.map((label) => (
              <th key={label} scope="col" className="min-w-[8rem] px-3 py-2 text-start text-xs font-semibold text-slate-600">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.index} data-testid="preview-line" data-index={row.index} className="border-t border-slate-100 align-top">
              <th scope="row" className="px-3 py-2 text-start text-xs font-semibold text-slate-700">
                {row.titleAr}
              </th>
              {columns.map((label) => {
                const field = row.fields.find((f) => f.labelAr === label);
                return (
                  <td
                    key={label}
                    data-testid={field ? 'preview-field' : undefined}
                    data-path={field?.path}
                    data-status={field?.status}
                    className="px-3 py-2"
                  >
                    {field ? <FieldBody field={field} readOnly={readOnly} busy={busy} onConfirm={onConfirm} onSet={onSet} /> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinesCards({ rows, readOnly, busy, onConfirm, onSet }: Omit<LinesProps, 'titleAr'>) {
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.index} data-testid="preview-line" data-index={row.index} className="rounded-lg border border-slate-200 p-3">
          <p className="mb-1 text-sm font-bold text-slate-900">{row.titleAr}</p>
          <dl>
            {row.fields.map((field) => (
              <FieldRow key={field.path} field={field} readOnly={readOnly} busy={busy} onConfirm={onConfirm} onSet={onSet} />
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

// ─── Choices ────────────────────────────────────────────────────────────────

function ChoiceGroup({
  choice,
  groupId,
  readOnly,
  busy,
  onChoose,
}: {
  choice: PreviewChoice;
  groupId: string;
  readOnly: boolean;
  busy: boolean;
  onChoose(target: string, choice: string): void;
}) {
  if (readOnly) {
    const chosen = choice.options.find((o) => o.id === choice.chosen);
    return (
      <div data-testid="preview-choice" data-target={choice.target} className="flex flex-col gap-0.5 text-sm">
        <p className="text-slate-600">{choice.promptAr}</p>
        {chosen ? <p className="font-semibold text-slate-900">{chosen.labelAr}</p> : null}
      </div>
    );
  }
  return (
    <fieldset data-testid="preview-choice" data-target={choice.target} disabled={busy} className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-sm font-semibold text-slate-800">{choice.promptAr}</legend>
      {choice.options.map((option) => (
        <label
          key={option.id}
          className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm text-slate-800 hover:bg-slate-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500"
        >
          <input
            type="radio"
            name={`${groupId}-${choice.target}`}
            value={option.id}
            checked={choice.chosen === option.id}
            onChange={() => onChoose(choice.target, option.id)}
            className="h-4 w-4 shrink-0 accent-brand-600"
          />
          <span className="min-w-0 break-words">{option.labelAr}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ─── The card ───────────────────────────────────────────────────────────────

type LastAction = 'approve' | 'edit' | 'other';

/**
 * The preview of an intake job (spec/madar/03 §2 `PreviewCard`; T-26 B.4): the
 * flow's fields grouped by section with confirmed ✓ / unconfirmed ⚠, the
 * entity choices, the «ما سيُنفَّذ بالترتيب» list, why «اعتمد» is disabled,
 * and the approve / edit / cancel actions. Gold edge, like `ConsentCard` and
 * `DiffCard` (03 §1). Pure view: every action is a callback; the parent owns
 * the request and passes the rebuilt `view` back.
 *
 * Once the job leaves `preview` (approved, executing, done, failed,
 * cancelled) the card is read-only.
 *
 * 390px: the line table sits in its own `overflow-x-auto` box below `md`
 * the lines render as stacked cards instead, so the page itself never
 * scrolls sideways.
 */
export function PreviewCard({
  view,
  busy,
  errorAr,
  onConfirm,
  onSet,
  onChoose,
  onEdit,
  onApprove,
  onCancel,
}: PreviewCardProps) {
  const titleId = useId();
  const groupId = useId();
  const isDesktop = useIsDesktop();
  const [showEdit, setShowEdit] = useState(false);
  const [editText, setEditText] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [lastAction, setLastAction] = useState<LastAction>('other');
  const wasBusy = useRef(false);

  // An edit sentence stays in its box while the request runs; it is cleared
  // (and the box closed) only once the request ended without an error.
  useEffect(() => {
    if (wasBusy.current && !busy && lastAction === 'edit' && errorAr === null) {
      setEditText('');
      setShowEdit(false);
    }
    wasBusy.current = busy;
  }, [busy, lastAction, errorAr]);

  const preview = view.preview;
  if (!preview) return null;

  const readOnly = view.status !== 'preview';
  const approvedLike = view.status === 'approved' || view.status === 'executing' || view.status === 'done' || view.status === 'failed';

  function confirm(path: string) {
    setLastAction('other');
    onConfirm(path);
  }
  function setField(path: string, value: string) {
    setLastAction('other');
    onSet(path, value);
  }
  function choose(target: string, choice: string) {
    setLastAction('other');
    onChoose(target, choice);
  }
  function sendEdit() {
    const text = editText.trim();
    if (text.length === 0 || busy) return;
    setLastAction('edit');
    onEdit(text);
  }
  function onEditKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendEdit();
    }
  }

  return (
    <div data-testid="preview-card" role="group" aria-labelledby={titleId} className="min-w-0">
      <Card edge="gold" title={t('preview.title')}>
        {/* Same trick as ConsentCard: `Card` cannot expose an id on its own
            heading, so an sr-only copy supplies the label target. */}
        <span id={titleId} className="sr-only">
          {t('preview.title')}
        </span>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone="brand">{view.flowLabelAr}</Badge>
            {approvedLike ? <Badge tone="success">✓ {t('preview.approved')}</Badge> : null}
            {view.status === 'cancelled' ? <Badge tone="neutral">{t('preview.cancelled')}</Badge> : null}
            {view.document ? <DocumentChip document={view.document} /> : null}
            <span className="text-xs text-slate-500">
              {t('preview.summary', {
                confirmed: formatNumber(preview.summary.confirmed),
                total: formatNumber(preview.summary.total),
              })}
            </span>
          </div>

          {preview.incompleteAr ? (
            <p role="alert" className="text-sm font-semibold text-warning-700">
              {preview.incompleteAr}
            </p>
          ) : null}

          {preview.sections.map((section) => (
            <section key={section.key} data-testid="preview-section" data-section={section.key} className="flex min-w-0 flex-col gap-1">
              <h4 className="text-sm font-bold text-slate-900">{section.titleAr}</h4>
              <dl>
                {section.fields.map((field) => (
                  <FieldRow key={field.path} field={field} readOnly={readOnly} busy={busy} onConfirm={confirm} onSet={setField} />
                ))}
              </dl>
            </section>
          ))}

          {preview.lines && preview.lines.rows.length > 0 ? (
            <section data-testid="preview-lines" className="flex min-w-0 flex-col gap-2">
              <h4 className="text-sm font-bold text-slate-900">{preview.lines.titleAr}</h4>
              {isDesktop ? (
                <LinesTable rows={preview.lines.rows} readOnly={readOnly} busy={busy} onConfirm={confirm} onSet={setField} />
              ) : (
                <LinesCards rows={preview.lines.rows} readOnly={readOnly} busy={busy} onConfirm={confirm} onSet={setField} />
              )}
            </section>
          ) : null}

          {preview.choices.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-2">
              <h4 className="text-sm font-bold text-slate-900">{t('preview.choices_title')}</h4>
              {preview.choices.map((choice) => (
                <ChoiceGroup
                  key={choice.target}
                  choice={choice}
                  groupId={groupId}
                  readOnly={readOnly}
                  busy={busy}
                  onChoose={choose}
                />
              ))}
            </section>
          ) : null}

          {preview.notesAr.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-1">
              <h4 className="text-sm font-bold text-slate-900">{t('preview.notes_title')}</h4>
              <ul data-testid="preview-notes" className="list-inside list-disc text-sm text-slate-700">
                {preview.notesAr.map((note, i) => (
                  <li key={i} className="break-words">
                    {note}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {preview.steps.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-1">
              <h4 className="text-sm font-bold text-slate-900">{t('preview.will_execute')}</h4>
              <ol data-testid="preview-steps" className="list-inside list-decimal text-sm text-slate-700">
                {preview.steps.map((step) => (
                  <li key={step.n} className="break-words">
                    {step.labelAr}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {!readOnly && preview.blockersAr.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-1">
              <h4 className="text-sm font-bold text-danger-700">{t('preview.blocked_title')}</h4>
              <ul data-testid="preview-blockers" className="list-inside list-disc text-sm text-danger-700">
                {preview.blockersAr.map((blocker, i) => (
                  <li key={i} className="break-words">
                    {blocker}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {errorAr ? (
            <p role="alert" className="break-words text-sm font-semibold text-danger-700">
              {errorAr}
            </p>
          ) : null}

          {!readOnly ? (
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  disabled={!preview.canApprove || busy}
                  loading={busy && lastAction === 'approve'}
                  onClick={() => {
                    setLastAction('approve');
                    onApprove();
                  }}
                >
                  {t('preview.approve')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  aria-expanded={showEdit}
                  onClick={() => setShowEdit((v) => !v)}
                >
                  {t('preview.edit')}
                </Button>
                {!confirmingCancel ? (
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirmingCancel(true)}>
                    {t('preview.cancel')}
                  </Button>
                ) : null}
              </div>

              {confirmingCancel ? (
                <div role="group" aria-label={t('preview.cancel_confirm')} className="flex flex-col gap-2 rounded-lg border border-danger-200 bg-danger-50/40 p-3">
                  <p className="text-sm text-danger-800">{t('preview.cancel_confirm')}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setLastAction('other');
                        setConfirmingCancel(false);
                        onCancel();
                      }}
                    >
                      {t('preview.confirm_yes')}
                    </Button>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmingCancel(false)}>
                      {t('preview.confirm_no')}
                    </Button>
                  </div>
                </div>
              ) : null}

              {showEdit ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={editText}
                    rows={2}
                    placeholder={t('preview.edit_prompt')}
                    aria-label={t('preview.edit_prompt')}
                    disabled={busy}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={onEditKeyDown}
                    className={`w-full min-w-0 resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 ${FOCUS_RING}`}
                  />
                  <div>
                    <Button type="button" size="sm" onClick={sendEdit} disabled={busy || editText.trim().length === 0}>
                      {t('preview.edit_send')}
                    </Button>
                  </div>
                </div>
              ) : null}

              {busy && lastAction === 'edit' ? <WaitingIndicator label={t('preview.editing')} /> : null}
              {busy && lastAction === 'approve' ? <WaitingIndicator label={t('exec.running')} /> : null}
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
