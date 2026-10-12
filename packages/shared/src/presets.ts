/**
 * The company's seven roles as presets, and the five approval rules the matrix
 * needs once they are in place (ADR-02 §3-4, the owner's answers in §8).
 *
 * No migration writes them (hard rule 7: a migration never renames a role,
 * changes its keys, moves a user or edits an approval rule). Since P1-13
 * (owner decision 2026-10-12) the seed does: packages/db/prisma/seed.ts takes
 * both lists as they are, so a fresh database — and the demo server after its
 * nightly reset — starts with the seven roles and the five rules, and the
 * presets page reads every one «same». On a database that predates them, or
 * after an administrator has edited a role or a rule, the owner opens the
 * presets page, reads the preview of each one (GET /admin/role-presets:
 * create, same or differs, the keys added and removed, the users affected,
 * what would refuse it today) and applies them one at a time by his own
 * click, through the role and matrix services and their guards and audit
 * rows. Users are never moved: he gives each user one role from his form.
 *
 * The order the guards impose (hard rule 8): create the new roles and rename,
 * then apply the five rules, then narrow `pm`, `accountant`, `executive` and
 * `site_engineer`, then assign the users.
 *
 * Every later migration that adds a permission key must revisit both lists
 * (ADR-02 §7): grant the key to the presets that should hold it, and add it
 * to SOD_CONFLICTS when it pairs with another. A key missing here is a key
 * the company's roles silently never get.
 *
 * No preset for `admin` (the owner, every key) or `sales` (kept unassigned).
 * Imports only from `./permissions` and types from `./approvals`.
 */
import { PERMISSIONS as P, type PermissionKey } from './permissions';
import type { ApprovalDocumentType } from './approvals';

export type RolePresetKey =
  | 'executive'
  | 'pm'
  | 'technical_office'
  | 'site_engineer'
  | 'finance_manager'
  | 'accountant'
  | 'warehouse_keeper';

export interface RolePreset {
  /** The role's key in the organization: an existing seeded role, or one the apply creates. */
  key: RolePresetKey;
  nameAr: string;
  nameEn: string;
  permissions: readonly PermissionKey[];
}

/**
 * The seven presets, in the ADR's column order. Sidebar screens each one sees
 * (`visibleScreens`, of 24): 17, 12, 9, 6, 12, 6, 6 — pinned by
 * apps/api/src/modules/admin/role-presets.spec.ts.
 */
