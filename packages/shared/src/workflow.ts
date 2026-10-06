/**
 * The workflow engine's shared contract — M4, المرحلة الأولى.
 *
 * Flow codes, action codes, event codes and the tiny condition language all
 * live here rather than in the API, for the same reason the approval matrix's
 * contract does: the web app renders these strings, the API validates against
 * them, and the seed writes them. Three copies of a string is how a flow ends
 * up with a transition nobody can trigger.
 *
 * What is deliberately *not* here: the flows themselves. Which states exist
 * and which moves are legal is data (wf_definitions / wf_states /
 * wf_transitions), seeded per organization and editable without a deploy.
 */

// ── flows ───────────────────────────────────────────────────────────────────

export const WF_FLOWS = {
  PURCHASE_REQUISITION: 'PURCHASE_REQUISITION',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
  GOODS_RECEIPT: 'GOODS_RECEIPT',
  VENDOR_BILL: 'VENDOR_BILL',
} as const;

export type WfFlowCode = (typeof WF_FLOWS)[keyof typeof WF_FLOWS];

/**
 * The Prisma model each flow governs. The engine stores it on the instance so
 * a task box can render "purchase order PO-00021" without knowing which
 * module owns it.
 */
export const WF_FLOW_DOCUMENT_TYPE: Record<WfFlowCode, string> = {
  PURCHASE_REQUISITION: 'PurchaseRequisition',
  PURCHASE_ORDER: 'PurchaseOrder',
  GOODS_RECEIPT: 'GoodsReceipt',
  VENDOR_BILL: 'VendorBill',
};

export interface WfFlowMeta {
  code: WfFlowCode;
  documentType: string;
  labelAr: string;
  labelEn: string;
  /** Web route of a document in this flow, `:id` substituted by the caller. */
  linkPattern: string;
}

export const WF_FLOWS_META: WfFlowMeta[] = [
  {
    code: 'PURCHASE_REQUISITION',
    documentType: 'PurchaseRequisition',
    labelAr: 'طلب شراء',
    labelEn: 'Purchase requisition',
    linkPattern: '/requisitions/:id',
  },
  {
    code: 'PURCHASE_ORDER',
    documentType: 'PurchaseOrder',
    labelAr: 'أمر شراء',
    labelEn: 'Purchase order',
    linkPattern: '/procurement/:id',
  },
  {
    code: 'GOODS_RECEIPT',
    documentType: 'GoodsReceipt',
    labelAr: 'محضر استلام',
    labelEn: 'Goods receipt',
    linkPattern: '/procurement/:id',
  },
  {
    code: 'VENDOR_BILL',
    documentType: 'VendorBill',
    labelAr: 'فاتورة مورّد',
    labelEn: 'Vendor bill',
    linkPattern: '/payables',
  },
];

export const WF_FLOW_META_BY_DOCUMENT: Record<string, WfFlowMeta> = Object.fromEntries(
  WF_FLOWS_META.map((f) => [f.documentType, f]),
);

// ── actions ─────────────────────────────────────────────────────────────────

/**
 * What a user can ask the engine to do. The same verb means the same thing in
 * every flow — SUBMIT always hands a document to its approvers, RETURN always
 * sends it back to its author with a reason.
 */
export const WF_ACTIONS = {
  SUBMIT: 'SUBMIT',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  RETURN: 'RETURN',
  CANCEL: 'CANCEL',
  SEND: 'SEND',
  INSPECT: 'INSPECT',
  ACCEPT: 'ACCEPT',
  REJECT_PARTIAL: 'REJECT_PARTIAL',
  MATCH: 'MATCH',
  SCHEDULE: 'SCHEDULE',
  PAY: 'PAY',
  RECEIVE: 'RECEIVE',
  CLOSE: 'CLOSE',
  CONVERT: 'CONVERT',
} as const;

export type WfActionCode = (typeof WF_ACTIONS)[keyof typeof WF_ACTIONS];

/**
 * Actions whose meaning is "this did not pass". The engine requires a comment
 * on these: a rejection with no reason is the thing that makes the person who
 * raised the document ask a human what happened, which is the whole cost the
 * workflow was supposed to remove.
 */
export const WF_ACTIONS_REQUIRING_COMMENT: readonly string[] = [
  WF_ACTIONS.REJECT,
  WF_ACTIONS.RETURN,
  WF_ACTIONS.REJECT_PARTIAL,
  WF_ACTIONS.CANCEL,
];

// ── events ──────────────────────────────────────────────────────────────────

/**
 * The outbox vocabulary. §6 of the architecture names the first three; the
 * rest are the ones the purchasing cycle needs to close.
 */
export const WF_EVENTS = {
  PR_APPROVED: 'pr.approved',
  PO_APPROVED: 'po.approved',
  PO_SENT: 'po.sent',
  GOODS_RECEIVED: 'goods.received',
  INVOICE_MATCHED: 'invoice.matched',
  INVOICE_APPROVED: 'invoice.approved',
  INVOICE_PAID: 'invoice.paid',
  // CRM Phase 1 (Step 2): a duplicate customer was merged into the surviving
  // record. Nothing subscribes yet; later steps (notifications, reports) may.
  CUSTOMER_MERGED: 'customer.merged',
} as const;

