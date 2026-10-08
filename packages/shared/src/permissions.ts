/**
 * The complete permission surface for the current build slice.
 * Format: `<module>.<entity>.<action>`. The seed grants the full set to the
 * `admin` role and a read/write subset to `sales`.
 */
export const PERMISSIONS = {
  CUSTOMER_READ: 'crm.customer.read',
  CUSTOMER_WRITE: 'crm.customer.write',
  // CRM Phase 1 (Step 2): lists suggested duplicate customers and merges them.
  // A merge moves every linked document to the surviving record and cannot be
  // undone from the app, so it is its own key — held by `admin` and `executive`
  // only — rather than a side effect of `crm.customer.write`.
  CUSTOMER_MERGE: 'crm.customer.merge',
  LEAD_READ: 'crm.lead.read',
  LEAD_WRITE: 'crm.lead.write',
  OPPORTUNITY_READ: 'crm.opportunity.read',
  OPPORTUNITY_WRITE: 'crm.opportunity.write',
  ITEM_READ: 'commercial.item.read',
  ITEM_WRITE: 'commercial.item.write',
  PROPOSAL_READ: 'commercial.proposal.read',
  PROPOSAL_WRITE: 'commercial.proposal.write',
  // CRM Phase 1: approving is its own key, separate from writing. Used by the
  // proposal approval flow (Step 4); the migration grants it to every role that
  // already holds `commercial.proposal.write`.
  PROPOSAL_APPROVE: 'commercial.proposal.approve',
  CONTRACT_READ: 'commercial.contract.read',
  CONTRACT_WRITE: 'commercial.contract.write',
  INVOICE_READ: 'finance.invoice.read',
  INVOICE_WRITE: 'finance.invoice.write',
  LEDGER_READ: 'finance.ledger.read',
  // CRM Phase 1: sees unit costs, margins and budget/actual cost figures. The
  // server nulls every COST_FIELDS key for a user without it (see
  // CostRedactionInterceptor); the UI merely hides the columns.
  COSTS_VIEW: 'finance.costs.view',
  PAYMENT_READ: 'finance.payment.read',
  PAYMENT_WRITE: 'finance.payment.write',
  PERIOD_MANAGE: 'finance.period.manage',
  PROJECT_READ: 'projects.project.read',
  PROJECT_WRITE: 'projects.project.write',
  // Decides change-order approvals (was PROJECT_WRITE before CRM Phase 1).
  PROJECT_APPROVE: 'projects.project.approve',
  PROCUREMENT_READ: 'scm.procurement.read',
  PROCUREMENT_WRITE: 'scm.procurement.write',
  // Decides requisition / purchase-order / progress-claim approvals (was
  // PROCUREMENT_WRITE before CRM Phase 1).
  PROCUREMENT_APPROVE: 'scm.procurement.approve',
  // M4: raising a purchase requisition is deliberately a *lower* bar than
  // running procurement. Anyone who can ask the company to buy something needs
  // this; only a buyer needs PROCUREMENT_WRITE. Collapsing the two would mean
  // every engineer who wants a cable can also approve purchase orders.
  REQUISITION_WRITE: 'scm.requisition.write',
  // M4: departments and delegations are delegation-of-authority settings —
  // who signs for whom, and for which unit — not preferences. Grouped with the
  // approval matrix because they configure the same control.
  DEPARTMENT_MANAGE: 'admin.department.manage',
  DELEGATION_MANAGE: 'admin.delegation.manage',
  // M4: the outbox's operational view. Reading it exposes what the system did
  // internally, and requeueing a failed event re-runs a financial consequence,
  // so it is an administrator's key, not an operator's.
  WORKFLOW_MANAGE: 'admin.workflow.manage',
  ASSET_READ: 'assets.serialunit.read',
  WORKORDER_READ: 'fsm.workorder.read',
  WORKORDER_WRITE: 'fsm.workorder.write',
  ORG_MANAGE: 'admin.org.manage',
  USER_MANAGE: 'admin.user.manage',
  // The audit trail is written on every mutation but proving "who changed
  // what, when" needs a reader — a control permission, admin-only by default.
  AUDIT_READ: 'admin.audit.read',
  // Configuring the approval matrix decides who may authorise spending and
  // above what amount — a delegation-of-authority control, not a preference.
  // Acting on a request needs the document's own write permission, not this.
  APPROVAL_MANAGE: 'admin.approval.manage',
  // Attachments are cross-module: holding these alone is not enough — the
  // service also requires the read permission of the parent entity type.
  ATTACHMENT_READ: 'platform.attachment.read',
  ATTACHMENT_WRITE: 'platform.attachment.write',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);

