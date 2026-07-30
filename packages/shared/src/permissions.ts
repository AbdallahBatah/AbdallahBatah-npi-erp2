/**
 * The complete permission surface for the current build slice.
 * Format: `<module>.<entity>.<action>`. The seed grants the full set to the
 * `admin` role and a read/write subset to `sales`.
 */
export const PERMISSIONS = {
  CUSTOMER_READ: 'crm.customer.read',
  CUSTOMER_WRITE: 'crm.customer.write',
  LEAD_READ: 'crm.lead.read',
  LEAD_WRITE: 'crm.lead.write',
  OPPORTUNITY_READ: 'crm.opportunity.read',
  OPPORTUNITY_WRITE: 'crm.opportunity.write',
  ITEM_READ: 'commercial.item.read',
  ITEM_WRITE: 'commercial.item.write',
  PROPOSAL_READ: 'commercial.proposal.read',
  PROPOSAL_WRITE: 'commercial.proposal.write',
  CONTRACT_READ: 'commercial.contract.read',
  CONTRACT_WRITE: 'commercial.contract.write',
  INVOICE_READ: 'finance.invoice.read',
  INVOICE_WRITE: 'finance.invoice.write',
  LEDGER_READ: 'finance.ledger.read',
  PAYMENT_READ: 'finance.payment.read',
  PAYMENT_WRITE: 'finance.payment.write',
  PERIOD_MANAGE: 'finance.period.manage',
  PROJECT_READ: 'projects.project.read',
  PROJECT_WRITE: 'projects.project.write',
  PROCUREMENT_READ: 'scm.procurement.read',
  PROCUREMENT_WRITE: 'scm.procurement.write',
  ASSET_READ: 'assets.serialunit.read',
  WORKORDER_READ: 'fsm.workorder.read',
  WORKORDER_WRITE: 'fsm.workorder.write',
  ORG_MANAGE: 'admin.org.manage',
  USER_MANAGE: 'admin.user.manage',
  // Attachments are cross-module: holding these alone is not enough — the
  // service also requires the read permission of the parent entity type.
  ATTACHMENT_READ: 'platform.attachment.read',
  ATTACHMENT_WRITE: 'platform.attachment.write',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);

/**
 * Bilingual catalog for the role editor UI. Served by /admin/permissions so
 * the web app has exactly one source of truth for what each key means.
 * Grouped in sidebar order.
 */
export interface PermissionMeta {
  key: PermissionKey;
  groupAr: string;
  groupEn: string;
  labelAr: string;
  labelEn: string;
}

const g = (
  groupAr: string,
  groupEn: string,
  rows: Array<[PermissionKey, string, string]>,
): PermissionMeta[] => rows.map(([key, labelAr, labelEn]) => ({ key, groupAr, groupEn, labelAr, labelEn }));

export const PERMISSION_CATALOG: PermissionMeta[] = [
  ...g('المبيعات والتعاقد', 'Sales & contracting', [
    [PERMISSIONS.LEAD_READ, 'عرض العملاء المحتملين', 'View leads'],
    [PERMISSIONS.LEAD_WRITE, 'إدارة العملاء المحتملين', 'Manage leads'],
    [PERMISSIONS.CUSTOMER_READ, 'عرض العملاء', 'View customers'],
    [PERMISSIONS.CUSTOMER_WRITE, 'إدارة العملاء', 'Manage customers'],
    [PERMISSIONS.OPPORTUNITY_READ, 'عرض الفرص', 'View opportunities'],
    [PERMISSIONS.OPPORTUNITY_WRITE, 'إدارة الفرص', 'Manage opportunities'],
    [PERMISSIONS.PROPOSAL_READ, 'عرض العروض', 'View proposals'],
    [PERMISSIONS.PROPOSAL_WRITE, 'إدارة العروض', 'Manage proposals'],
    [PERMISSIONS.CONTRACT_READ, 'عرض العقود', 'View contracts'],
    [PERMISSIONS.CONTRACT_WRITE, 'إدارة العقود', 'Manage contracts'],
    [PERMISSIONS.ITEM_READ, 'عرض الأصناف', 'View items'],
    [PERMISSIONS.ITEM_WRITE, 'إدارة الأصناف', 'Manage items'],
  ]),
  ...g('التنفيذ والتوريد', 'Delivery & supply', [
    [PERMISSIONS.PROJECT_READ, 'عرض المشاريع', 'View projects'],
    [PERMISSIONS.PROJECT_WRITE, 'إدارة المشاريع', 'Manage projects'],
    [PERMISSIONS.PROCUREMENT_READ, 'عرض المشتريات والمخزون', 'View procurement & stock'],
    [PERMISSIONS.PROCUREMENT_WRITE, 'إدارة المشتريات والمخزون', 'Manage procurement & stock'],
    [PERMISSIONS.ASSET_READ, 'عرض الأصول المتسلسلة', 'View serialised assets'],
  ]),
  ...g('التشغيل', 'Operations', [
    [PERMISSIONS.WORKORDER_READ, 'عرض أوامر العمل والمراقبة', 'View work orders & telemetry'],
    [PERMISSIONS.WORKORDER_WRITE, 'إدارة أوامر العمل', 'Manage work orders'],
  ]),
  ...g('المالية', 'Finance', [
    [PERMISSIONS.INVOICE_READ, 'عرض الفواتير', 'View invoices'],
    [PERMISSIONS.INVOICE_WRITE, 'إصدار الفواتير والتحصيل', 'Issue invoices & collect'],
    [PERMISSIONS.PAYMENT_READ, 'عرض مستحقات الموردين', 'View vendor payables'],
    [PERMISSIONS.PAYMENT_WRITE, 'سداد الموردين', 'Pay vendors'],
    [PERMISSIONS.LEDGER_READ, 'عرض دفتر الأستاذ والتقارير', 'View ledger & reports'],
    [PERMISSIONS.PERIOD_MANAGE, 'إدارة الفترات المالية والإقفال', 'Manage fiscal periods & closing'],
  ]),
  ...g('المنصة', 'Platform', [
    [PERMISSIONS.ATTACHMENT_READ, 'عرض المرفقات', 'View attachments'],
    [PERMISSIONS.ATTACHMENT_WRITE, 'رفع وحذف المرفقات', 'Upload & delete attachments'],
  ]),
  ...g('الإدارة', 'Administration', [
    [PERMISSIONS.USER_MANAGE, 'إدارة المستخدمين والأدوار', 'Manage users & roles'],
    [PERMISSIONS.ORG_MANAGE, 'إعدادات المنشأة', 'Organization settings'],
  ]),
];
