/**
 * Separation of duties (ADR-02 §3-1): the pairs of keys one person should not
 * hold together in one financial cycle.
 *
 * What the system already prevents when a decision is taken, whatever a role
 * holds: a step is signed only by a holder of the step's role; whoever raised
 * a document cannot sign it; one person never gives two signatures on the same
 * chain (apps/api/src/common/approval.service.ts); and a requisition is never
 * approved by the person who raised it, even with no chain
 * (apps/api/src/modules/procurement/requisitions.service.ts). So granting an
 * approve key does not make anyone the approver of what they raised.
 *
 * What it does not prevent: (1) with no approval rule covering the amount, a
 * person holding both the create and the approve key of a document approves
 * their own; (2) acts decided by a write key with no check on who made the
 * document — approving and paying a vendor bill (`finance.payment.write`),
 * accepting a receipt (`scm.procurement.write`). Those are what this table is
 * for.
 *
 * This table refuses nothing. It warns the role and user editors when a set
 * they are about to save holds a pair, and the editors ask for an
 * acknowledgement before saving; the server saves either way and writes the
 * pairs, and whether they were acknowledged (`acknowledgeSod`), to the audit
 * row of the change. The remedy the ADR relies on is the approval matrix
 * (rules from zero), not this list.
 *
 * Imports only from `./permissions` (which stays import-free).
 */
import { PERMISSIONS, type PermissionKey } from './permissions';

export interface SodConflict {
  a: PermissionKey;
  b: PermissionKey;
  /** What holding both lets one person do, as the warning says it. */
  labelAr: string;
  labelEn: string;
}

export const SOD_CONFLICTS: ReadonlyArray<SodConflict> = [
  {
    a: PERMISSIONS.REQUISITION_WRITE,
    b: PERMISSIONS.PROCUREMENT_APPROVE,
    labelAr: 'يرفع طلب الشراء ويعتمده',
    labelEn: 'raises and approves requisitions',
  },
  {
    a: PERMISSIONS.PROCUREMENT_WRITE,
    b: PERMISSIONS.PROCUREMENT_APPROVE,
    labelAr: 'ينشئ أمر الشراء ويعتمده',
    labelEn: 'creates and approves purchase orders',
  },
  {
    // The vendor and the purchase order are procurement's (scm.procurement.write);
    // approving and paying the vendor's bill is finance.payment.write.
    a: PERMISSIONS.PROCUREMENT_WRITE,
    b: PERMISSIONS.PAYMENT_WRITE,
    labelAr: 'ينشئ المورد ويسدد له',
    labelEn: 'creates the vendor and pays it',
  },
  {
    a: PERMISSIONS.PROPOSAL_WRITE,
    b: PERMISSIONS.PROPOSAL_APPROVE,
    labelAr: 'يُعدّ عرض السعر ويعتمده',
    labelEn: 'prepares and approves proposals',
  },
  {
    a: PERMISSIONS.PROJECT_WRITE,
    b: PERMISSIONS.PROJECT_APPROVE,
    labelAr: 'يرفع أمر التغيير ويعتمده',
    labelEn: 'raises and approves change orders',
  },
  {
    a: PERMISSIONS.INVOICE_WRITE,
    b: PERMISSIONS.PERIOD_MANAGE,
    labelAr: 'يصدر الفواتير ويقفل الفترة',
    labelEn: 'issues invoices and closes the period',
  },
];

/** The pairs of SOD_CONFLICTS that `permissions` holds both keys of, in table order. */
export function sodConflicts(permissions: readonly string[]): SodConflict[] {
  const held = new Set(permissions);
  return SOD_CONFLICTS.filter((c) => held.has(c.a) && held.has(c.b));
}