export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    key: 'executive',
    nameAr: 'المدير العام',
    nameEn: 'General manager',
    permissions: [
      P.LEAD_READ,
      P.CUSTOMER_READ,
      P.OPPORTUNITY_READ,
      P.TASK_READ,
      P.PROPOSAL_READ,
      P.PROPOSAL_APPROVE,
      P.CONTRACT_READ,
      P.PROJECT_READ,
      P.PROJECT_APPROVE,
      // Added to the owner's table: he approves every purchase order, so he
      // reviews it on the procurement screen first.
      P.PROCUREMENT_READ,
      P.PROCUREMENT_APPROVE,
      P.INVOICE_READ,
      P.PAYMENT_READ,
      P.REPORT_READ,
      P.STATEMENT_READ,
      P.LEDGER_READ,
      P.COSTS_VIEW,
      P.ATTACHMENT_READ,
    ],
  },
  {
    key: 'pm',
    nameAr: 'مدير عام المشاريع',
    nameEn: 'Projects general manager',
    permissions: [
      P.LEAD_READ,
      P.LEAD_WRITE,
      P.CUSTOMER_READ,
      P.CUSTOMER_WRITE,
      P.OPPORTUNITY_READ,
      P.OPPORTUNITY_WRITE,
      P.TASK_READ,
      P.PROPOSAL_READ,
      P.PROPOSAL_WRITE,
      P.CONTRACT_READ,
      P.CONTRACT_WRITE,
      P.PROJECT_READ,
      P.PROJECT_WRITE,
      P.REQUISITION_READ,
      // Signs every purchase requisition and the first step of a progress claim.
      P.PROCUREMENT_APPROVE,
      P.COSTS_VIEW,
      P.ATTACHMENT_READ,
      P.ATTACHMENT_WRITE,
    ],
  },
  {
    key: 'technical_office',
    nameAr: 'المكتب الفني',
    nameEn: 'Technical office',
    permissions: [
      P.OPPORTUNITY_READ,
      P.PROPOSAL_READ,
      P.PROPOSAL_WRITE,
      P.PROJECT_READ,
      P.PROCUREMENT_READ,
      // Receiving and transfers need it until package 4 splits them off; it
      // also lets the holder create a vendor and a draft PO (owner's answer 3).
      P.PROCUREMENT_WRITE,
      P.ITEM_READ,
      P.ITEM_WRITE,
      P.COSTS_VIEW,
      P.ATTACHMENT_READ,
      P.ATTACHMENT_WRITE,
    ],
  },
  {
    key: 'site_engineer',
    nameAr: 'مهندس المشاريع',
    nameEn: 'Projects engineer',
    permissions: [
      P.PROJECT_READ,
      P.PROJECT_WRITE,
      P.REQUISITION_READ,
      P.REQUISITION_WRITE,
      P.ATTACHMENT_READ,
      P.ATTACHMENT_WRITE,
    ],
  },
  {
    key: 'finance_manager',
    nameAr: 'الإدارة المالية',
    nameEn: 'Finance management',
    permissions: [
      P.CONTRACT_READ,
      // Added to the owner's table: turns an approved requisition into a PO.
      P.REQUISITION_READ,
      P.PROCUREMENT_READ,
      P.PROCUREMENT_WRITE,
      P.INVOICE_READ,
      P.INVOICE_WRITE,
      // Views vendor payables only: the accountant pays (owner's answer 2).
      P.PAYMENT_READ,
      P.REPORT_READ,
      P.STATEMENT_READ,
      P.LEDGER_READ,
      P.COSTS_VIEW,
      P.PERIOD_MANAGE,
      P.ATTACHMENT_READ,
      P.ATTACHMENT_WRITE,
    ],
  },
  {
    key: 'accountant',
    nameAr: 'المحاسب',
    nameEn: 'Accountant',
    // Narrows the seeded accountant (21 keys after the P1-6 backfill) to three:
    // the preview says so in words (A6).
    permissions: [P.PROCUREMENT_READ, P.PAYMENT_READ, P.PAYMENT_WRITE],
  },
  {
    key: 'warehouse_keeper',
    nameAr: 'أمين المستودع',
    nameEn: 'Warehouse keeper',
    // procurement.write for receiving and transfers, as for technical_office.
    permissions: [P.PROCUREMENT_READ, P.PROCUREMENT_WRITE, P.ITEM_READ],
  },
];

export interface ProposedApprovalRule {
  documentType: ApprovalDocumentType;
  /** Every rule starts from zero: no role of the seven both creates and approves a document. */
  minAmount: 0;
  /** The chain, as role keys, in signing order. */
  steps: readonly RolePresetKey[];
}

/**
 * The five rules, in the order the page applies them. All from zero with no
 * ceiling (owner's answers 1 and 4). PROPOSAL is what the seed already has.
 */
export const PROPOSED_APPROVAL_RULES: readonly ProposedApprovalRule[] = [
  { documentType: 'PURCHASE_REQUISITION', minAmount: 0, steps: ['pm'] },
  { documentType: 'PURCHASE_ORDER', minAmount: 0, steps: ['executive'] },
  { documentType: 'PROGRESS_CLAIM', minAmount: 0, steps: ['pm', 'executive'] },
  { documentType: 'CHANGE_ORDER', minAmount: 0, steps: ['executive'] },
  { documentType: 'PROPOSAL', minAmount: 0, steps: ['executive'] },
];

/** The preset of `key`, or undefined for a key that has none (`admin`, `sales`, anything else). */
export function rolePreset(key: string): RolePreset | undefined {
  return ROLE_PRESETS.find((p) => p.key === key);
}