/**
 * What a permission lets you do, for the role editor's grid. The existing model
 * folds "create" and "edit" into a single `write` key, so the grid shows one
 * "create & edit" column — expanding the model was deliberately out of scope.
 * `special` keys (manage, costs.view, attachment.*) sit outside the grid.
 */
export type PermissionAction = 'view' | 'write' | 'approve' | 'special';

/**
 * Bilingual catalog for the role editor UI. Served by /admin/permissions so
 * the web app has exactly one source of truth for what each key means.
 * Grouped in sidebar order. Additive over the original shape: `screenAr/En`
 * names the screen (a grid row) and `action` its column.
 */
export interface PermissionMeta {
  key: PermissionKey;
  groupAr: string;
  groupEn: string;
  labelAr: string;
  labelEn: string;
  screenAr: string;
  screenEn: string;
  action: PermissionAction;
}

/** `*.read` → view, `*.write` → write, `*.approve` → approve, everything else special. */
const actionOf = (key: string): PermissionAction =>
  key.startsWith('platform.attachment.')
    ? 'special'
    : key.endsWith('.read')
      ? 'view'
      : key.endsWith('.write')
        ? 'write'
        : key.endsWith('.approve')
          ? 'approve'
          : 'special';

/** [key, labelAr, labelEn, screenAr, screenEn] */
type Row = [PermissionKey, string, string, string, string];

const g = (groupAr: string, groupEn: string, rows: Row[]): PermissionMeta[] =>
  rows.map(([key, labelAr, labelEn, screenAr, screenEn]) => ({
    key,
    groupAr,
    groupEn,
    labelAr,
    labelEn,
    screenAr,
    screenEn,
    action: actionOf(key),
  }));

