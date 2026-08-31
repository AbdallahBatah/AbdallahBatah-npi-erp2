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
  | 'CHANGE_ORDER';

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
    // engineer holds; approving one does not.
    permission: PERMISSIONS.PROCUREMENT_WRITE,
    amountLabelAr: 'القيمة التقديرية للطلب',
    amountLabelEn: 'Estimated value of the request',
  },
  {
    value: 'PURCHASE_ORDER',
    labelAr: 'أمر شراء',
    labelEn: 'Purchase order',
    permission: PERMISSIONS.PROCUREMENT_WRITE,
    amountLabelAr: 'إجمالي أمر الشراء شامل الضريبة',
    amountLabelEn: 'PO total including VAT',
  },
  {
    value: 'PROGRESS_CLAIM',
    labelAr: 'مستخلص مقاول من الباطن',
    labelEn: 'Subcontractor progress claim',
    permission: PERMISSIONS.PROCUREMENT_WRITE,
    amountLabelAr: 'المبلغ المُطالَب به',
    amountLabelEn: 'Claimed amount',
  },
  {
    value: 'CHANGE_ORDER',
    labelAr: 'أمر تغيير',
    labelEn: 'Change order',
    permission: PERMISSIONS.PROJECT_WRITE,
    amountLabelAr: 'قيمة التغيير المطلقة',
    amountLabelEn: 'Absolute value of the variation',
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
