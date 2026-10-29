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
  // ADR-02 (P1-6): one view key per screen. This key and the three other
  // P1-6 *_READ keys below each took one screen off a key that used to open
  // two or three (this one /tasks off crm.customer.read). Migration 0030
  // grants each to every role holding the old key, so no role sees or reaches
  // anything different at deploy. The old keys keep their remaining screen and
  // their meaning: Madar stores them as the source of what it remembers.
  TASK_READ: 'crm.task.read',
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
  // P1-6: the finance reports (POC, VAT return, profitability) and the
  // financial statements (with the fiscal-year list), split off LEDGER_READ.
  REPORT_READ: 'finance.report.read',
  STATEMENT_READ: 'finance.statement.read',
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
  // P1-6: the requisitions screen, split off PROCUREMENT_READ.
  REQUISITION_READ: 'scm.requisition.read',
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
 * `view` is the key that opens its screen (for /admin, /departments and
 * /delegations that is a `.manage` key); `special` keys sit outside the three
 * columns, under their screen's row when they have one. Set per row, not
 * derived from the key's suffix: the audit log's `.read` is a tab of /admin,
 * not a screen's view key (ADR-02 §3-6).
 */
export type PermissionAction = 'view' | 'write' | 'approve' | 'special';

/**
 * Bilingual catalog for the role editor UI. Served by /admin/permissions so
 * the web app has exactly one source of truth for what each key means.
 * Grouped in sidebar order. Additive over the original shape: `screenAr/En`
 * names the screen (a grid row), `screen` is that row's sidebar path and
 * `action` its column. Only ever add fields: Madar reads `key`, `groupAr` and
 * `labelAr` from every element of GET /admin/permissions.
 */
export interface PermissionMeta {
  key: PermissionKey;
  groupAr: string;
  groupEn: string;
  labelAr: string;
  labelEn: string;
  screenAr: string;
  screenEn: string;
  /**
   * The `href` of the screen-registry entry (screens.ts) whose editor row the
   * key belongs to: a view key's own screen, and the write / approve / special
   * keys acted on there. `null` = no single sidebar screen (the key works on
   * several, or on none), so the editors list it under special permissions.
   * A plain string because this file stays import-free; screens.spec.ts
   * checks every value against the registry.
   */
  screen: string | null;
  action: PermissionAction;
}

/** [key, labelAr, labelEn, screenAr, screenEn, screen, action] */
type Row = [PermissionKey, string, string, string, string, string | null, PermissionAction];

const g = (groupAr: string, groupEn: string, rows: Row[]): PermissionMeta[] =>
  rows.map(([key, labelAr, labelEn, screenAr, screenEn, screen, action]) => ({
    key,
    groupAr,
    groupEn,
    labelAr,
    labelEn,
    screenAr,
    screenEn,
    screen,
    action,
  }));