export const PERMISSION_CATALOG: PermissionMeta[] = [
  ...g('المبيعات والتعاقد', 'Sales & contracting', [
    [PERMISSIONS.LEAD_READ, 'عرض العملاء المحتملين', 'View leads', 'العملاء المحتملون', 'Leads'],
    [PERMISSIONS.LEAD_WRITE, 'إدارة العملاء المحتملين', 'Manage leads', 'العملاء المحتملون', 'Leads'],
    [PERMISSIONS.CUSTOMER_READ, 'عرض العملاء', 'View customers', 'العملاء', 'Customers'],
    [PERMISSIONS.CUSTOMER_WRITE, 'إدارة العملاء', 'Manage customers', 'العملاء', 'Customers'],
    [PERMISSIONS.CUSTOMER_MERGE, 'دمج العملاء المكررين', 'Merge duplicate customers', 'العملاء', 'Customers'],
    [PERMISSIONS.OPPORTUNITY_READ, 'عرض الفرص', 'View opportunities', 'الفرص', 'Opportunities'],
    [PERMISSIONS.OPPORTUNITY_WRITE, 'إدارة الفرص', 'Manage opportunities', 'الفرص', 'Opportunities'],
    [PERMISSIONS.PROPOSAL_READ, 'عرض العروض', 'View proposals', 'عروض الأسعار', 'Proposals'],
    [PERMISSIONS.PROPOSAL_WRITE, 'إدارة العروض', 'Manage proposals', 'عروض الأسعار', 'Proposals'],
    [PERMISSIONS.PROPOSAL_APPROVE, 'اعتماد العروض', 'Approve proposals', 'عروض الأسعار', 'Proposals'],
    [PERMISSIONS.CONTRACT_READ, 'عرض العقود', 'View contracts', 'العقود', 'Contracts'],
    [PERMISSIONS.CONTRACT_WRITE, 'إدارة العقود', 'Manage contracts', 'العقود', 'Contracts'],
    [PERMISSIONS.ITEM_READ, 'عرض الأصناف', 'View items', 'الأصناف', 'Items'],
    [PERMISSIONS.ITEM_WRITE, 'إدارة الأصناف', 'Manage items', 'الأصناف', 'Items'],
  ]),
  ...g('التنفيذ والتوريد', 'Delivery & supply', [
    [PERMISSIONS.PROJECT_READ, 'عرض المشاريع', 'View projects', 'المشاريع', 'Projects'],
    [PERMISSIONS.PROJECT_WRITE, 'إدارة المشاريع', 'Manage projects', 'المشاريع', 'Projects'],
    [PERMISSIONS.PROJECT_APPROVE, 'اعتماد أوامر التغيير', 'Approve change orders', 'المشاريع', 'Projects'],
    [PERMISSIONS.PROCUREMENT_READ, 'عرض المشتريات والمخزون', 'View procurement & stock', 'المشتريات والمخزون', 'Procurement & stock'],
    [PERMISSIONS.PROCUREMENT_WRITE, 'إدارة المشتريات والمخزون', 'Manage procurement & stock', 'المشتريات والمخزون', 'Procurement & stock'],
    [PERMISSIONS.PROCUREMENT_APPROVE, 'اعتماد المشتريات', 'Approve procurement', 'المشتريات والمخزون', 'Procurement & stock'],
    [PERMISSIONS.REQUISITION_WRITE, 'رفع طلبات الشراء', 'Raise purchase requisitions', 'طلبات الشراء', 'Purchase requisitions'],
    [PERMISSIONS.ASSET_READ, 'عرض الأصول المتسلسلة', 'View serialised assets', 'الأصول المتسلسلة', 'Serialised assets'],
  ]),
  ...g('التشغيل', 'Operations', [
    [PERMISSIONS.WORKORDER_READ, 'عرض أوامر العمل والمراقبة', 'View work orders & telemetry', 'أوامر العمل والمراقبة', 'Work orders & telemetry'],
    [PERMISSIONS.WORKORDER_WRITE, 'إدارة أوامر العمل', 'Manage work orders', 'أوامر العمل والمراقبة', 'Work orders & telemetry'],
  ]),
  ...g('المالية', 'Finance', [
    [PERMISSIONS.INVOICE_READ, 'عرض الفواتير', 'View invoices', 'الفواتير', 'Invoices'],
    [PERMISSIONS.INVOICE_WRITE, 'إصدار الفواتير والتحصيل', 'Issue invoices & collect', 'الفواتير', 'Invoices'],
    [PERMISSIONS.PAYMENT_READ, 'عرض مستحقات الموردين', 'View vendor payables', 'مستحقات الموردين', 'Vendor payables'],
    [PERMISSIONS.PAYMENT_WRITE, 'سداد الموردين', 'Pay vendors', 'مستحقات الموردين', 'Vendor payables'],
    [PERMISSIONS.LEDGER_READ, 'عرض دفتر الأستاذ والتقارير', 'View ledger & reports', 'دفتر الأستاذ والتقارير', 'Ledger & reports'],
    [PERMISSIONS.PERIOD_MANAGE, 'إدارة الفترات المالية والإقفال', 'Manage fiscal periods & closing', 'الفترات المالية', 'Fiscal periods'],
    [PERMISSIONS.COSTS_VIEW, 'عرض التكاليف والهوامش', 'View costs & margins', 'التكاليف والهوامش', 'Costs & margins'],
  ]),
  ...g('المنصة', 'Platform', [
    [PERMISSIONS.ATTACHMENT_READ, 'عرض المرفقات', 'View attachments', 'المرفقات', 'Attachments'],
    [PERMISSIONS.ATTACHMENT_WRITE, 'رفع وحذف المرفقات', 'Upload & delete attachments', 'المرفقات', 'Attachments'],
  ]),
  ...g('الإدارة', 'Administration', [
    [PERMISSIONS.USER_MANAGE, 'إدارة المستخدمين والأدوار', 'Manage users & roles', 'المستخدمون والأدوار', 'Users & roles'],
    [PERMISSIONS.ORG_MANAGE, 'إعدادات المنشأة', 'Organization settings', 'إعدادات المنشأة', 'Organization settings'],
    [PERMISSIONS.AUDIT_READ, 'عرض سجل التدقيق', 'View audit log', 'سجل التدقيق', 'Audit log'],
    [PERMISSIONS.APPROVAL_MANAGE, 'ضبط مصفوفة الاعتماد', 'Configure approval matrix', 'مصفوفة الاعتماد', 'Approval matrix'],
    [PERMISSIONS.DEPARTMENT_MANAGE, 'إدارة الأقسام', 'Manage departments', 'الأقسام', 'Departments'],
    [PERMISSIONS.DELEGATION_MANAGE, 'إدارة التفويض المؤقت', 'Manage temporary delegations', 'التفويض المؤقت', 'Temporary delegations'],
    [PERMISSIONS.WORKFLOW_MANAGE, 'مراقبة سير العمل والأحداث', 'Monitor workflow & events', 'سير العمل والأحداث', 'Workflow & events'],
  ]),
];

