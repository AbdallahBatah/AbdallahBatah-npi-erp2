'use client';

import { FormEvent, Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useAct } from '@/lib/useAct';
import { useValidate } from '@/lib/useValidate';
import { useDraft } from '@/lib/useDraft';
import { translateError } from '@/lib/errors';
import { useEnums } from '@/lib/useEnums';
import { useLookup } from '@/lib/lookups';
import { formatDateTime, formatDay, formatMoney } from '@/lib/format';
import { PageHeader, StatusBadge, Modal, Field, LoadError, useConfirm, Btn, PageSkeleton } from '@/components/ui';
import { ApprovalChain, type ApprovalRequestView } from '@/components/approvals';
import { daysUntil } from '@/components/opportunity-bits';
import { Icon } from '@/components/icons';
import { AttachmentsCard } from '@/components/attachments';

// Cost-side fields arrive as null for a user without finance.costs.view — the
// server nulls them (CostRedactionInterceptor + hideRevisionPricing) and the page
// hides them. The selling price (unitPrice, lineTotal, totalAmount) always stays,
// on a revision made since the approval flow existed.
interface Item { id: string; sku: string; nameAr: string; nameEn: string; unitCost: string | null }
interface Scheme { id: string; code: string; nameAr: string; nameEn: string; marginPct: string | null }
/** Package 3 · P3-3/P3-4: a project work item, from GET /reference/lookups/work-items. */
interface WorkItemRef {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: string;
  uom: string;
  /** null without finance.costs.view (server redaction). */
  defaultUnitCost?: string | null;
  itemId?: string | null;
}
interface BomLine {
  id: string;
  itemId: string | null;
  workItemId?: string | null;
  workItem?: WorkItemRef | null;
  description?: string | null;
  uom?: string | null;
  qty: string;
  unitPrice: string | null;
  lineTotal: string | null;
  unitCost?: string | null;
  originalUnitCost?: string | null;
  costSource?: string | null;
  costDate?: string | null;
  costAgeDays?: number | null;
  costOverrideReason?: string | null;
  item: Item | null;
}
interface Revision {
  id: string;
  revisionNo: number;
  subtotal: string | null;
  marginAmount: string | null;
  totalAmount: string;
  status: string;
  isWinning: boolean;
  validUntil: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  closedAt: string | null;
  supersededById: string | null;
  createdBy?: { id: string; nameAr: string; nameEn: string } | null;
  bomLines: BomLine[];
  designVersion?: { capacityKwp: string; expectedAnnualKwh: string; sourceTool: string } | null;
  // Package 3 · P3-4 (ADR-03 §4-4): the estimated budget. Cost-side ones arrive
  // null without finance.costs.view.
  pricingMode?: 'PER_LINE' | 'LUMP_SUM';
  sellingTotal?: string | null;
  contingencyPct?: string | null;
  contingencyAmount?: string | null;
  riskNotes?: string | null;
  templateId?: string | null;
}
/** Package 3 · P3-5: a standard budget, from GET /reference/lookups/budget-templates. */
interface TemplateRef {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  panelCount: number | null;
  capacityKwp: string | null;
  lines: { workItemId: string; qty: string; description: string | null }[];
}
interface HistoryRow {
  id: string;
  actionCode: string;
  comment: string | null;
  createdAt: string;
  actor: { nameAr: string; nameEn: string } | null;
  toStateName: { nameAr: string; nameEn: string } | null;
}
interface Proposal {
  id: string;
  code: string;
  status: string;
  currency: string;
  opportunity: { id: string; name: string; customer: { id: string; nameAr: string; nameEn: string } };
  revisions: Revision[];
  contracts: { id: string; code: string }[];
  approval: ApprovalRequestView | null;
  pendingApproval: ApprovalRequestView | null;
  actions: { actionCode: string; nameAr: string; nameEn: string }[];
  history: HistoryRow[];
  settings: { validityDays: number; costAgeWarnDays: number };
  /** The role the approval matrix will ask to sign this total (a draft only; null when no rule applies). */
  submitTo: { nameAr: string; nameEn: string } | null;
}
interface Fetched {
  itemId: string;
  unitCost: string;
  costSource: string;
  costDate: string | null;
  costAgeDays: number | null;
  stale: boolean;
  warnDays: number;
}

/** One line of the form. Costs are text so a half-typed number is not rewritten under the cursor. */
interface DraftLine {
  /** Package 3: the work item this line is (a lump-sum budget line always has one). */
  workItemId: string;
  description: string;
  itemId: string;
  qty: number;
  unitCost: string;
  unitPrice: string;
  /** Once the author has typed a price, a margin change no longer rewrites it. */
  priceTouched: boolean;
  reason: string;
  fetched: Fetched | null;
}
const blankLine = (): DraftLine => ({
  workItemId: '',
  description: '',
  itemId: '',
  qty: 1,
  unitCost: '',
  unitPrice: '',
  priceTouched: false,
  reason: '',
  fetched: null,
});
/** A line names something: a work item, or (per-line pricing) a stock item. */
const filled = (l: DraftLine) => !!(l.workItemId || l.itemId);

type FormState = { mode: 'create' | 'edit'; revisionId?: string } | null;

// Display arithmetic only (a live preview while typing): the server prices the revision in Decimal.
const money = (n: number) => (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
const suggest = (cost: number, pct: number) => money(cost * (1 + pct / 100));
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return dayKey(d);
};
const costChanged = (l: DraftLine) =>
  !!l.fetched && l.unitCost !== '' && Math.abs(Number(l.unitCost) - Number(l.fetched.unitCost)) >= 0.005;
/** A work item's default cost, shaped like a fetched cost (no age: it is a catalogue figure). */
const workItemCost = (w: WorkItemRef): Fetched | null =>
  w.defaultUnitCost == null
    ? null
    : {
        itemId: '',
        unitCost: String(Number(w.defaultUnitCost).toFixed(2)),
        costSource: 'CATALOGUE',
        costDate: null,
        costAgeDays: null,
        stale: false,
        warnDays: 0,
      };