export const PERMISSION_CATALOG: PermissionMeta[] = [
  ...g('المبيعات والتعاقد', 'Sales & contracting', [
    [PERMISSIONS.LEAD_READ, 'عرض العملاء المحتملين', 'View leads', 'العملاء المحتملون', 'Leads', '/leads', 'view'],
    [PERMISSIONS.LEAD_WRITE, 'إدارة العملاء المحتملين', 'Manage leads', 'العملاء المحتملون', 'Leads', '/leads', 'write'],
    [PERMISSIONS.CUSTOMER_READ, 'عرض العملاء', 'View customers', 'العملاء', 'Customers', '/customers', 'view'],
    [PERMISSIONS.CUSTOMER_WRITE, 'إدارة العملاء', 'Manage customers', 'العملاء', 'Customers', '/customers', 'write'],
    [PERMISSIONS.CUSTOMER_MERGE, 'دمج العملاء المكررين', 'Merge duplicate customers', 'العملاء', 'Customers', '/customers', 'special'],
    [PERMISSIONS.TASK_READ, 'عرض مهام المتابعة', 'View follow-up tasks', 'مهام المتابعة', 'Follow-up tasks', '/tasks', 'view'],
    [PERMISSIONS.OPPORTUNITY_READ, 'عرض الفرص', 'View opportunities', 'الفرص', 'Opportunities', '/opportunities', 'view'],
    [PERMISSIONS.OPPORTUNITY_WRITE, 'إدارة الفرص', 'Manage opportunities', 'الفرص', 'Opportunities', '/opportunities', 'write'],
    [PERMISSIONS.PROPOSAL_READ, 'عرض العروض', 'View proposals', 'عروض الأسعار', 'Proposals', '/proposals', 'view'],
    [PERMISSIONS.PROPOSAL_WRITE, 'إدارة العروض', 'Manage proposals', 'عروض الأسعار', 'Proposals', '/proposals', 'write'],
    [PERMISSIONS.PROPOSAL_APPROVE, 'اعتماد العروض', 'Approve proposals', 'عروض الأسعار', 'Proposals', '/proposals', 'approve'],
    [PERMISSIONS.CONTRACT_READ, 'عرض العقود', 'View contracts', 'العقود', 'Contracts', '/contracts', 'view'],
    [PERMISSIONS.CONTRACT_WRITE, 'إدارة العقود', 'Manage contracts', 'العقود', 'Contracts', '/contracts', 'write'],
    [PERMISSIONS.ITEM_READ, 'عرض الأصناف', 'View items', 'الأصناف', 'Items', '/items', 'view'],
    [PERMISSIONS.ITEM_WRITE, 'إدارة الأصناف', 'Manage items', 'الأصناف', 'Items', '/items', 'write'],
  ]),
  ...g('التنفيذ والتوريد', 'Delivery & supply', [
    [PERMISSIONS.PROJECT_READ, 'عرض المشاريع', 'View projects', 'المشاريع', 'Projects', '/projects', 'view'],
    [PERMISSIONS.PROJECT_WRITE, 'إدارة المشاريع', 'Manage projects', 'المشاريع', 'Projects', '/projects', 'write'],
    [PERMISSIONS.PROJECT_APPROVE, 'اعتماد أوامر التغيير', 'Approve change orders', 'المشاريع', 'Projects', '/projects', 'approve'],
    [PERMISSIONS.PROCUREMENT_READ, 'عرض المشتريات والمخزون', 'View procurement & stock', 'المشتريات والمخزون', 'Procurement & stock', '/procurement', 'view'],
    [PERMISSIONS.PROCUREMENT_WRITE, 'إدارة المشتريات والمخزون', 'Manage procurement & stock', 'المشتريات والمخزون', 'Procurement & stock', '/procurement', 'write'],
    [PERMISSIONS.PROCUREMENT_APPROVE, 'اعتماد المشتريات', 'Approve procurement', 'المشتريات والمخزون', 'Procurement & stock', '/procurement', 'approve'],
    [PERMISSIONS.REQUISITION_READ, 'عرض طلبات الشراء', 'View purchase requisitions', 'طلبات الشراء', 'Purchase requisitions', '/requisitions', 'view'],
    [PERMISSIONS.REQUISITION_WRITE, 'رفع طلبات الشراء', 'Raise purchase requisitions', 'طلبات الشراء', 'Purchase requisitions', '/requisitions', 'write'],
    [PERMISSIONS.ASSET_READ, 'عرض الأصول المتسلسلة', 'View serialised assets', 'الأصول المتسلسلة', 'Serialised assets', '/assets', 'view'],
  ]),
  ...g('التشغيل', 'Operations', [
    [PERMISSIONS.WORKORDER_READ, 'عرض أوامر العمل', 'View work orders', 'أوامر العمل', 'Work orders', '/workorders', 'view'],
    [PERMISSIONS.WORKORDER_WRITE, 'إدارة أوامر العمل', 'Manage work orders', 'أوامر العمل', 'Work orders', '/workorders', 'write'],
  ]),
  ...g('المالية', 'Finance', [
    [PERMISSIONS.INVOICE_READ, 'عرض الفواتير', 'View invoices', 'الفواتير', 'Invoices', '/invoices', 'view'],
    [PERMISSIONS.INVOICE_WRITE, 'إصدار الفواتير والتحصيل', 'Issue invoices & collect', 'الفواتير', 'Invoices', '/invoices', 'write'],
    [PERMISSIONS.PAYMENT_READ, 'عرض مستحقات الموردين', 'View vendor payables', 'مستحقات الموردين', 'Vendor payables', '/payables', 'view'],
    [PERMISSIONS.PAYMENT_WRITE, 'سداد الموردين', 'Pay vendors', 'مستحقات الموردين', 'Vendor payables', '/payables', 'write'],
    [PERMISSIONS.REPORT_READ, 'عرض التقارير المالية', 'View finance reports', 'التقارير المالية', 'Finance reports', '/finance', 'view'],
    [PERMISSIONS.STATEMENT_READ, 'عرض القوائم المالية', 'View financial statements', 'القوائم المالية', 'Financial statements', '/statements', 'view'],
    // Fiscal years and period closing are a section of the statements screen.
    [PERMISSIONS.PERIOD_MANAGE, 'إدارة الفترات المالية والإقفال', 'Manage fiscal periods & closing', 'الفترات المالية', 'Fiscal periods', '/statements', 'special'],
    [PERMISSIONS.LEDGER_READ, 'عرض دفتر الأستاذ', 'View general ledger', 'دفتر الأستاذ', 'General ledger', '/ledger', 'view'],
    // Cost columns appear on items, proposals, projects, procurement,
    // requisitions, work orders and finance reports: no single screen.
    [PERMISSIONS.COSTS_VIEW, 'عرض التكاليف والهوامش', 'View costs & margins', 'التكاليف والهوامش', 'Costs & margins', null, 'special'],
  ]),
  ...g('المنصة', 'Platform', [
    // The files tab of every detail page that has one: no single screen.
    [PERMISSIONS.ATTACHMENT_READ, 'عرض المرفقات', 'View attachments', 'المرفقات', 'Attachments', null, 'special'],
    [PERMISSIONS.ATTACHMENT_WRITE, 'رفع وحذف المرفقات', 'Upload & delete attachments', 'المرفقات', 'Attachments', null, 'special'],
  ]),
  ...g('الإدارة', 'Administration', [
    [PERMISSIONS.USER_MANAGE, 'إدارة المستخدمين والأدوار', 'Manage users & roles', 'المستخدمون والأدوار', 'Users & roles', '/admin', 'view'],
    // Organization settings and the audit log are tabs of /admin.
    [PERMISSIONS.ORG_MANAGE, 'إعدادات المنشأة', 'Organization settings', 'إعدادات المنشأة', 'Organization settings', '/admin', 'special'],
    [PERMISSIONS.AUDIT_READ, 'عرض سجل التدقيق', 'View audit log', 'سجل التدقيق', 'Audit log', '/admin', 'special'],
    // The matrix is a tab of /admin, but the key also opens the history view
    // of /approvals: two screens, so none.
    [PERMISSIONS.APPROVAL_MANAGE, 'ضبط مصفوفة الاعتماد', 'Configure approval matrix', 'مصفوفة الاعتماد', 'Approval matrix', null, 'special'],
    [PERMISSIONS.DEPARTMENT_MANAGE, 'إدارة الأقسام', 'Manage departments', 'الأقسام', 'Departments', '/departments', 'view'],
    [PERMISSIONS.DELEGATION_MANAGE, 'إدارة التفويض المؤقت', 'Manage temporary delegations', 'التفويض المؤقت', 'Temporary delegations', '/delegations', 'view'],
    // The workflow monitor is a panel of the task box, its only screen.
    [PERMISSIONS.WORKFLOW_MANAGE, 'مراقبة سير العمل والأحداث', 'Monitor workflow & events', 'سير العمل والأحداث', 'Workflow & events', '/inbox', 'special'],
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
  // WorkItem.defaultUnitCost (Package 3 · P3-3): a work item's cost per unit.
  'defaultUnitCost',
  // ProposalRevision risk contingency (Package 3 · P3-4): a share of the
  // estimated cost, and the notes behind it — both reveal the cost build-up.
  'contingencyPct',
  'contingencyAmount',
  'riskNotes',
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