export type WfEventCode = (typeof WF_EVENTS)[keyof typeof WF_EVENTS];

export const WF_EVENT_LABELS: Record<string, { ar: string; en: string }> = {
  'pr.approved': { ar: 'اعتُمد طلب الشراء', en: 'Requisition approved' },
  'po.approved': { ar: 'اعتُمد أمر الشراء', en: 'Purchase order approved' },
  'po.sent': { ar: 'أُرسل أمر الشراء للمورّد', en: 'Purchase order sent to vendor' },
  'goods.received': { ar: 'قُبل الاستلام', en: 'Goods accepted' },
  'invoice.matched': { ar: 'طوبقت الفاتورة ثلاثياً', en: 'Invoice three-way matched' },
  'invoice.approved': { ar: 'اعتُمدت الفاتورة', en: 'Invoice approved' },
  'invoice.paid': { ar: 'سُددت الفاتورة', en: 'Invoice paid' },
  'customer.merged': { ar: 'دُمج عميل مكرر في السجل الباقي', en: 'Duplicate customer merged' },
};

// ── retry policy ────────────────────────────────────────────────────────────

/**
 * Back-off for a handler that threw, in minutes per attempt. A row that
 * exhausts the list is marked FAILED and stays visible rather than retrying
 * forever — an event that has failed six times over four hours is a bug
 * someone must look at, not a transient blip.
 */
export const EVENT_RETRY_BACKOFF_MINUTES: readonly number[] = [1, 5, 15, 60, 240];
export const EVENT_MAX_ATTEMPTS = EVENT_RETRY_BACKOFF_MINUTES.length;

/** Minutes to wait before attempt number `attempts + 1`. Null = give up. */
export const nextRetryDelayMinutes = (attempts: number): number | null =>
  attempts >= 0 && attempts < EVENT_RETRY_BACKOFF_MINUTES.length
    ? EVENT_RETRY_BACKOFF_MINUTES[attempts]
    : null;

// ── three-way match ─────────────────────────────────────────────────────────

/**
 * How far a vendor's invoice may differ from what was received before the
 * match refuses to pass it. One percent, not zero: rounding on a 3-decimal
 * quantity times a 2-decimal price will otherwise flag honest invoices.
 */
export const THREE_WAY_MATCH_TOLERANCE_PCT = 1;

export interface MatchInputs {
  orderedQty: number;
  receivedQty: number;
  billedQty: number;
  receivedValue: number;
  billedValue: number;
}

export type MatchResultCode = 'MATCHED' | 'QTY_VARIANCE' | 'PRICE_VARIANCE' | 'BOTH_VARIANCE';

const withinTolerance = (a: number, b: number, tolerancePct: number): boolean => {
  // Comparing to zero by ratio is undefined; compare absolutely instead, so a
  // billed quantity of 0 against a received 5 is a variance, not a divide-by-zero.
  if (b === 0) return Math.abs(a) < 1e-9;
  return Math.abs((a - b) / b) * 100 <= tolerancePct + 1e-9;
};

/**
 * Pure, so it is testable without a database and identical on both sides of
 * the wire. Quantity and price are judged separately because the remedies
 * differ: a quantity variance is a conversation with the warehouse, a price
 * variance is a conversation with the vendor.
 */
export const evaluateThreeWayMatch = (
  input: MatchInputs,
  tolerancePct: number = THREE_WAY_MATCH_TOLERANCE_PCT,
): MatchResultCode => {
  const qtyOk = withinTolerance(input.billedQty, input.receivedQty, tolerancePct);
  const valueOk = withinTolerance(input.billedValue, input.receivedValue, tolerancePct);
  if (qtyOk && valueOk) return 'MATCHED';
  if (!qtyOk && !valueOk) return 'BOTH_VARIANCE';
  return qtyOk ? 'PRICE_VARIANCE' : 'QTY_VARIANCE';
};

export const MATCH_RESULTS: Array<{ value: MatchResultCode; labelAr: string; labelEn: string }> = [
  { value: 'MATCHED', labelAr: 'مطابقة', labelEn: 'Matched' },
  { value: 'QTY_VARIANCE', labelAr: 'فرق كمية', labelEn: 'Quantity variance' },
  { value: 'PRICE_VARIANCE', labelAr: 'فرق سعر', labelEn: 'Price variance' },
  { value: 'BOTH_VARIANCE', labelAr: 'فرق كمية وسعر', labelEn: 'Quantity & price variance' },
];

// ── vendor bill status semantics ────────────────────────────────────────────

/**
 * The bill states that carry a posted liability. Reports and the payables
 * screen ask this, not a hardcoded list, so that adding a state between
 * approval and payment tomorrow cannot silently drop bills out of AP ageing.
 * 'POSTED' is here because rows written before M4 carry it and their journal
 * was posted at creation.
 */
export const BILL_STATUSES_WITH_AP_BALANCE: readonly string[] = [
  'APPROVED',
  'SCHEDULED',
  'POSTED',
  'PAID',
];

/** Bills that are settled and must not be offered for payment again. */
export const BILL_STATUSES_SETTLED: readonly string[] = ['PAID'];
