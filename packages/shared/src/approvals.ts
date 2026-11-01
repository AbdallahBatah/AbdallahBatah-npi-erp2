/**
 * The approval matrix's shared contract — package و.
 *
 * One table both sides read: the API validates against it (a rule may only
 * name roles that could actually act) and the web app renders its labels.
 * Adding a document type here is deliberately not enough to make it work —
 * the owning service must also register an applier — so this list stays
 * honest about what the matrix really covers.
 */
import { PERMISSIONS, type PermissionKey } from './permissions';

export type ApprovalDocumentType =
  | 'PURCHASE_REQUISITION'
  | 'PURCHASE_ORDER'
  | 'PROGRESS_CLAIM'
  | 'CHANGE_ORDER'
  // CRM Phase 1 · Step 4: a proposal is signed before it may be sent to the customer.
  | 'PROPOSAL'
  // Package 2 · P2-2: the contract, signed once before it may be activated.
  | 'CONTRACT'
  // Package 5 · P5-2: executing beyond a budget line's approved quantity.
  | 'EXECUTION_OVERRUN'
  // Package 7 · P7-1: closing a project on its handover.
  | 'PROJECT_CLOSURE'
  // Package 6: paying a vendor on request, and a petty-cash settlement.
  | 'VENDOR_PAYMENT_REQUEST'
  | 'PETTY_CASH_SETTLEMENT';

export interface ApprovalDocumentMeta {
  value: ApprovalDocumentType;
  labelAr: string;
  labelEn: string;
  /**
   * The permission a step's role must hold. Deciding an approval is the same
   * authority as performing the action — the matrix adds signatures, it never
   * hands new powers to a role that could not do the thing anyway.
   */
  permission: PermissionKey;
  /** What `amount` means for this document, so the UI can say so plainly. */
  amountLabelAr: string;
  amountLabelEn: string;
}

export const APPROVAL_DOCUMENTS: ApprovalDocumentMeta[] = [
  {
    value: 'PURCHASE_REQUISITION',
    labelAr: 'طلب شراء',
    labelEn: 'Purchase requisition',
    // Approving a requisition is procurement's authority, not the requester's.
    // The split is the point: raising one needs REQUISITION_WRITE, which every
    // engineer holds; approving one needs PROCUREMENT_APPROVE.
    permission: PERMISSIONS.PROCUREMENT_APPROVE,
    amountLabelAr: 'القيمة التقديرية للطلب',
    amountLabelEn: 'Estimated value of the request',
  },
  {
    value: 'PURCHASE_ORDER',
    labelAr: 'أمر شراء',
    labelEn: 'Purchase order',
    permission: PERMISSIONS.PROCUREMENT_APPROVE,
    amountLabelAr: 'إجمالي أمر الشراء شامل الضريبة',
    amountLabelEn: 'PO total including VAT',
  },
  {
    value: 'PROGRESS_CLAIM',
    labelAr: 'مستخلص مقاول من الباطن',
    labelEn: 'Subcontractor progress claim',
    permission: PERMISSIONS.PROCUREMENT_APPROVE,
    amountLabelAr: 'المبلغ المُطالَب به',
    amountLabelEn: 'Claimed amount',
  },
  {
    value: 'CHANGE_ORDER',
    labelAr: 'أمر تغيير',
    labelEn: 'Change order',
    permission: PERMISSIONS.PROJECT_APPROVE,
    amountLabelAr: 'قيمة التغيير المطلقة',
    amountLabelEn: 'Absolute value of the variation',
  },
  {
    value: 'PROPOSAL',
    labelAr: 'عرض سعر',
    labelEn: 'Proposal',
    // Raising a proposal needs PROPOSAL_WRITE (sales); signing one needs its own key.
    permission: PERMISSIONS.PROPOSAL_APPROVE,
    amountLabelAr: 'إجمالي العرض (سعر البيع)',
    amountLabelEn: 'Proposal total (selling price)',
  },
  {
    value: 'CONTRACT',
    labelAr: 'عقد',
    labelEn: 'Contract',
    // Owner decision 2026-10-29: the general manager's approval of the accepted
    // offer IS the contract's approval — one signature, the proposal's key. No
    // contract-approve key of its own (ADR-01 as amended).
    permission: PERMISSIONS.PROPOSAL_APPROVE,
    amountLabelAr: 'قيمة العقد',
    amountLabelEn: 'Contract value',
  },
  {
    value: 'EXECUTION_OVERRUN',
    labelAr: 'تجاوز كمية بند الموازنة',
    labelEn: 'Budget line overrun',
    // Owner decision 2026-10-29 (a): the projects GM and the general manager —
    // both hold the spending-approval key; no new key (Madar's catalogue pin).
    permission: PERMISSIONS.PROCUREMENT_APPROVE,
    amountLabelAr: 'الكمية الزائدة × تكلفة الوحدة في الموازنة',
    amountLabelEn: 'Extra quantity × the line\'s budgeted unit cost',
  },
  {
    value: 'PROJECT_CLOSURE',
    labelAr: 'إغلاق مشروع (تسليم)',
    labelEn: 'Project closure (handover)',
    // Owner work cycle step 16: the projects GM and the general manager approve
    // the closure. Both hold this key; no new key (Madar's catalogue pin).
    permission: PERMISSIONS.PROCUREMENT_APPROVE,
    amountLabelAr: 'قيمة العقد',
    amountLabelEn: 'Contract value',
  },
  {
    value: 'VENDOR_PAYMENT_REQUEST',
    labelAr: 'طلب صرف دفعة لمورد',
    labelEn: 'Vendor payment request',
    permission: PERMISSIONS.PROCUREMENT_APPROVE,
    amountLabelAr: 'المبلغ المطلوب صرفه',
    amountLabelEn: 'Amount requested',
  },
  {
    value: 'PETTY_CASH_SETTLEMENT',
    labelAr: 'تسوية عُهدة',
    labelEn: 'Petty cash settlement',
    permission: PERMISSIONS.PROCUREMENT_APPROVE,
    amountLabelAr: 'مجموع المصروفات المسوّاة',
    amountLabelEn: 'Total spending settled',
  },
];

export const APPROVAL_DOCUMENT_META: Record<ApprovalDocumentType, ApprovalDocumentMeta> =
  Object.fromEntries(APPROVAL_DOCUMENTS.map((d) => [d.value, d])) as Record<
    ApprovalDocumentType,
    ApprovalDocumentMeta
  >;

/**
 * Does `amount` fall in the band [min, max)? Half-open on purpose: with bands
 * 0–100,000 and 100,000+, exactly 100,000 belongs to the upper one and there
 * is no value that belongs to both or to neither.
 */
export const inBand = (amount: number, min: number, max: number | null): boolean =>
  amount >= min && (max === null || amount < max);

/** Two active bands of the same document type must not overlap. */
export const bandsOverlap = (
  a: { min: number; max: number | null },
  b: { min: number; max: number | null },
): boolean => (a.max === null || b.min < a.max) && (b.max === null || a.min < b.max);
