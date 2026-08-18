'use client';

/**
 * Read-only viewer for the append-only audit trail — the UAT control-gap
 * recommendation: the trail was written on every mutation but nothing could
 * answer "who changed what, when" through the system. Filters are the values
 * actually present in this org's trail (served by /admin/audit/facets), so
 * the dropdowns never offer an option that returns nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { translateError } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { LoadError, TableSkeleton, EmptyRow, Btn } from '@/components/ui';

interface AuditRow {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actor: { nameAr: string; nameEn: string; email: string } | null;
  entityType: string;
  entityId: string;
  action: string;
  beforeJson: unknown;
  afterJson: unknown;
  ip: string | null;
}
interface AuditEnvelope {
  rows: AuditRow[];
  total: number;
}
interface Facets {
  entityTypes: string[];
  actions: string[];
}

// Arabic display names for the entity types the trail records. Unknown types
// (added later on the server) fall back to the raw token rather than hiding.
const ENTITY_AR: Record<string, string> = {
  Customer: 'عميل',
  Lead: 'عميل محتمل',
  Opportunity: 'فرصة',
  Proposal: 'عرض سعر',
  ProposalRevision: 'مراجعة عرض',
  Contract: 'عقد',
  ContractMilestone: 'مرحلة عقد',
  Invoice: 'فاتورة',
  JournalEntry: 'قيد محاسبي',
  PaymentReceipt: 'سند قبض',
  RetentionEntry: 'محتجزات',
  FiscalYear: 'سنة مالية',
  FiscalPeriod: 'فترة محاسبية',
  Vendor: 'مورد',
  VendorBill: 'فاتورة مورد',
  VendorPayment: 'سند صرف مورد',
  PurchaseOrder: 'أمر شراء',
  GoodsReceipt: 'إشعار استلام',
  SerialUnit: 'وحدة متسلسلة',
  Project: 'مشروع',
  ChangeOrder: 'أمر تغيير',
  SubcontractAgreement: 'عقد باطن',
  ProgressClaim: 'مستخلص مقاول',
  WorkOrder: 'أمر عمل',
  MaintenancePlan: 'خطة صيانة',
  WarrantyClaim: 'مطالبة ضمان',
  PerformanceAlert: 'تنبيه أداء',
  PpaTerm: 'اتفاقية شراء طاقة',
  SettlementRun: 'تسوية طاقة',
  Timesheet: 'سجل ساعات',
  User: 'مستخدم',
  Role: 'دور',
  Organization: 'المنشأة',
  Attachment: 'مرفق',
};

const ACTION_AR: Record<string, string> = {
  CREATE: 'إنشاء',
  UPDATE: 'تعديل',
  DELETE: 'حذف',
  LOGIN: 'تسجيل دخول',
  LOGIN_FAILED: 'محاولة دخول فاشلة',
  ACCEPT: 'قبول',
  ACTIVATE: 'تفعيل',
  APPROVE: 'اعتماد',
  ASSIGN: 'إسناد',
  CANCEL: 'إلغاء',
  CLOSE: 'إغلاق',
  REOPEN: 'إعادة فتح',
  CLOSE_YEAR: 'إقفال سنة',
  OPEN_YEAR: 'فتح سنة',
  REOPEN_YEAR: 'إعادة فتح سنة',
  COMPLETE: 'إكمال',
  CONSUME_PART: 'صرف قطعة غيار',
  CONVERT: 'تحويل',
  COST_RECOGNITION: 'اعتراف بالتكلفة',
  CREDIT_NOTE: 'إشعار دائن',
  GENERATE_WO: 'توليد أمر عمل',
  INSTALL: 'تركيب',
  ISSUE_CLEAR: 'إصدار فاتورة إلكترونية',
  PASSWORD_CHANGE: 'تغيير كلمة المرور',
  PASSWORD_RESET: 'إعادة تعيين كلمة المرور',
  PAY: 'سداد',
  POST: 'ترحيل',
  RAISE: 'إطلاق تنبيه',
  RAISE_WO: 'أمر عمل من تنبيه',
  RECEIVE: 'استلام',
  RELEASE: 'إفراج',
  RELEASE_RETENTION: 'إفراج عن محتجزات',
  REPLACE: 'استبدال',
  REVENUE_RECOGNITION: 'اعتراف بالإيراد',
  SETTLE: 'تسوية',
  STAGE_CHANGE: 'تغيير مرحلة',
  START: 'بدء',
  VERIFY: 'اعتماد مرحلة',
};

/** English fallback: SOME_TOKEN → "Some token". */
function humanize(token: string): string {
  const s = token.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const PAGE = 50;

export function AuditLogCard() {
  const { t, locale } = useI18n();
  const ar = locale === 'ar';

  const [data, setData] = useState<AuditEnvelope | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);

  const [fType, setFType] = useState('');
  const [fAction, setFAction] = useState('');
  const [fEntityId, setFEntityId] = useState('');
  const [entityIdInput, setEntityIdInput] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.get<Facets>('/admin/audit/facets').then(setFacets).catch(() => setFacets({ entityTypes: [], actions: [] }));
  }, []);

  // The free-text record-id filter applies after a pause, not per keystroke.
  useEffect(() => {
    const h = setTimeout(() => {
      setFEntityId(entityIdInput.trim());
      setPage(0);
    }, 500);
    return () => clearTimeout(h);
  }, [entityIdInput]);

  const load = useCallback(() => {
    setLoadErr('');
    setLoading(true);
    const params = new URLSearchParams();
    if (fType) params.set('entityType', fType);
    if (fAction) params.set('action', fAction);
    if (fEntityId) params.set('entityId', fEntityId);
    if (fFrom) params.set('from', fFrom);
    if (fTo) params.set('to', fTo);
    params.set('take', String(PAGE));
    params.set('skip', String(page * PAGE));
    api
      .get<AuditEnvelope>(`/admin/audit?${params.toString()}`)
      .then((d) => {
        setData(d);
        setOpen(new Set());
      })
      .catch((e) => setLoadErr(translateError(e, locale)))
      .finally(() => setLoading(false));
  }, [fType, fAction, fEntityId, fFrom, fTo, page, locale]);
  useEffect(load, [load]);

  const entityLabel = (type: string) => (ar ? (ENTITY_AR[type] ?? type) : humanize(type));
  const actionLabel = (action: string) => (ar ? (ACTION_AR[action] ?? action) : humanize(action));

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="card overflow-hidden">
      {/* filter bar */}
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-4">
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('audit.entity')}</span>
          <select
            className="input !py-1.5 text-xs"
            value={fType}
            onChange={(e) => {
              setFType(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{t('audit.allTypes')}</option>
            {facets?.entityTypes.map((et) => (
              <option key={et} value={et}>
                {entityLabel(et)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('audit.action')}</span>
          <select
            className="input !py-1.5 text-xs"
            value={fAction}
            onChange={(e) => {
              setFAction(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{t('audit.allActions')}</option>
            {facets?.actions.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('audit.entityId')}</span>
          <input
            className="input !py-1.5 font-mono text-xs"
            dir="ltr"
            placeholder="cln8…"
            value={entityIdInput}
            onChange={(e) => setEntityIdInput(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('audit.from')}</span>
          <input
            type="date"
            className="input !py-1.5 text-xs"
            value={fFrom}
            onChange={(e) => {
              setFFrom(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('audit.to')}</span>
          <input
            type="date"
            className="input !py-1.5 text-xs"
            value={fTo}
            onChange={(e) => {
              setFTo(e.target.value);
              setPage(0);
            }}
          />
        </label>
      </div>

      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th scope="col" className="th">{t('audit.when')}</th>
            <th scope="col" className="th">{t('audit.actor')}</th>
            <th scope="col" className="th">{t('audit.action')}</th>
            <th scope="col" className="th">{t('audit.entity')}</th>
            <th scope="col" className="th">IP</th>
            <th scope="col" className="th text-end">{t('audit.details')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading && !data ? (
            <TableSkeleton cols={6} />
          ) : !data || data.rows.length === 0 ? (
            <EmptyRow colSpan={6} text={t('audit.empty')} />
          ) : (
            data.rows.map((r) => {
              const hasDiff = r.beforeJson != null || r.afterJson != null;
              const expanded = open.has(r.id);
              return [
                <tr key={r.id}>
                  <td className="td whitespace-nowrap text-xs">{formatDateTime(r.occurredAt, locale)}</td>
                  <td className="td">
                    {r.actor ? (
                      <span title={r.actor.email}>{ar ? r.actor.nameAr : r.actor.nameEn}</span>
                    ) : (
                      <span className="text-slate-500">{t('audit.system')}</span>
                    )}
                  </td>
                  <td className="td">
                    <span className="badge bg-slate-100 text-slate-700">{actionLabel(r.action)}</span>
                  </td>
                  <td className="td">
                    {entityLabel(r.entityType)}
                    <span className="ms-2 font-mono text-xs text-slate-500" dir="ltr">
                      {r.entityId}
                    </span>
                  </td>
                  <td className="td font-mono text-xs text-slate-500" dir="ltr">
                    {r.ip ?? '—'}
                  </td>
                  <td className="td-num">
                    {hasDiff && (
                      <Btn
                        sm
                        icon={expanded ? 'chevron-end' : 'eye'}
                        iconClassName={expanded ? 'rtl:-scale-x-100' : ''}
                        aria-expanded={expanded}
                        onClick={() =>
                          setOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(r.id)) next.delete(r.id);
                            else next.add(r.id);
                            return next;
                          })
                        }
                      >
                        {t('audit.details')}
                      </Btn>
                    )}
                  </td>
                </tr>,
                expanded ? (
                  <tr key={`${r.id}-diff`} className="bg-slate-50/60">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        {([
                          ['audit.before', r.beforeJson],
                          ['audit.after', r.afterJson],
                        ] as const).map(([key, json]) => (
                          <div key={key}>
                            <div className="mb-1 text-xs font-semibold text-slate-500">{t(key)}</div>
                            <pre
                              dir="ltr"
                              tabIndex={0}
                              aria-label={t(key)}
                              className="max-h-64 overflow-auto rounded-lg bg-white p-3 text-start font-mono text-xs leading-relaxed text-slate-700 ring-1 ring-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                            >
                              {json == null ? '—' : JSON.stringify(json, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })
          )}
        </tbody>
      </table>

      {/* pagination */}
      <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
        <span>
          {t('audit.total')}: {formatNumber(total, locale)}
        </span>
        {pages > 1 && (
          <div className="flex items-center gap-2">
            <Btn sm disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
              {t('common.prev')}
            </Btn>
            <span>
              {formatNumber(page + 1, locale)} / {formatNumber(pages, locale)}
            </span>
            <Btn sm disabled={page >= pages - 1 || loading} onClick={() => setPage((p) => p + 1)}>
              {t('common.next')}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