/**
 * Every JSON key whose value is a cost, margin or budget figure. A user without
 * `finance.costs.view` gets `null` in each of these, wherever they appear in a
 * response (CostRedactionInterceptor) — the keys are kept, never deleted, so a
 * client that destructures them does not crash.
 *
 * Deliberately NOT here: `subtotal`, `amount`, `totalAmount` — those are sale
 * prices and invoice figures, public to anyone who can read the document.
 */
export const COST_FIELDS: readonly string[] = [
  // Item.unitCost (schema.prisma:442) — catalogue purchase cost. Also nested as
  // bomLines[].item.unitCost, requisition/PO item lookups, WorkOrderPart.unitCost
  // (schema.prisma:1426).
  'unitCost',
  // BomLine.originalUnitCost (CRM Step 4): the cost the system fetched before a manual
  // change; the changed cost itself is covered by 'unitCost'.
  'originalUnitCost',
  // ProposalRevision.marginAmount (schema.prisma:525) — the margin added on top
  // of the BOM subtotal; computed in proposals.service addRevision (line ~114).
  'marginAmount',
  // PricingScheme.marginPct (schema.prisma:465) — margin
  // percentage, also an input of addRevision.
  'marginPct',
  // Contract profitability report (finance/reports.service.ts profitability(),
  // lines ~462-493): estimated cost from the accepted BOM at catalogue cost.
  'estCost',
  'estMargin', // contractValue - estCost
  'estMarginPct', // estMargin / contractValue
  'earnedMargin', // estMargin x progress %
  'actualCost', // sum of the append-only ProjectCostEntry ledger
  'marginToDate', // billed - actualCost
  'costBasis', // 'ACTUAL' | 'BOM_ESTIMATE' — discloses which cost basis was used
  // WorkOrderPart.totalCost (schema.prisma:1427; fsm.service.ts:266 qty x unitCost).
  'totalCost',
  // fsm.service.ts get() (line ~118): the sum of WorkOrderPart.totalCost,
  // returned beside the parts — it would reveal what `totalCost` hides.
  'partsCost',
  // WbsElement.budgetAmount (schema.prisma:955) — the cost budget of a WBS
  // element, set from the BOM at cost in projects.service.ts (lines ~92-124).
  'budgetAmount',
  // projects.service.ts get() (lines ~203-246): per-WBS and project-wide job
  // costing. `committed` (open PO value), `actual` (cost-entry sum), `variance`
  // (budget - actual - committed) on each wbsElement and inside costSummary,
  // plus `budget` inside costSummary (sum of budgetAmount).
  'budget',
  'committed',
  'actual',
  'variance',
  // projects.service.ts get() `costEntries` (line ~171): the append-only cost
  // ledger rows. Their per-row `amount` key is generic and must stay readable
  // elsewhere (invoices, claims), so the whole list is nulled instead.
  'costEntries',
];