export default function ProposalDetailPage() {
  const { t, locale, pick } = useI18n();
  const ar = locale === 'ar';
  const { can } = useAuth();
  // Cost, source, margin, pricing scheme and subtotal are hidden without this;
  // the selling price and the total always stay.
  const showCosts = can('finance.costs.view');
  const canWrite = can('commercial.proposal.write');
  const canApprove = can('commercial.proposal.approve');
  const enums = useEnums();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [proposal, setProposal] = useState<Proposal | null>(null);
  // The bill of materials' item list, earned by commercial.proposal.write
  // itself (ADR-02 §3-3); only the form uses it, so only a writer asks.
  const itemList = useLookup<Item>('items', { enabled: canWrite });
  const items = itemList.rows;
  // Package 3 · P3-3: the work items a budget is built from (same keys as the items).
  const workItemList = useLookup<WorkItemRef>('workItems', { enabled: canWrite });
  const workItems = workItemList.rows;
  const templateList = useLookup<TemplateRef>('budgetTemplates', { enabled: canWrite });
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [form, setForm] = useState<FormState>(null);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [validUntil, setValidUntil] = useState('');
  const [schemeId, setSchemeId] = useState('');
  const [capacityKwp, setCapacityKwp] = useState('');
  const [annualKwh, setAnnualKwh] = useState('');
  // Package 3 · P3-4: lump-sum budget (the default for a new revision) or per-line prices.
  const [pricingMode, setPricingMode] = useState<'PER_LINE' | 'LUMP_SUM'>('LUMP_SUM');
  const [sellingTotal, setSellingTotal] = useState('');
  const [contingencyPct, setContingencyPct] = useState('');
  const [riskNotes, setRiskNotes] = useState('');
  const [templateId, setTemplateId] = useState('');
  const lump = pricingMode === 'LUMP_SUM';
  const [contractOpen, setContractOpen] = useState(false);
  const [contractErr, setContractErr] = useState('');
  // P3-8: acceptance needs the customer's approval file.
  const [acceptFor, setAcceptFor] = useState<string | null>(null);
  const [acceptFile, setAcceptFile] = useState<File | null>(null);
  const [acceptErr, setAcceptErr] = useState('');
  const [filesKey, setFilesKey] = useState(0);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectErr, setRejectErr] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const { act, busy } = useAct();
  const { confirm, confirmNode } = useConfirm();

  const load = useCallback(() => {
    setLoadErr('');
    api
      .get<Proposal>(`/proposals/${id}`)
      .then(setProposal)
      .catch((e) => setLoadErr(translateError(e, locale)));
  }, [id, locale]);

  useEffect(() => {
    load();
    if (showCosts) api.get<Scheme[]>('/reference/pricing-schemes').then(setSchemes).catch(() => {});
  }, [load, showCosts]);

  const marginPct = Number(schemes.find((s) => s.id === schemeId)?.marginPct ?? 0);
  const draftTotal = useMemo(
    () =>
      pricingMode === 'LUMP_SUM'
        ? Number(sellingTotal) || 0
        : lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0),
    [lines, pricingMode, sellingTotal],
  );
  const draftSubtotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0),
    [lines],
  );
  // Display arithmetic only; the server computes the stored figures (budgetTotals).
  const draftContingency = (draftSubtotal * (Number(contingencyPct) || 0)) / 100;
  const draftProfit = draftTotal - draftSubtotal - draftContingency;
  const draftMarginPct = draftTotal > 0 ? (draftProfit / draftTotal) * 100 : null;

  // Newest first on the page; the highest revision number is the current one.
  const revisions = useMemo(() => [...(proposal?.revisions ?? [])].sort((a, b) => b.revisionNo - a.revisionNo), [proposal]);
  const current = revisions[0] ?? null;
  const winning = proposal?.revisions.find((r) => r.isWinning);
  const has = (code: string) => !!proposal?.actions.some((a) => a.actionCode === code);

  // The form opens by itself while there is nothing to look at but a blank page.
  useEffect(() => {
    if (proposal && proposal.revisions.length === 0 && !form && canWrite) {
      setForm({ mode: 'create' });
      setValidUntil((v) => v || inDays(proposal.settings.validityDays));
    }
  }, [proposal, form, canWrite]);

  // A revision can be many lines of hand-entered pricing; losing it to a refresh
  // is the single most expensive accident on this screen. Keyed by proposal so two
  // tabs on different proposals do not overwrite each other.
  const draft = useDraft(
    `revision3:${id}`,
    { form, lines, schemeId, validUntil, capacityKwp, annualKwh, pricingMode, sellingTotal, contingencyPct, riskNotes, templateId },
    (saved) => {
      setForm(saved.form);
      setLines(saved.lines);
      setSchemeId(saved.schemeId);
      setValidUntil(saved.validUntil);
      setCapacityKwp(saved.capacityKwp);
      setAnnualKwh(saved.annualKwh);
      setPricingMode(saved.pricingMode ?? 'LUMP_SUM');
      setSellingTotal(saved.sellingTotal ?? '');
      setContingencyPct(saved.contingencyPct ?? '');
      setRiskNotes(saved.riskNotes ?? '');
      setTemplateId(saved.templateId ?? '');
    },
    {
      // A pristine form (one blank line, nothing typed) is not a draft.
      shouldSave: (v) =>
        v.form !== null &&
        Boolean(v.capacityKwp || v.annualKwh || v.schemeId || v.sellingTotal || v.lines.some((l) => filled(l))),
    },
  );

  // The design figures are optional, but if one is given the other is expected
  // and neither may be negative — the server would reject silently otherwise.
  const validation = useValidate(
    { capacityKwp, annualKwh, lines, validUntil, pricingMode },
    {
      capacityKwp: (v) =>
        Number(v.capacityKwp) < 0
          ? t('valid.negative')
          : v.annualKwh && !v.capacityKwp
            ? t('valid.needBoth')
            : undefined,
      annualKwh: (v) =>
        Number(v.annualKwh) < 0
          ? t('valid.negative')
          : v.capacityKwp && !v.annualKwh
            ? t('valid.needBoth')
            : undefined,
      validUntil: (v) => (v.validUntil && v.validUntil > dayKey(new Date()) ? undefined : t('proposals.err.validUntil')),
      lines: (v) =>
        v.lines.some((l) => filled(l) && (!l.qty || l.qty <= 0))
          ? t('valid.qtyPositive')
          : v.lines.filter((l) => filled(l) && l.qty > 0).length === 0
            ? t('valid.needLine')
            : v.lines.some((l) => filled(l) && costChanged(l) && !l.reason.trim())
              ? t('proposals.overrideReasonRequired')
              : v.pricingMode === 'LUMP_SUM' && v.lines.some((l) => l.itemId && !l.workItemId)
                ? t('budget.err.workItem')
                : v.pricingMode === 'PER_LINE' && !showCosts && v.lines.some((l) => filled(l) && l.unitPrice === '')
                  ? t('proposals.err.price')
                  : undefined,
    },
  );

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, blankLine()]);
  }
  function removeLine(i: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [blankLine()]));
  }

  /** The cost a line would get, from the server (last accepted receipt / approved order / catalogue). */
  async function fetchCosts(ids: string[]): Promise<Map<string, Fetched>> {
    if (!showCosts || ids.length === 0 || !proposal) return new Map();
    try {
      const rows = await api.get<Fetched[]>(
        `/proposals/cost-lookup?itemIds=${encodeURIComponent(ids.join(','))}&currency=${encodeURIComponent(proposal.currency)}`,
      );
      return new Map(rows.map((r) => [r.itemId, r]));
    } catch {
      return new Map(); // the server still fetches the cost on save; the form just cannot preview it
    }
  }

  async function onItemChange(i: number, itemId: string) {
    updateLine(i, { itemId, fetched: null, unitCost: '', reason: '' });
    if (!itemId || !showCosts) return;
    const f = (await fetchCosts([itemId])).get(itemId) ?? null;
    setLines((prev) =>
      prev.map((l, idx) =>
        idx === i && l.itemId === itemId
          ? {
              ...l,
              fetched: f,
              unitCost: f ? f.unitCost : '',
              unitPrice: l.priceTouched || !f ? l.unitPrice : suggest(Number(f.unitCost), marginPct),
            }
          : l,
      ),
    );
  }

  /** Package 3 · P3-4: picking a work item brings its stock item (materials) or its default cost. */
  async function onWorkItemChange(i: number, workItemId: string) {
    const w = workItems.find((x) => x.id === workItemId) ?? null;
    const itemId = w?.itemId ?? '';
    updateLine(i, { workItemId, itemId, fetched: null, unitCost: '', reason: '' });
    if (!w || !showCosts) return;
    const f = itemId ? ((await fetchCosts([itemId])).get(itemId) ?? null) : workItemCost(w);
    setLines((prev) =>
      prev.map((l, idx) =>
        idx === i && l.workItemId === workItemId
          ? {
              ...l,
              fetched: f,
              unitCost: f ? f.unitCost : '',
              unitPrice: lump || l.priceTouched || !f ? l.unitPrice : suggest(Number(f.unitCost), marginPct),
            }
          : l,
      ),
    );
  }

  /**
   * Package 3 · P3-5: start the budget from a standard one. Its lines replace the
   * form's (after a confirmation when something was typed), each costed as a
   * freshly picked work item would be; the template is recorded on the revision.
   */
  async function applyTemplate(id: string) {
    const tpl = templateList.rows.find((x) => x.id === id);
    if (!tpl) return;
    if (lines.some((l) => filled(l)) && !(await confirm({ title: t('budget.fromTemplate'), message: t('budget.fromTemplateConfirm') })))
      return;
    const picked = tpl.lines.map((tl) => ({ tl, w: workItems.find((x) => x.id === tl.workItemId) ?? null }));
    const fetched = await fetchCosts([
      ...new Set(picked.map((p) => p.w?.itemId).filter((x): x is string => !!x)),
    ]);
    setTemplateId(tpl.id);
    setPricingMode('LUMP_SUM');
    if (!capacityKwp && tpl.capacityKwp) setCapacityKwp(String(Number(tpl.capacityKwp)));
    setLines(
      picked.length === 0
        ? [blankLine()]
        : picked.map(({ tl, w }) => {
            const f = !showCosts ? null : w?.itemId ? (fetched.get(w.itemId) ?? null) : w ? workItemCost(w) : null;
            return {
              ...blankLine(),
              workItemId: tl.workItemId,
              itemId: w?.itemId ?? '',
              description: tl.description ?? '',
              qty: Number(tl.qty),
              fetched: f,
              unitCost: f ? f.unitCost : '',
            };
          }),
    );
    validation.onBlur('lines');
  }

  function onSchemeChange(value: string) {
    setSchemeId(value);
    const pct = Number(schemes.find((s) => s.id === value)?.marginPct ?? 0);
    // A price the author never touched follows the margin; one they typed stays.
    setLines((prev) =>
      prev.map((l) => (!l.priceTouched && l.itemId && l.unitCost !== '' ? { ...l, unitPrice: suggest(Number(l.unitCost), pct) } : l)),
    );
  }

  function onCostChange(i: number, value: string) {
    setLines((prev) =>
      prev.map((l, idx) =>
        idx === i
          ? { ...l, unitCost: value, unitPrice: l.priceTouched || value === '' ? l.unitPrice : suggest(Number(value), marginPct) }
          : l,
      ),
    );
  }

  /** Open the form: a new revision (prefilled from the current one) or an edit of the current draft. */
  async function openForm(mode: 'create' | 'edit') {
    if (!proposal) return;
    const base = current;
    setForm({ mode, revisionId: mode === 'edit' ? base?.id : undefined });
    const keep = base && base.validUntil && base.validUntil.slice(0, 10) > dayKey(new Date()) ? base.validUntil.slice(0, 10) : '';
    setValidUntil(keep || inDays(proposal.settings.validityDays));
    setSchemeId('');
    setCapacityKwp(base?.designVersion ? String(Number(base.designVersion.capacityKwp)) : '');
    setAnnualKwh(base?.designVersion ? String(Number(base.designVersion.expectedAnnualKwh)) : '');
    // A revision keeps the pricing it was written in; the first one is a lump-sum budget.
    setPricingMode(base?.pricingMode ?? 'LUMP_SUM');
    setSellingTotal(base?.sellingTotal != null ? String(Number(base.sellingTotal)) : '');
    setContingencyPct(base?.contingencyPct != null && Number(base.contingencyPct) > 0 ? String(Number(base.contingencyPct)) : '');
    setRiskNotes(base?.riskNotes ?? '');
    setTemplateId(base?.templateId ?? '');
    validation.reset();
    if (!base || base.bomLines.length === 0) {
      setLines([blankLine()]);
      return;
    }
    const fetched = await fetchCosts([
      ...new Set(base.bomLines.map((l) => l.itemId).filter((x): x is string => !!x)),
    ]);
    const costBased = base.validUntil !== null; // made since the approval flow: unitPrice is the selling price
    setLines(
      base.bomLines.map((l) => {
        const w = l.workItemId ? (workItems.find((x) => x.id === l.workItemId) ?? null) : null;
        const f = l.itemId ? (fetched.get(l.itemId) ?? null) : w ? workItemCost(w) : null;
        const own = costBased && l.unitCost != null ? String(Number(l.unitCost)) : f ? f.unitCost : '';
        return {
          workItemId: l.workItemId ?? '',
          description: l.description ?? '',
          itemId: l.itemId ?? '',
          qty: Number(l.qty),
          unitCost: showCosts ? own : '',
          unitPrice: costBased && l.unitPrice != null ? String(Number(l.unitPrice)) : '',
          priceTouched: costBased && l.unitPrice != null,
          reason: l.costOverrideReason ?? '',
          fetched: f,
        };
      }),
    );
  }

  function closeForm() {
    setForm(null);
    setLines([blankLine()]);
    setSchemeId('');
    setCapacityKwp('');
    setAnnualKwh('');
    setPricingMode('LUMP_SUM');
    setSellingTotal('');
    setContingencyPct('');
    setRiskNotes('');
    setTemplateId('');
    validation.reset();
    draft.clear();
  }

  async function saveRevision(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    // Reveals every message at once rather than failing on the server.
    if (!validation.validateAll()) return;
    const valid = lines.filter((l) => filled(l) && l.qty > 0);
    const body = {
      validUntil,
      pricingMode,
      sellingTotal: lump && sellingTotal !== '' ? Number(sellingTotal) : undefined,
      // Contingency and risk notes are cost data: only a caller who may see costs sends them.
      contingencyPct: lump && showCosts && contingencyPct !== '' ? Number(contingencyPct) : undefined,
      riskNotes: lump && showCosts && riskNotes.trim() ? riskNotes.trim() : undefined,
      templateId: templateId || undefined,
      // The server refuses a pricing scheme from a caller without costs.view.
      pricingSchemeId: showCosts && !lump ? schemeId || undefined : undefined,
      bomLines: valid.map((l) => ({
        workItemId: l.workItemId || undefined,
        // A work item brings its own stock item; only a bare stock-item line names one.
        itemId: l.workItemId ? undefined : l.itemId || undefined,
        description: l.description.trim() || undefined,
        qty: Number(l.qty),
        unitPrice: !lump && l.unitPrice !== '' ? Number(l.unitPrice) : undefined,
        // Only a cost the author CHANGED is sent: otherwise the server's own fetch decides.
        unitCost: showCosts && costChanged(l) ? Number(l.unitCost) : undefined,
        costOverrideReason: showCosts && costChanged(l) ? l.reason.trim() : undefined,
      })),
      designVersion:
        capacityKwp || annualKwh
          ? { sourceTool: 'manual', capacityKwp: Number(capacityKwp) || 0, expectedAnnualKwh: Number(annualKwh) || 0 }
          : undefined,
    };
    const ok = await act(
      'revision',
      () =>
        form.mode === 'edit'
          ? api.patch(`/proposals/${id}/revisions/${form.revisionId}`, body)
          : api.post(`/proposals/${id}/revisions`, body),
      { success: form.mode === 'edit' ? t('common.done') : t('common.created') },
    );
    if (ok) {
      closeForm();
      load();
    }
  }

  async function submitForApproval() {
    if (!proposal) return;
    // Who will be asked to sign, as the approval matrix names it for this total.
    const role = proposal.submitTo ? (ar ? proposal.submitTo.nameAr : proposal.submitTo.nameEn) : t('proposals.theApprover');
    if (!(await confirm({ title: t('confirm.submitPropTitle'), message: t('confirm.submitPropMsg').replace('{role}', role) }))) return;
    if (await act('submit', () => api.post(`/proposals/${id}/submit`, {}), { success: t('common.done') })) load();
  }

  async function sendToCustomer() {
    if (!(await confirm({ title: t('confirm.sendPropTitle'), message: t('confirm.sendPropMsg') }))) return;
    // Reload on failure too: a 409 «expired» means the server has just moved the
    // revision to EXPIRED, and the page must show that, not a stale «approved».
    await act('send', () => api.post(`/proposals/${id}/send`, {}));
    load();
  }

  function openAccept(revId: string) {
    setAcceptFile(null);
    setAcceptErr('');
    setAcceptFor(revId);
  }

  /**
   * Package 3 · P3-8 (owner work cycle step 8): the customer's approval is filed
   * on the proposal, then the revision is accepted — the server refuses the
   * acceptance without a file filed since the quote was sent.
   */
  async function accept(e: FormEvent) {
    e.preventDefault();
    const revId = acceptFor;
    if (!revId) return;
    if (!acceptFile) {
      setAcceptErr(t('proposals.acceptFileRequired'));
      return;
    }
    setAcceptErr('');
    const ok = await act(`accept:${revId}`, async () => {
      await apiUpload(`/attachments/PROPOSAL/${id}`, acceptFile);
      await api.post(`/proposals/${id}/revisions/${revId}/accept`, {});
    });
    if (ok) setAcceptFor(null);
    setFilesKey((k) => k + 1);
    // Same as send: acceptance of a lapsed revision expires it server-side.
    load();
  }

  async function rejectByCustomer(e: FormEvent) {
    e.preventDefault();
    if (!rejectReason.trim()) {
      setRejectErr(t('proposals.rejectReasonRequired'));
      return;
    }
    setRejectErr('');
    if (await act('reject', () => api.post(`/proposals/${id}/reject`, { reason: rejectReason.trim() }))) {
      setRejectOpen(false);
      setRejectReason('');
      load();
    }
  }

  async function createContract(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!winning) return;
    const f = new FormData(e.currentTarget);
    // A milestone counts as filled with EITHER language; mirror the other so
    // Arabic-only entry no longer silently drops milestones.
    const milestones = [1, 2, 3]
      .map((n) => {
        const arText = String(f.get(`m${n}_ar`) || '').trim();
        const en = String(f.get(`m${n}_en`) || '').trim();
        return {
          sequence: n,
          descriptionAr: arText || en,
          descriptionEn: en || arText,
          amount: Number(f.get(`m${n}_amt`) || 0),
          triggerType: 'PROGRESS' as const,
        };
      })
      .filter((m) => m.amount > 0 && m.descriptionEn);

    // A row with a description but no amount (or the reverse) was silently
    // discarded by the filter above — the contract came out short and nothing
    // said why. Name it instead of dropping it.
    const partial = [1, 2, 3].filter((n) => {
      const desc = String(f.get(`m${n}_ar`) || '').trim() || String(f.get(`m${n}_en`) || '').trim();
      const amt = Number(f.get(`m${n}_amt`) || 0);
      return (desc && amt <= 0) || (!desc && amt > 0);
    });
    if (partial.length > 0) {
      setContractErr(t('valid.milestonePartial').replace('{n}', partial.join('، ')));
      return;
    }
    if (milestones.length === 0) {
      setContractErr(t('valid.needMilestone'));
      return;
    }
    setContractErr('');

    let cid: string | null = null;
    const ok = await act('contract', async () => {
      const c = await api.post<{ id: string }>('/contracts', {
        proposalRevisionId: winning.id,
        contractType: f.get('contractType'),
        retentionPct: Number(f.get('retentionPct') || 0),
        advancePct: Number(f.get('advancePct') || 0),
        milestones,
      });
      cid = c.id;
    });
    if (ok && cid) router.push(`/contracts/${cid}`);
  }

  if (loadErr) return <LoadError message={loadErr} onRetry={load} />;
  if (!proposal) return <PageSkeleton stats={2} />;

  const sourceLabel = (code: string | null | undefined) => {
    if (!code) return '—';
    const o = enums?.costSources?.find((x) => x.value === code);
    return o ? (ar ? o.labelAr : o.labelEn) : code;
  };

  // The three helpers below are plain render functions, not components: a component
  // defined inside this one would be a new type on every render and remount (collapsing
  // an opened <details>, dropping focus) each time the form state changes.

  /** Green when fresh, yellow when old, grey when the age is unknown (a catalogue cost). */
  function costAgeBadge(line: BomLine) {
    const days = line.costAgeDays;
    if (days === null || days === undefined) {
      return <span className="badge bg-slate-100 text-slate-600">{t('proposals.costUnknown')}</span>;
    }
    return days > proposal!.settings.costAgeWarnDays ? (
      <span className="badge bg-warning-50 text-warning-700">
        <Icon name="alert-triangle" className="h-3 w-3" />
        {t('proposals.costStale').replace('{n}', String(days))}
      </span>
    ) : (
      <span className="badge bg-success-50 text-success-700">{t('proposals.costFresh').replace('{n}', String(days))}</span>
    );
  }

  /** The status strip: where the proposal stands and what is owed, in a sentence. */
  function renderBanner() {
    if (!current) return null;
    const last = proposal!.history[proposal!.history.length - 1];
    const returned = current.status === 'DRAFT' && last?.actionCode === 'RETURN';
    const pend = proposal!.pendingApproval;
    const waiting = pend?.steps.find((s) => s.sequence === pend.currentStep);
    let tone = 'border-slate-200 bg-slate-50 text-slate-700';
    let text = '';
    if (current.status === 'PENDING_APPROVAL') {
      tone = 'border-warning-200 bg-warning-50/60 text-warning-900';
      text = t('proposals.banner.pending')
        .replace('{role}', waiting ? (ar ? waiting.role.nameAr : waiting.role.nameEn) : '—')
        .replace('{date}', formatDateTime(pend?.createdAt ?? current.submittedAt, locale));
    } else if (current.status === 'APPROVED') {
      tone = 'border-success-200 bg-success-50/60 text-success-800';
      text = t('proposals.banner.approved');
    } else if (current.status === 'SENT') {
      tone = 'border-info-200 bg-info-50/60 text-info-800';
      text = t('proposals.banner.sent').replace('{date}', formatDay(current.sentAt, locale));
    } else if (current.status === 'EXPIRED') {
      tone = 'border-danger-200 bg-danger-50/60 text-danger-800';
      text = t('proposals.banner.expired').replace('{date}', formatDay(current.validUntil, locale));
    } else if (current.status === 'REJECTED') {
      tone = 'border-danger-200 bg-danger-50/60 text-danger-800';
      text = t('proposals.banner.rejected');
    } else if (current.status === 'ACCEPTED') {
      tone = 'border-success-200 bg-success-50/60 text-success-800';
      text = t('proposals.banner.accepted');
    } else if (returned) {
      tone = 'border-warning-200 bg-warning-50/60 text-warning-900';
      text = t('proposals.banner.returned').replace('{note}', last?.comment ?? '');
    }
    if (!text) return null;
    return (
      <div className={`mb-4 rounded-xl border p-4 ${tone}`} aria-live="polite" aria-atomic="true">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <Icon name={current.status === 'PENDING_APPROVAL' ? 'stamp' : current.status === 'EXPIRED' ? 'alert-triangle' : 'check-circle'} className="h-4 w-4" />
          {text}
          {current.status === 'PENDING_APPROVAL' && canApprove && (
            <Link href="/approvals" className="ms-2 text-xs font-semibold underline">
              {t('proposals.openInbox')}
            </Link>
          )}
        </div>
        {current.status === 'PENDING_APPROVAL' && pend && (
          <div className="mt-3">
            <ApprovalChain request={pend} />
          </div>
        )}
      </div>
    );
  }

  const urgentValidity = (rev: Revision) => {
    if (!rev.validUntil || !['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(rev.status)) return false;
    const left = daysUntil(rev.validUntil);
    return left !== null && left <= 7;
  };

  function renderRevision(rev: Revision) {
    const isCurrent = current?.id === rev.id;
    const superseded = rev.status === 'SUPERSEDED';
    const costBased = rev.validUntil !== null;
    const newer = rev.supersededById ? proposal!.revisions.find((r) => r.id === rev.supersededById) : null;
    // A lump-sum budget has no line prices: the lines carry cost, the head carries the price.
    const revLump = rev.pricingMode === 'LUMP_SUM';
    const showPriceCols = !revLump && (costBased || showCosts);
    const body = (
      <>
        {rev.designVersion && (
          <p className="mb-3 text-xs text-slate-500">
            {t('proposals.design')}: {Number(rev.designVersion.capacityKwp)} kWp · {Number(rev.designVersion.expectedAnnualKwh)} kWh/y
          </p>
        )}
        {!costBased && showCosts && <p className="mb-2 text-xs text-slate-500">{t('proposals.legacyNote')}</p>}
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-500">
                <th scope="col" className="th">{t('proposals.item')}</th>
                <th scope="col" className="th text-end">{t('proposals.qty')}</th>
                {costBased && showCosts && <th scope="col" className="th text-end">{t('proposals.cost')}</th>}
                {costBased && showCosts && <th scope="col" className="th">{t('proposals.costSource')}</th>}
                {revLump && showCosts && <th scope="col" className="th text-end">{t('budget.lineCost')}</th>}
                {showPriceCols && (
                  <th scope="col" className="th text-end">{costBased ? t('proposals.sellingPrice') : t('proposals.unitPrice')}</th>
                )}
                {showPriceCols && <th scope="col" className="th text-end">{t('proposals.lineTotal')}</th>}
              </tr>
            </thead>
            <tbody>
              {rev.bomLines.map((bl) => {
                const manual = bl.costSource === 'MANUAL';
                return (
                  <tr key={bl.id} className={`border-b border-slate-50 ${manual && showCosts ? 'bg-warning-50/70' : ''}`}>
                    <td className="py-2">
                      <div>
                        {bl.workItem
                          ? `${bl.workItem.code} · ${pick(bl.workItem, 'name')}`
                          : bl.item
                            ? `${bl.item.sku} · ${pick(bl.item, 'name')}`
                            : '—'}
                      </div>
                      {bl.description && <div className="text-xs text-slate-500">{bl.description}</div>}
                      {manual && showCosts && (
                        <div className="mt-0.5 flex items-start gap-1 text-xs text-warning-800">
                          <Icon name="alert-triangle" className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>
                            {t('proposals.overridden')}
                            {bl.costOverrideReason ? ` — ${t('proposals.overrideReason')}: ${bl.costOverrideReason}` : ''}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="td-num">
                      {Number(bl.qty)}
                      {(bl.uom ?? bl.workItem?.uom) && <span className="ms-1 text-xs text-slate-400">{bl.uom ?? bl.workItem?.uom}</span>}
                    </td>
                    {costBased && showCosts && (
                      <td className="td-num">
                        {manual && bl.originalUnitCost != null && (
                          <s className="me-1.5 text-xs text-slate-400" title={t('proposals.originalCost')}>
                            {formatMoney(bl.originalUnitCost, locale)}
                          </s>
                        )}
                        <span className={manual ? 'font-semibold text-warning-800' : ''}>{formatMoney(bl.unitCost ?? 0, locale)}</span>
                      </td>
                    )}
                    {costBased && showCosts && (
                      <td className="td">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-slate-600">{sourceLabel(bl.costSource)}</span>
                          {costAgeBadge(bl)}
                        </div>
                      </td>
                    )}
                    {revLump && showCosts && (
                      <td className="td-num">{formatMoney((Number(bl.qty) || 0) * (Number(bl.unitCost) || 0), locale)}</td>
                    )}
                    {showPriceCols && <td className="td-num">{formatMoney(bl.unitPrice ?? 0, locale)}</td>}
                    {showPriceCols && <td className="td-num">{formatMoney(bl.lineTotal ?? 0, locale)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-col items-end gap-1 text-sm">
          {showCosts && (
            <>
              <span className="text-slate-500">
                {revLump ? t('budget.estimatedCost') : costBased ? t('proposals.cost') : t('proposals.subtotal')}:{' '}
                {formatMoney(rev.subtotal ?? 0, locale)}
              </span>
              {revLump && Number(rev.contingencyAmount ?? 0) > 0 && (
                <span className="text-slate-500">
                  {t('budget.contingency')} ({Number(rev.contingencyPct ?? 0)}%): {formatMoney(rev.contingencyAmount ?? 0, locale)}
                </span>
              )}
              <span className={`text-slate-500 ${Number(rev.marginAmount ?? 0) < 0 ? 'font-semibold text-danger-600' : ''}`}>
                {revLump ? t('budget.profit') : t('proposals.margin')}: {formatMoney(rev.marginAmount ?? 0, locale)}
                {revLump && Number(rev.totalAmount) > 0 && (
                  <> · {((Number(rev.marginAmount ?? 0) / Number(rev.totalAmount)) * 100).toFixed(1)}%</>
                )}
              </span>
              {revLump && rev.riskNotes && (
                <span className="max-w-xl text-end text-xs text-slate-500">
                  {t('budget.riskNotes')}: {rev.riskNotes}
                </span>
              )}
            </>
          )}
          <span className="text-lg font-bold text-slate-900">
            {t('common.total')}: {formatMoney(rev.totalAmount, locale)}
          </span>
        </div>
        {rev.isWinning && canWrite && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            {proposal!.contracts.length === 0 ? (
              <Btn variant="primary" icon="file-signature" onClick={() => setContractOpen(true)}>
                {t('proposals.createContract')}
              </Btn>
            ) : (
              <Link href={`/contracts/${proposal!.contracts[0].id}`} className="text-sm font-semibold text-brand-700 underline">
                {proposal!.contracts[0].code}
              </Link>
            )}
          </div>
        )}
      </>
    );

    const head = (
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold text-slate-800">
          {/* Owner work cycle step 6: an estimated budget becomes the quote once approved. */}
          {rev.pricingMode === 'LUMP_SUM'
            ? ['DRAFT', 'PENDING_APPROVAL'].includes(rev.status)
              ? t('budget.title')
              : t('budget.quote')
            : t('proposals.revision')}{' '}
          #{rev.revisionNo}
        </span>
        <StatusBadge status={rev.status} />
        {isCurrent && !superseded && <span className="badge bg-brand-50 text-brand-700">{t('proposals.current')}</span>}
        {rev.isWinning && (
          <span className="badge bg-success-100 text-success-700">
            <Icon name="star" className="h-3 w-3" />
            {t('proposals.accepted')}
          </span>
        )}
        {superseded && newer && (
          <span className="text-xs text-slate-500">{t('proposals.supersededBy').replace('{n}', String(newer.revisionNo))}</span>
        )}
        {rev.validUntil && (
          <span className={`inline-flex items-center gap-1 text-xs ${urgentValidity(rev) ? 'font-semibold text-danger-600' : 'text-slate-500'}`}>
            {urgentValidity(rev) && <Icon name="alert-triangle" className="h-3 w-3" />}
            {t('proposals.validUntil')}: {formatDay(rev.validUntil, locale)}
          </span>
        )}
        {rev.createdBy && (
          <span className="text-xs text-slate-500">
            {t('proposals.createdBy')}: {ar ? rev.createdBy.nameAr : rev.createdBy.nameEn}
          </span>
        )}
      </div>
    );

    // A superseded revision stays on the page for the record, folded and grey.
    if (superseded) {
      return (
        <details className="card bg-slate-50/70 p-4 opacity-80">
          <summary className="cursor-pointer list-none">{head}</summary>
          <div className="mt-3">{body}</div>
        </details>
      );
    }
    return (
      <div className="card p-5">
        <div className="mb-3">{head}</div>
        {body}
      </div>
    );
  }

  const formOpen = form !== null;
  const reviseAvailable = has('REVISE') && !formOpen;
  const canEditDraft = canWrite && current?.status === 'DRAFT' && !formOpen;

  return (
    <div>
      <PageHeader
        title={`${proposal.code} · ${proposal.opportunity.name}`}
        backHref="/proposals"
        backLabel={t('proposals.title')}
        action={<StatusBadge status={proposal.status} />}
      />

      {renderBanner()}

      {/* P3-7: an approved budget is the quote — print it (browser PDF). */}
      {current && ['APPROVED', 'SENT', 'ACCEPTED'].includes(current.status) && (
        <div className="mb-3 flex justify-end">
          <Link href={`/proposals/${proposal.id}/print?revision=${current.revisionNo}`} className="btn-ghost text-xs">
            <Icon name="printer" className="me-1.5 inline h-4 w-4" />
            {t('quote.print')}
          </Link>
        </div>
      )}

      {/* What the engine allows on the current revision, as buttons. */}
      {canWrite && !formOpen && (canEditDraft || has('SUBMIT') || has('SEND') || has('ACCEPT') || has('REJECT') || reviseAvailable) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {canEditDraft && (
            <Btn icon="undo" onClick={() => openForm('edit')} disabled={busy()}>
              {t('proposals.edit')}
            </Btn>
          )}
          {has('SUBMIT') && (
            <Btn variant="primary" icon="stamp" busy={busy('submit')} disabled={busy()} onClick={submitForApproval}>
              {t('proposals.submit')}
            </Btn>
          )}
          {has('SEND') && (
            <Btn variant="primary" icon="file-text" busy={busy('send')} disabled={busy()} onClick={sendToCustomer}>
              {t('proposals.send')}
            </Btn>
          )}
          {has('ACCEPT') && current && (
            <Btn variant="solar" icon="check" busy={busy(`accept:${current.id}`)} disabled={busy()} onClick={() => openAccept(current.id)}>
              {t('proposals.customerAccept')}
            </Btn>
          )}
          {has('REJECT') && (
            <Btn variant="danger" icon="x" disabled={busy()} onClick={() => { setRejectReason(''); setRejectErr(''); setRejectOpen(true); }}>
              {t('proposals.customerReject')}
            </Btn>
          )}
          {reviseAvailable && (
            <Btn icon="plus" disabled={busy()} onClick={() => openForm('create')}>
              {t('proposals.revise')}
            </Btn>
          )}
        </div>
      )}

      {/* Revisions, newest first. */}
      <div className="space-y-4">
        {revisions.length === 0 && <p className="card p-5 text-sm text-slate-500">{t('proposals.noRevisions')}</p>}
        {revisions.map((rev) => (
          <Fragment key={rev.id}>{renderRevision(rev)}</Fragment>
        ))}
      </div>

      {/* The form: a new revision, or an edit of the current draft. */}
      {formOpen && canWrite && (
        <form onSubmit={saveRevision} className="card mt-6 p-5">
          <h3 className="mb-4 font-semibold text-slate-800">
            {form?.mode === 'edit' ? t('proposals.editRevision') : t('proposals.newRevision')}
          </h3>

          {draft.restored && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-info-50 px-3 py-2 text-xs text-info-800">
              <span className="flex items-center gap-1.5">
                <Icon name="undo" className="h-3.5 w-3.5" />
                {t('draft.restored')}
              </span>
              <button type="button" className="font-semibold underline" onClick={closeForm}>
                {t('draft.discard')}
              </button>
            </div>
          )}

          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label={t('budget.pricingMode')} hint={lump ? t('budget.lumpHint') : undefined}>
              <select
                className="input"
                value={pricingMode}
                onChange={(e) => {
                  setPricingMode(e.target.value as 'PER_LINE' | 'LUMP_SUM');
                  validation.onBlur('lines');
                }}
              >
                <option value="LUMP_SUM">{t('budget.mode.LUMP_SUM')}</option>
                <option value="PER_LINE">{t('budget.mode.PER_LINE')}</option>
              </select>
            </Field>
            {lump && (
              <Field label={t('budget.sellingTotal')}>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  className="input"
                  value={sellingTotal}
                  onChange={(e) => setSellingTotal(e.target.value)}
                />
              </Field>
            )}
            {lump && showCosts && (
              <Field label={t('budget.contingencyPct')}>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  max={100}
                  className="input"
                  value={contingencyPct}
                  onChange={(e) => setContingencyPct(e.target.value)}
                />
              </Field>
            )}
            <Field label={t('proposals.validUntilField')} error={validation.errorOf('validUntil')} hint={t('proposals.validHint')}>
              <input
                type="date"
                className="input"
                value={validUntil}
                min={inDays(1)}
                onChange={(e) => setValidUntil(e.target.value)}
                onBlur={() => validation.onBlur('validUntil')}
              />
            </Field>
            {showCosts && !lump && (
              <Field label={t('proposals.pricingScheme')}>
                <select className="input" value={schemeId} onChange={(e) => onSchemeChange(e.target.value)}>
                  <option value="">{t('proposals.marginPct')}: 0%</option>
                  {schemes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {pick(s, 'name')} ({Number(s.marginPct)}%)
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t('proposals.capacity')} error={validation.errorOf('capacityKwp')}>
              <input
                type="number"
                step="0.001"
                min={0}
                className="input"
                value={capacityKwp}
                onChange={(e) => setCapacityKwp(e.target.value)}
                onBlur={() => validation.onBlur('capacityKwp')}
              />
            </Field>
            <Field label={t('proposals.annualKwh')} error={validation.errorOf('annualKwh')}>
              <input
                type="number"
                step="0.01"
                min={0}
                className="input"
                value={annualKwh}
                onChange={(e) => setAnnualKwh(e.target.value)}
                onBlur={() => validation.onBlur('annualKwh')}
              />
            </Field>
          </div>

          {lump && showCosts && (
            <div className="mb-4">
              <Field label={t('budget.riskNotes')}>
                <textarea
                  className="input min-h-[60px]"
                  maxLength={4000}
                  value={riskNotes}
                  onChange={(e) => setRiskNotes(e.target.value)}
                />
              </Field>
            </div>
          )}

          <div className="flex flex-wrap items-end justify-between gap-2">
            <label className="label">{lump ? t('budget.lines') : t('proposals.bom')}</label>
            {templateList.state === 'ready' && templateList.rows.length > 0 && (
              <select
                aria-label={t('budget.fromTemplate')}
                className="input mb-2 w-auto"
                value=""
                onChange={(e) => applyTemplate(e.target.value)}
              >
                <option value="">{t('budget.fromTemplate')}…</option>
                {templateList.rows.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.code} · {pick(tpl, 'name')}
                  </option>
                ))}
              </select>
            )}
          </div>
          {showCosts && !lump && <p className="mb-2 text-xs text-slate-500">{t('proposals.marginHint')}</p>}
          {workItemList.state === 'unavailable' && (
            <p className="mb-2 text-xs text-slate-500">{t('lookup.unavailable')}</p>
          )}
          {itemList.state === 'unavailable' && (
            <p className="mb-2 text-xs text-slate-500">{t('lookup.unavailable')}</p>
          )}
          {validation.errorOf('lines') && (
            <p role="alert" className="mb-2 text-xs font-medium text-danger-600">
              {validation.errorOf('lines')}
            </p>
          )}
          <div className="space-y-3">
            {lines.map((l, i) => {
              const changed = showCosts && costChanged(l);
              return (
                <div key={i} className={`rounded-lg border p-2 ${changed ? 'border-warning-300 bg-warning-50/50' : 'border-transparent'}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={t('budget.workItem')}
                      className="input min-w-[12rem] flex-1"
                      value={l.workItemId}
                      onChange={(e) => onWorkItemChange(i, e.target.value)}
                      disabled={workItemList.state === 'unavailable'}
                    >
                      <option value="">{lump ? `${t('budget.workItem')} —` : `${t('budget.workItem')} (${t('common.optional')})`}</option>
                      {workItems.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code} · {pick(w, 'name')}
                        </option>
                      ))}
                    </select>
                    {!lump && !l.workItemId && (
                      <select
                        aria-label={t('proposals.item')}
                        className="input min-w-[12rem] flex-1"
                        value={l.itemId}
                        onChange={(e) => onItemChange(i, e.target.value)}
                        disabled={itemList.state === 'unavailable'}
                      >
                        <option value="">—</option>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.sku} · {pick(it, 'name')}
                          </option>
                        ))}
                      </select>
                    )}
                    <input
                      type="number"
                      step="0.001"
                      min={0}
                      className={`input w-24 ${filled(l) && (!l.qty || l.qty <= 0) ? '!border-danger-300' : ''}`}
                      aria-label={t('proposals.qty')}
                      placeholder={t('proposals.qty')}
                      value={l.qty}
                      onChange={(e) => updateLine(i, { qty: Number(e.target.value) })}
                      onBlur={() => validation.onBlur('lines')}
                    />
                    {showCosts && (
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        className="input w-28"
                        aria-label={t('proposals.cost')}
                        placeholder={t('proposals.cost')}
                        value={l.unitCost}
                        onChange={(e) => onCostChange(i, e.target.value)}
                      />
                    )}
                    {!lump && (
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        className="input w-28"
                        aria-label={t('proposals.sellingPrice')}
                        placeholder={t('proposals.sellingPrice')}
                        value={l.unitPrice}
                        onChange={(e) => updateLine(i, { unitPrice: e.target.value, priceTouched: true })}
                        onBlur={() => validation.onBlur('lines')}
                      />
                    )}
                    {(!lump || showCosts) && (
                      <span className="w-28 text-end text-sm text-slate-500">
                        {formatMoney((Number(l.qty) || 0) * (Number(lump ? l.unitCost : l.unitPrice) || 0), locale)}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`${t('proposals.removeLine')} ${i + 1}`}
                      className="rounded-md p-1.5 text-slate-500 transition hover:bg-danger-50 hover:text-danger-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-300"
                      onClick={() => removeLine(i)}
                    >
                      <Icon name="x" className="h-4 w-4" />
                    </button>
                  </div>
                  {filled(l) && (
                    <input
                      className="input mt-1.5 w-full text-xs"
                      aria-label={t('budget.description')}
                      placeholder={`${t('budget.description')} (${t('common.optional')})`}
                      maxLength={500}
                      value={l.description}
                      onChange={(e) => updateLine(i, { description: e.target.value })}
                    />
                  )}
                  {showCosts && l.fetched && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{sourceLabel(l.fetched.costSource)}</span>
                      {l.fetched.costAgeDays === null ? (
                        <span className="badge bg-slate-100 text-slate-600">{t('proposals.costUnknown')}</span>
                      ) : l.fetched.stale ? (
                        <span className="badge bg-warning-50 text-warning-700">
                          <Icon name="alert-triangle" className="h-3 w-3" />
                          {t('proposals.costStale').replace('{n}', String(l.fetched.costAgeDays))}
                        </span>
                      ) : (
                        <span className="badge bg-success-50 text-success-700">
                          {t('proposals.costFresh').replace('{n}', String(l.fetched.costAgeDays))}
                        </span>
                      )}
                      {changed && (
                        <span className="text-slate-400">
                          {t('proposals.originalCost')}: <s>{formatMoney(l.fetched.unitCost, locale)}</s>
                        </span>
                      )}
                    </div>
                  )}
                  {changed && (
                    <div className="mt-2">
                      <input
                        className={`input w-full ${!l.reason.trim() ? '!border-warning-400' : ''}`}
                        aria-label={t('proposals.overrideReason')}
                        placeholder={`${t('proposals.overrideReason')} *`}
                        value={l.reason}
                        maxLength={300}
                        onChange={(e) => updateLine(i, { reason: e.target.value })}
                        onBlur={() => validation.onBlur('lines')}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <button type="button" className="btn-ghost mt-2 text-xs" onClick={addLine}>
            + {t('proposals.addLine')}
          </button>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <div className="text-sm text-slate-600">
              {showCosts && (
                <>
                  {lump ? t('budget.estimatedCost') : t('proposals.cost')}: {formatMoney(draftSubtotal, locale)} ·{' '}
                  {lump && draftContingency > 0 && (
                    <>
                      {t('budget.contingency')}: {formatMoney(draftContingency, locale)} ·{' '}
                    </>
                  )}
                  {lump && (
                    <span className={draftProfit < 0 ? 'font-semibold text-danger-600' : ''}>
                      {t('budget.profit')}: {formatMoney(draftProfit, locale)}
                      {draftMarginPct !== null && <> ({draftMarginPct.toFixed(1)}%)</>} ·{' '}
                    </span>
                  )}
                </>
              )}
              <span className="font-semibold text-slate-900">
                {lump ? t('budget.sellingTotal') : t('common.total')}: {formatMoney(draftTotal, locale)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {(proposal.revisions.length > 0 || form?.mode === 'edit') && <Btn onClick={closeForm}>{t('common.cancel')}</Btn>}
              <Btn type="submit" variant="primary" icon={form?.mode === 'edit' ? 'check' : 'plus'} busy={busy('revision')} disabled={busy()}>
                {form?.mode === 'edit' ? t('proposals.saveRevision') : t('proposals.addRevision')}
              </Btn>
            </div>
          </div>
        </form>
      )}

      {/* The proposal's own trail: who moved it, when, and what they said. */}
      {proposal.history.length > 0 && (
        <details className="card mt-6 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">{t('proposals.history')}</summary>
          <ol className="mt-3 space-y-2 text-xs text-slate-600">
            {proposal.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-2 border-b border-slate-50 pb-2">
                <span className="text-slate-400">{formatDateTime(h.createdAt, locale)}</span>
                <span className="font-semibold">{h.toStateName ? (ar ? h.toStateName.nameAr : h.toStateName.nameEn) : h.actionCode}</span>
                <span>{h.actor ? (ar ? h.actor.nameAr : h.actor.nameEn) : '—'}</span>
                {h.comment && <span className="italic text-slate-500">“{h.comment}”</span>}
              </li>
            ))}
          </ol>
        </details>
      )}

      {/* P3-8: files on the proposal — the customer's approval among them. */}
      {can('platform.attachment.read') && (
        <div className="mt-6">
          <AttachmentsCard key={filesKey} entityType="PROPOSAL" entityId={proposal.id} />
        </div>
      )}

      {/* The customer's acceptance: their written approval is attached first. */}
      <Modal open={acceptFor !== null} title={t('confirm.acceptRevTitle')} onClose={() => setAcceptFor(null)} dirty={!!acceptFile}>
        <form onSubmit={accept} className="grid gap-4">
          <p className="text-sm text-slate-600">{t('confirm.acceptRevMsg')}</p>
          <Field label={t('proposals.acceptFile')} error={acceptErr || undefined} hint={t('proposals.acceptFileHint')}>
            <input
              type="file"
              className="input"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.docx"
              onChange={(e) => setAcceptFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setAcceptFor(null)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="solar" icon="check" busy={busy(`accept:${acceptFor}`)} disabled={busy()}>
              {t('proposals.customerAccept')}
            </Btn>
          </div>
        </form>
      </Modal>

      {/* The customer's refusal: the reason is mandatory. */}
      <Modal open={rejectOpen} title={t('proposals.rejectTitle')} onClose={() => setRejectOpen(false)} dirty={rejectReason.trim().length > 0}>
        <form onSubmit={rejectByCustomer} className="grid gap-4">
          <Field label={t('proposals.rejectReason')} error={rejectErr || undefined}>
            <textarea className="input min-h-[80px]" maxLength={500} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setRejectOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="danger" busy={busy('reject')} disabled={busy()}>
              {t('proposals.customerReject')}
            </Btn>
          </div>
        </form>
      </Modal>

      {/* Create-contract modal */}
      <Modal open={contractOpen} title={t('proposals.createContract')} onClose={() => setContractOpen(false)}>
        <form onSubmit={createContract} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t('contracts.type')}>
              <select name="contractType" className="input" defaultValue="EPC">
                {enums?.contractTypes.map((o) => (
                  <option key={o.value} value={o.value}>
                    {ar ? o.labelAr : o.labelEn}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('contracts.retention')}>
              <input name="retentionPct" type="number" step="0.1" className="input" defaultValue="5" />
            </Field>
            <Field label={t('contracts.advance')}>
              <input name="advancePct" type="number" step="0.1" className="input" defaultValue="20" />
            </Field>
          </div>

          <p className="text-xs font-medium text-slate-500">{t('contracts.milestones')}</p>
          {contractErr && (
            <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-xs font-medium text-danger-700">
              {contractErr}
            </p>
          )}
          {[1, 2, 3].map((n) => (
            <div key={n} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <input name={`m${n}_ar`} className="input" placeholder={`مرحلة ${n} (ع)`} />
              <input name={`m${n}_en`} className="input" placeholder={`Milestone ${n} (en)`} />
              <input
                name={`m${n}_amt`}
                type="number"
                step="0.01"
                className="input col-span-2"
                placeholder={t('contracts.amount')}
              />
            </div>
          ))}

          <p className="text-xs text-slate-500">
            {t('common.value')}: {winning ? formatMoney(winning.totalAmount, locale) : '—'}
          </p>

          <div className="flex justify-end gap-2">
            <Btn onClick={() => setContractOpen(false)}>{t('common.cancel')}</Btn>
            <Btn type="submit" variant="primary" busy={busy('contract')} disabled={busy()}>
              {t('proposals.createContract')}
            </Btn>
          </div>
        </form>
      </Modal>
      {confirmNode}
    </div>
  );
}
