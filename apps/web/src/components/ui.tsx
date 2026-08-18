'use client';

import {
  ButtonHTMLAttributes,
  ReactNode,
  RefObject,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icons';

export function PageHeader({
  title,
  subtitle,
  action,
  backHref,
  backLabel,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /**
   * Detail screens are reached from a list, from global search, or from a
   * notification link — the last two leave no browser history worth going
   * back to. An explicit link to the parent list is the only reliable way out.
   */
  backHref?: string;
  backLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div>
        {backHref && (
          <Link
            href={backHref}
            className="mb-1.5 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-brand-700"
          >
            {/* Points left in LTR, right in RTL — "back" follows reading order. */}
            <Icon name="chevron-start" className="h-3.5 w-3.5 rtl:-scale-x-100" />
            {backLabel ?? t('common.back')}
          </Link>
        )}
        <h1 className="text-lg font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** Inline spinner sized to the text it sits in. */
export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const BTN_VARIANT = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  solar: 'btn-solar',
  danger: 'btn-danger',
  success: 'btn-success',
} as const;

/**
 * The one action button.
 *
 * Two things it fixes that the raw `<button className="btn-primary">` could
 * not: the icon slot is an SVG that inherits `currentColor` (button labels
 * used to carry emoji, which render differently per OS and never mirror in
 * RTL), and the in-flight state swaps that icon for a spinner **while keeping
 * the label**. Replacing the label with "Loading…" resized the button
 * mid-click and threw away the one word telling you what you had just
 * started.
 *
 * `busy` also disables — a request in flight must not be fired twice.
 */
export function Btn({
  variant = 'ghost',
  icon,
  iconClassName = '',
  busy = false,
  sm = false,
  className = '',
  disabled,
  children,
  ...rest
}: {
  variant?: keyof typeof BTN_VARIANT;
  /** Icon name from `components/icons`. */
  icon?: string;
  /** Extra classes on the icon — `rtl:-scale-x-100` for directional ones. */
  iconClassName?: string;
  busy?: boolean;
  /** Compact size for buttons inside table rows and card headers. */
  sm?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const size = sm ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${BTN_VARIANT[variant]}${sm ? ' btn-sm' : ''}${className ? ` ${className}` : ''}`}
    >
      {busy ? (
        <Spinner className={size} />
      ) : icon ? (
        <Icon name={icon} className={iconClassName ? `${size} ${iconClassName}` : size} />
      ) : null}
      {children}
    </button>
  );
}

/** Deterministic widths — Math.random() here would break hydration. */
const SKELETON_WIDTHS = ['62%', '84%', '45%', '73%', '55%', '90%'];

/**
 * Placeholder rows shaped like the table that is loading. A row of grey bars
 * says "content is coming and it will look like this"; the single centred
 * "Loading…" it replaces collapsed the table to one line and then jumped.
 */
export function TableSkeleton({ cols, rows = 5 }: { cols: number; rows?: number }) {
  const { t } = useI18n();
  return (
    <>
      <tr>
        <td colSpan={cols} className="sr-only" role="status">
          {t('common.loading')}
        </td>
      </tr>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="td">
              <div
                className="skeleton h-3"
                style={{ width: SKELETON_WIDTHS[(r * cols + c) % SKELETON_WIDTHS.length] }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * Whole-screen placeholder for detail pages, which used to render a bare
 * "Loading…" line and then snap to a full layout.
 */
export function PageSkeleton({ stats = 4 }: { stats?: number }) {
  const { t } = useI18n();
  return (
    <div>
      <span className="sr-only" role="status">
        {t('common.loading')}
      </span>
      <div className="mb-6 space-y-2" aria-hidden>
        <div className="skeleton h-3 w-16" />
        <div className="skeleton h-6 w-56" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-hidden>
        {Array.from({ length: stats }, (_, i) => (
          <div key={i} className="card space-y-3 p-5">
            <div className="skeleton h-3 w-20" />
            <div className="skeleton h-7 w-24" />
          </div>
        ))}
      </div>
      <div className="card mt-6 space-y-3.5 p-6" aria-hidden>
        {SKELETON_WIDTHS.map((w, i) => (
          <div key={i} className="skeleton h-3.5" style={{ width: w }} />
        ))}
      </div>
    </div>
  );
}

/**
 * Hides an action the caller has no permission for. The server is still the
 * authority — this only stops us offering a button that would come back 403.
 *
 * `perm` must be the permission the BUTTON'S ENDPOINT requires, which is not
 * always the one guarding the page it sits on: installing a serial unit needs
 * `scm.procurement.write` on a screen read with `assets.serialunit.read`, and
 * recording an invoice payment needs `finance.invoice.write`, not
 * `finance.payment.write` (that one is the vendor side). Pass every key when
 * an endpoint requires more than one — lead conversion needs both CRM writes.
 */
export function Can({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth();
  const keys = Array.isArray(perm) ? perm : [perm];
  return keys.every(can) ? <>{children}</> : null;
}

export interface TabDef {
  /** Stable key — also what `value`/`onChange` carry. */
  key: string;
  label: string;
  /** Optional count shown as a pill (hidden when 0/undefined). */
  count?: number;
}

/**
 * Section tabs for detail screens that would otherwise stack a dozen cards
 * on one page. Generalises the pill row `/admin` has used since M2 — same
 * look, so the two screens stay consistent.
 *
 * Controlled on purpose: the parent owns the active key, which lets a page
 * jump to a tab (e.g. after an action) without reaching inside this component.
 */
export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: TabDef[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 text-sm font-semibold [scrollbar-width:none]">
      {tabs.map((tb) => (
        <button
          key={tb.key}
          type="button"
          onClick={() => onChange(tb.key)}
          aria-current={value === tb.key ? 'page' : undefined}
          className={`flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            value === tb.key
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {tb.label}
          {!!tb.count && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${
                value === tb.key ? 'bg-brand-50 text-brand-700' : 'bg-slate-200 text-slate-700'
              }`}
            >
              {tb.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Bilingual status labels + tinted dot-badges for every enum status in the
 * system, so raw keys like CLOSED never leak into the UI.
 */
const STATUS_META: Record<string, { ar: string; en: string; cls: string; dot: string }> = {
  // generic / documents
  DRAFT: { ar: 'مسودة', en: 'Draft', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  ACTIVE: { ar: 'نشط', en: 'Active', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  SUSPENDED: { ar: 'موقوف', en: 'Suspended', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  CLOSED: { ar: 'مغلق', en: 'Closed', cls: 'bg-slate-100 text-slate-500', dot: 'bg-slate-400' },
  CANCELLED: { ar: 'ملغى', en: 'Cancelled', cls: 'bg-danger-50 text-danger-600', dot: 'bg-danger-500' },
  // CRM
  NEW: { ar: 'جديد', en: 'New', cls: 'bg-info-50 text-info-700', dot: 'bg-info-500' },
  QUALIFIED: { ar: 'مؤهَّل', en: 'Qualified', cls: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' },
  CONVERTED: { ar: 'محوَّل', en: 'Converted', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  DISQUALIFIED: { ar: 'غير مؤهَّل', en: 'Disqualified', cls: 'bg-danger-50 text-danger-600', dot: 'bg-danger-500' },
  PROSPECTING: { ar: 'استكشاف', en: 'Prospecting', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  PROPOSAL: { ar: 'عرض سعر', en: 'Proposal', cls: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' },
  NEGOTIATION: { ar: 'تفاوض', en: 'Negotiation', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  WON: { ar: 'مكسوبة', en: 'Won', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  LOST: { ar: 'خاسرة', en: 'Lost', cls: 'bg-danger-50 text-danger-600', dot: 'bg-danger-500' },
  SENT: { ar: 'مُرسَل', en: 'Sent', cls: 'bg-info-50 text-info-700', dot: 'bg-info-500' },
  ACCEPTED: { ar: 'مقبول', en: 'Accepted', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  REJECTED: { ar: 'مرفوض', en: 'Rejected', cls: 'bg-danger-50 text-danger-600', dot: 'bg-danger-500' },
  // milestones / invoices
  PENDING: { ar: 'قيد الانتظار', en: 'Pending', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  VERIFIED: { ar: 'تم التحقق', en: 'Verified', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  INVOICED: { ar: 'مفوترة', en: 'Invoiced', cls: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' },
  ISSUED: { ar: 'مُصدَرة', en: 'Issued', cls: 'bg-info-50 text-info-700', dot: 'bg-info-500' },
  CLEARED: { ar: 'معتمدة ZATCA', en: 'ZATCA cleared', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  PAID: { ar: 'مدفوعة', en: 'Paid', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  REPORTED: { ar: 'مُبلَّغة', en: 'Reported', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  // projects
  PLANNING: { ar: 'تخطيط', en: 'Planning', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  PROCUREMENT: { ar: 'مشتريات', en: 'Procurement', cls: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' },
  EXECUTION: { ar: 'تنفيذ', en: 'Execution', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  COMMISSIONING: { ar: 'تشغيل تجريبي', en: 'Commissioning', cls: 'bg-info-50 text-info-700', dot: 'bg-info-500' },
  // procurement
  APPROVED: { ar: 'معتمد', en: 'Approved', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  PARTIALLY_RECEIVED: { ar: 'مستلم جزئياً', en: 'Partially received', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  RECEIVED: { ar: 'مستلم', en: 'Received', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  POSTED: { ar: 'مرحَّلة', en: 'Posted', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  SUBMITTED: { ar: 'مقدَّم', en: 'Submitted', cls: 'bg-info-50 text-info-700', dot: 'bg-info-500' },
  COMPLETED: { ar: 'منجز', en: 'Completed', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  TERMINATED: { ar: 'منهاة', en: 'Terminated', cls: 'bg-danger-50 text-danger-600', dot: 'bg-danger-500' },
  // serial units / assets
  IN_STOCK: { ar: 'في المخزون', en: 'In stock', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  INSTALLED: { ar: 'مركَّب', en: 'Installed', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  FAULTY: { ar: 'معطّل', en: 'Faulty', cls: 'bg-danger-50 text-danger-600', dot: 'bg-danger-500' },
  RETURNED: { ar: 'مرتجع', en: 'Returned', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  SCRAPPED: { ar: 'مُتلَف', en: 'Scrapped', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  OPERATING: { ar: 'عامل', en: 'Operating', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  UNDER_MAINTENANCE: { ar: 'تحت الصيانة', en: 'Under maintenance', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  RETIRED: { ar: 'خارج الخدمة', en: 'Retired', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  // work orders
  OPEN: { ar: 'مفتوح', en: 'Open', cls: 'bg-info-50 text-info-700', dot: 'bg-info-500' },
  ASSIGNED: { ar: 'مُسنَد', en: 'Assigned', cls: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' },
  IN_PROGRESS: { ar: 'قيد التنفيذ', en: 'In progress', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  // alerts
  ACKNOWLEDGED: { ar: 'مؤكَّد', en: 'Acknowledged', cls: 'bg-info-50 text-info-700', dot: 'bg-info-500' },
  WORK_ORDERED: { ar: 'صدر أمر عمل', en: 'Work ordered', cls: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' },
  RESOLVED: { ar: 'محلول', en: 'Resolved', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  // ppa
  ENDED: { ar: 'منتهية', en: 'Ended', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  // warranty / RMA
  REPLACED: { ar: 'تم الاستبدال', en: 'Replaced', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
  // retention
  WITHHELD: { ar: 'محتجزة', en: 'Withheld', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  RELEASED: { ar: 'مُفرَج عنها', en: 'Released', cls: 'bg-success-50 text-success-700', dot: 'bg-success-500' },
};

/**
 * The label half of `StatusBadge`, for the places that need the wording
 * without the pill — filter dropdowns, mostly. Re-typing these strings inline
 * is how a filter option and the badge it filters on drift apart.
 */
export function statusLabel(status: string, locale: string): string {
  const meta = STATUS_META[status];
  if (!meta) return status;
  return locale === 'ar' ? meta.ar : meta.en;
}

export function StatusBadge({ status }: { status: string }) {
  const { locale } = useI18n();
  const meta = STATUS_META[status];
  if (!meta) {
    return <span className="badge bg-slate-100 text-slate-600">{status}</span>;
  }
  return (
    <span className={`badge ${meta.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {locale === 'ar' ? meta.ar : meta.en}
    </span>
  );
}

export function Field({
  label,
  children,
  error,
  hint,
}: {
  label: string;
  children: ReactNode;
  /** Validation message. Shown under the control and announced to readers. */
  error?: string;
  /** Static help text, hidden while an error is showing. */
  hint?: string;
}) {
  // Wire label→control so clicking the label focuses the field and screen
  // readers announce a name. Works when the child is a single form element.
  // Honour an id the caller already put on the control instead of bailing out:
  // the old `&& !children.props.id` guard left `htmlFor` pointing at an element
  // that never existed, and skipped the aria-invalid/describedby branch with it.
  const autoId = useId();
  const ownId = isValidElement(children)
    ? ((children.props as any).id as string | undefined)
    : undefined;
  const id = ownId ?? autoId;
  const msgId = `${id}-msg`;
  const child =
    isValidElement(children)
      ? cloneElement(children as any, {
          id,
          // aria-invalid + aria-describedby is what actually makes the error
          // reach a screen reader; the red ring alone reaches nobody.
          ...(error
            ? {
                'aria-invalid': true,
                'aria-describedby': msgId,
                className: `${(children.props as any).className ?? ''} !border-danger-300 focus:!border-danger-400 focus:!ring-danger-500/10`,
              }
            : hint
              ? { 'aria-describedby': msgId }
              : null),
        } as any)
      : children;
  return (
    <div>
      <label className="label" htmlFor={isValidElement(children) ? id : undefined}>
        {label}
      </label>
      {child}
      {error ? (
        <p id={msgId} role="alert" className="mt-1 text-xs font-medium text-danger-600">
          {error}
        </p>
      ) : hint ? (
        <p id={msgId} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The four things `role="dialog" aria-modal="true"` promises and neither
 * dialog was delivering: the page behind stops scrolling, focus moves into
 * the panel (so the Esc handler can actually receive the key), Tab cycles
 * inside instead of walking the page under the scrim, and focus returns to
 * whatever opened it. Focus already inside the panel is left alone, so an
 * `autoFocus` on a specific control still wins.
 */
function useDialogBehavior(open: boolean, panelRef: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const el = panelRef.current;
      if (!el) return;
      const f = Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => n.offsetParent !== null);
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      restore?.focus?.();
    };
  }, [open, panelRef]);
}

export function Modal({
  open,
  title,
  onClose,
  children,
  dirty,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** When true, closing (outside-click, ✕, Esc) asks before discarding input. */
  dirty?: boolean;
}) {
  const { t } = useI18n();
  const [confirmClose, setConfirmClose] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogBehavior(open, panelRef);
  if (!open) return null;
  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/50 p-4 pt-16 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') requestClose();
      }}
    >
      {/* role/aria-modal belong on the panel, not the scrim that wraps it. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="card w-full max-w-2xl border-slate-200 p-6 shadow-2xl outline-none"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-bold text-slate-900">
            {title}
          </h2>
          <button
            onClick={requestClose}
            aria-label={t('common.close')}
            className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
      {confirmClose && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink-950/40 p-4">
          <div className="card w-full max-w-sm p-6 shadow-2xl">
            <h3 className="text-sm font-bold text-slate-900">{t('common.discardTitle')}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{t('common.discardMsg')}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn-ghost text-xs" onClick={() => setConfirmClose(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-danger text-xs"
                onClick={() => {
                  setConfirmClose(false);
                  onClose();
                }}
              >
                {t('common.discard')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

/**
 * Promise-based confirmation dialog for irreversible actions.
 *
 *   const { confirm, confirmNode } = useConfirm();
 *   if (!(await confirm({ title, message, danger: true }))) return;
 *   ...render {confirmNode} once at the end of the page.
 */
export function useConfirm() {
  const { t } = useI18n();
  const [state, setState] = useState<{
    opts: ConfirmOpts;
    resolve: (v: boolean) => void;
  } | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogBehavior(!!state, panelRef);

  const confirm = (opts: ConfirmOpts) =>
    new Promise<boolean>((resolve) => setState({ opts, resolve }));

  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };

  const confirmNode = state ? (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-ink-950/50 p-4 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close(false);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="card w-full max-w-md border-slate-200 p-6 shadow-2xl outline-none"
      >
        <h2 id={titleId} className="text-lg font-bold text-slate-900">
          {state.opts.title}
        </h2>
        <p className="mt-2 text-sm leading-7 text-slate-600">{state.opts.message}</p>
        <div className="mt-6 flex items-center justify-end gap-2">
          {/* An irreversible action must not open with its own button armed:
              a stray Enter would commit it. Cancel takes the focus instead. */}
          <button autoFocus={!!state.opts.danger} className="btn-ghost" onClick={() => close(false)}>
            {t('common.cancel')}
          </button>
          <button
            autoFocus={!state.opts.danger}
            className={state.opts.danger ? 'btn-danger' : 'btn-primary'}
            onClick={() => close(true)}
          >
            {state.opts.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, confirmNode };
}

/** Error card for a failed page load, with a retry button. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="card border-danger-200 bg-danger-50/40 p-8 text-center">
      <p className="text-sm leading-6 text-danger-700">{message}</p>
      <button onClick={onRetry} className="btn-ghost mt-4">
        {t('common.retry')}
      </button>
    </div>
  );
}

export function EmptyRow({
  colSpan,
  text,
  actionHref,
  actionText,
}: {
  colSpan: number;
  text: string;
  actionHref?: string;
  actionText?: string;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-sm text-slate-500">
        {text}
        {actionHref && actionText && (
          <Link
            href={actionHref}
            className="ms-2 font-semibold text-brand-700 underline decoration-brand-700/30 underline-offset-4 transition hover:decoration-brand-700"
          >
            {actionText}
          </Link>
        )}
      </td>
    </tr>
  );
}
