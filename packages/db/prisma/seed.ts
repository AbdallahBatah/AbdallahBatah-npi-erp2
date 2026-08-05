/**
 * Seed the NPI Solar ERP with a working tenant so the W1 slice is usable
 * immediately after `npm run db:seed`:
 *   • one organization (NPI), two roles (admin, sales)
 *   • an admin login and a sales login
 *   • numbering sequences, a catalogue of solar items, a pricing scheme
 *   • one demo customer + one demo lead to click through the pipeline
 *
 * Idempotent: re-running upserts the same records rather than duplicating them.
 */
import { PrismaClient, CustomerType, ItemCategory, LeadSource, LeadStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Full permission surface for the current slice. Kept in sync with
// packages/shared/src/permissions.ts (the API imports it from there).
const ALL_PERMISSIONS = [
  'crm.customer.read', 'crm.customer.write',
  'crm.lead.read', 'crm.lead.write',
  'crm.opportunity.read', 'crm.opportunity.write',
  'commercial.item.read', 'commercial.item.write',
  'commercial.proposal.read', 'commercial.proposal.write',
  'commercial.contract.read', 'commercial.contract.write',
  'finance.invoice.read', 'finance.invoice.write', 'finance.ledger.read',
  'finance.payment.read', 'finance.payment.write', 'finance.period.manage',
  'projects.project.read', 'projects.project.write',
  'scm.procurement.read', 'scm.procurement.write',
  'assets.serialunit.read',
  'fsm.workorder.read', 'fsm.workorder.write',
  'admin.org.manage', 'admin.user.manage', 'admin.audit.read', 'admin.approval.manage',
  'platform.attachment.read', 'platform.attachment.write',
];

const SALES_PERMISSIONS = [
  'crm.customer.read', 'crm.customer.write',
  'crm.lead.read', 'crm.lead.write',
  'crm.opportunity.read', 'crm.opportunity.write',
  'commercial.item.read',
  'commercial.proposal.read', 'commercial.proposal.write',
  'commercial.contract.read', 'commercial.contract.write',
  'finance.invoice.read', 'finance.invoice.write', 'finance.ledger.read',
  'platform.attachment.read', 'platform.attachment.write',
];

// المحاسب: كل المال + قراءة سياقه (عقود/عملاء/مشتريات لفواتير الموردين)
const ACCOUNTANT_PERMISSIONS = [
  'finance.invoice.read', 'finance.invoice.write', 'finance.ledger.read',
  'finance.payment.read', 'finance.payment.write', 'finance.period.manage',
  'crm.customer.read',
  'commercial.contract.read', 'commercial.proposal.read', 'commercial.item.read',
  'scm.procurement.read', 'scm.procurement.write',
  'platform.attachment.read', 'platform.attachment.write',
];

// مدير المشاريع: التنفيذ والتوريد كاملاً + قراءة العقود والتشغيل والفوترة
const PM_PERMISSIONS = [
  'projects.project.read', 'projects.project.write',
  'scm.procurement.read', 'scm.procurement.write',
  'assets.serialunit.read',
  'commercial.contract.read', 'commercial.item.read',
  'crm.customer.read',
  'fsm.workorder.read',
  'finance.invoice.read',
  'platform.attachment.read', 'platform.attachment.write',
];

// مهندس الموقع: أوامر العمل والأصول والمخزون — بلا مال ولا عقود
const SITE_ENGINEER_PERMISSIONS = [
  'fsm.workorder.read', 'fsm.workorder.write',
  'assets.serialunit.read',
  'scm.procurement.read',
  'commercial.item.read',
  'projects.project.read',
  'platform.attachment.read', 'platform.attachment.write',
];

async function main() {
  const fiscalYear = new Date().getUTCFullYear();

  const org = await prisma.organization.upsert({
    where: { id: 'org_npi_root' },
    update: {},
    create: {
      id: 'org_npi_root',
      legalNameAr: 'شركة NPI للطاقة الشمسية',
      legalNameEn: 'NPI Solar Energy Co.',
      vatNumber: '300000000000003',
      crNumber: '1010000000',
      baseCurrency: 'SAR',
      isTenantRoot: true,
    },
  });

  const adminRole = await prisma.role.upsert({
    where: { organizationId_key: { organizationId: org.id, key: 'admin' } },
    update: { permissions: ALL_PERMISSIONS },
    create: {
      organizationId: org.id,
      key: 'admin',
      nameAr: 'مدير النظام',
      nameEn: 'Administrator',
      permissions: ALL_PERMISSIONS,
    },
  });

  const salesRole = await prisma.role.upsert({
    where: { organizationId_key: { organizationId: org.id, key: 'sales' } },
    update: { permissions: SALES_PERMISSIONS },
    create: {
      organizationId: org.id,
      key: 'sales',
      nameAr: 'مندوب مبيعات',
      nameEn: 'Sales Representative',
      permissions: SALES_PERMISSIONS,
    },
  });

  const roleDefs = [
    { key: 'accountant', nameAr: 'محاسب', nameEn: 'Accountant', permissions: ACCOUNTANT_PERMISSIONS },
    { key: 'pm', nameAr: 'مدير مشاريع', nameEn: 'Project Manager', permissions: PM_PERMISSIONS },
    { key: 'site_engineer', nameAr: 'مهندس موقع', nameEn: 'Site Engineer', permissions: SITE_ENGINEER_PERMISSIONS },
  ];
  const extraRoles: Record<string, string> = {};
  for (const rd of roleDefs) {
    const r = await prisma.role.upsert({
      where: { organizationId_key: { organizationId: org.id, key: rd.key } },
      update: { permissions: rd.permissions },
      create: { organizationId: org.id, key: rd.key, nameAr: rd.nameAr, nameEn: rd.nameEn, permissions: rd.permissions },
    });
    extraRoles[rd.key] = r.id;
  }
  const userDefs = [
    { email: 'accountant@npi.sa', pass: 'Acc@12345', nameAr: 'أمين الحسابات', nameEn: 'Chief Accountant', role: 'accountant' },
    { email: 'pm@npi.sa', pass: 'Pm@123456', nameAr: 'مدير المشاريع', nameEn: 'Projects Manager', role: 'pm' },
    { email: 'engineer@npi.sa', pass: 'Eng@12345', nameAr: 'مهندس الموقع', nameEn: 'Site Engineer', role: 'site_engineer' },
  ];
  for (const ud of userDefs) {
    await prisma.user.upsert({
      where: { email: ud.email },
      update: { roleId: extraRoles[ud.role] },
      create: {
        organizationId: org.id,
        email: ud.email,
        passwordHash: await bcrypt.hash(ud.pass, 10),
        nameAr: ud.nameAr,
        nameEn: ud.nameEn,
        locale: 'AR',
        roleId: extraRoles[ud.role],
      },
    });
  }

  const adminHash = await bcrypt.hash('Admin@123', 10);
  const salesHash = await bcrypt.hash('Sales@123', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@npi.sa' },
    update: {},
    create: {
      organizationId: org.id,
      email: 'admin@npi.sa',
      passwordHash: adminHash,
      nameAr: 'مدير النظام',
      nameEn: 'System Administrator',
      locale: 'AR',
      roleId: adminRole.id,
    },
  });

  await prisma.user.upsert({
    where: { email: 'sales@npi.sa' },
    update: {},
    create: {
      organizationId: org.id,
      email: 'sales@npi.sa',
      passwordHash: salesHash,
      nameAr: 'مندوب المبيعات',
      nameEn: 'Sales Rep',
      locale: 'AR',
      roleId: salesRole.id,
    },
  });

  // Numbering sequences for every document type in the slice.
  // startValue > 1 for document types the seed pre-creates one record of, so
  // the first app-generated code does not collide with the seeded one. The
  // start value applies only on first creation — reseeding never rewinds a
  // sequence that the app has already advanced (update: {}).
  const seqDefs: Array<{ documentType: string; prefix: string; startValue?: number }> = [
    { documentType: 'CUSTOMER', prefix: 'CUS', startValue: 2 },
    { documentType: 'LEAD', prefix: 'LEAD', startValue: 2 },
    { documentType: 'OPPORTUNITY', prefix: 'OPP' },
    { documentType: 'PROPOSAL', prefix: 'PRP' },
    { documentType: 'CONTRACT', prefix: 'CTR' },
    { documentType: 'INVOICE', prefix: 'INV' },
    { documentType: 'VENDOR', prefix: 'VEN', startValue: 2 },
    { documentType: 'PROJECT', prefix: 'PRJ' },
    { documentType: 'PURCHASE_ORDER', prefix: 'PO' },
    { documentType: 'GOODS_RECEIPT', prefix: 'GRN' },
    { documentType: 'VENDOR_BILL', prefix: 'BILL' },
    { documentType: 'CHANGE_ORDER', prefix: 'CO' },
    { documentType: 'SUBCONTRACT', prefix: 'SUB' },
    { documentType: 'CLAIM', prefix: 'CLM' },
    { documentType: 'ASSET', prefix: 'AST' },
    { documentType: 'WORK_ORDER', prefix: 'WO' },
    { documentType: 'MAINTENANCE_PLAN', prefix: 'MP' },
    { documentType: 'ALERT', prefix: 'ALR' },
    { documentType: 'PPA_TERM', prefix: 'PPA' },
    { documentType: 'SETTLEMENT', prefix: 'STL' },
    { documentType: 'RMA', prefix: 'RMA' },
    { documentType: 'PAYMENT', prefix: 'RCPT' },
    { documentType: 'VENDOR_PAYMENT', prefix: 'VPAY' },
    { documentType: 'CREDIT_NOTE', prefix: 'CN' },
  ];
  for (const s of seqDefs) {
    await prisma.numberingSequence.upsert({
      where: {
        organizationId_documentType_fiscalYear: {
          organizationId: org.id,
          documentType: s.documentType,
          fiscalYear,
        },
      },
      update: {},
      create: {
        organizationId: org.id,
        documentType: s.documentType,
        prefix: s.prefix,
        fiscalYear,
        nextValue: s.startValue ?? 1,
      },
    });
  }

  // A minimal solar catalogue.
  const items: Array<{ sku: string; nameAr: string; nameEn: string; itemCategory: ItemCategory; uom: string; isSerialised: boolean; unitCost: number }> = [
    { sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', nameEn: 'PV Module 550W', itemCategory: 'MODULE', uom: 'unit', isSerialised: true, unitCost: 320 },
    { sku: 'INV-50K', nameAr: 'عاكس 50 كيلوواط', nameEn: 'Inverter 50kW', itemCategory: 'INVERTER', uom: 'unit', isSerialised: true, unitCost: 6500 },
    { sku: 'MNT-RAIL', nameAr: 'قضيب تثبيت', nameEn: 'Mounting Rail', itemCategory: 'MOUNTING', uom: 'm', isSerialised: false, unitCost: 18 },
    { sku: 'CAB-DC6', nameAr: 'كابل DC 6مم', nameEn: 'DC Cable 6mm', itemCategory: 'CABLE', uom: 'm', isSerialised: false, unitCost: 4 },
    { sku: 'BOS-KIT', nameAr: 'طقم مكونات مساعدة', nameEn: 'Balance-of-System Kit', itemCategory: 'BOS', uom: 'set', isSerialised: false, unitCost: 900 },
  ];
  for (const it of items) {
    await prisma.item.upsert({
      where: { organizationId_sku: { organizationId: org.id, sku: it.sku } },
      update: {},
      create: { organizationId: org.id, ...it },
    });
  }

  // Chart of accounts (minimal, enough for milestone-billing journals).
  const accounts: Array<{ code: string; nameAr: string; nameEn: string; accountType: any }> = [
    { code: '1100', nameAr: 'ذمم مدينة تجارية', nameEn: 'Accounts Receivable', accountType: 'ASSET' },
    { code: '1200', nameAr: 'محتجزات مدينة', nameEn: 'Retention Receivable', accountType: 'ASSET' },
    // IFRS-15 percentage-of-completion (FIN-05): contract asset / contract liability.
    { code: '1150', nameAr: 'أصل عقد — أعمال منفذة غير مفوترة', nameEn: 'Contract Asset (Unbilled WIP)', accountType: 'ASSET' },
    { code: '2100', nameAr: 'ضريبة القيمة المضافة المستحقة', nameEn: 'VAT Output Payable', accountType: 'LIABILITY' },
    { code: '2400', nameAr: 'التزام عقد — إيرادات مؤجلة', nameEn: 'Contract Liability (Deferred Revenue)', accountType: 'LIABILITY' },
    { code: '4000', nameAr: 'إيرادات المشاريع', nameEn: 'Project Revenue', accountType: 'REVENUE' },
    // W2 procurement: WIP, deductible input VAT, accounts payable.
    { code: '1300', nameAr: 'مشاريع تحت التنفيذ (تكاليف)', nameEn: 'Project WIP (Costs)', accountType: 'ASSET' },
    { code: '1400', nameAr: 'ضريبة مدخلات قابلة للخصم', nameEn: 'VAT Input Receivable', accountType: 'ASSET' },
    { code: '2000', nameAr: 'ذمم دائنة — موردون', nameEn: 'Accounts Payable', accountType: 'LIABILITY' },
    // W2 remainder: retention we withhold FROM subcontractors (a liability).
    { code: '2050', nameAr: 'محتجزات دائنة — مقاولو باطن', nameEn: 'Retention Payable (Subcontractors)', accountType: 'LIABILITY' },
    // W7 payments.
    { code: '1000', nameAr: 'البنك — الحساب الجاري', nameEn: 'Bank — Current Account', accountType: 'ASSET' },
    // M1: the two sides the statements could not be drawn without — cost of
    // revenue (WIP relieved on recognition) and equity.
    { code: '5000', nameAr: 'تكلفة الإيرادات', nameEn: 'Cost of Revenue', accountType: 'EXPENSE' },
    { code: '3000', nameAr: 'رأس المال', nameEn: "Owners' Capital", accountType: 'EQUITY' },
    { code: '3100', nameAr: 'أرباح مبقاة', nameEn: 'Retained Earnings', accountType: 'EQUITY' },
  ];
  const accountsByCode = new Map<string, string>();
  for (const a of accounts) {
    const saved = await prisma.account.upsert({
      where: { organizationId_code: { organizationId: org.id, code: a.code } },
      update: {},
      create: { organizationId: org.id, ...a },
    });
    accountsByCode.set(a.code, saved.id);
  }

  // Posting rules: purpose → account. Automatic journals resolve accounts
  // through this table, never through a hardcoded code, so an organization can
  // repoint any purpose at its own chart of accounts without touching code.
  const postingRules: Array<[string, string]> = [
    ['AR', '1100'],
    ['RETENTION_RECEIVABLE', '1200'],
    ['CONTRACT_ASSET', '1150'],
    ['CONTRACT_LIABILITY', '2400'],
    ['VAT_OUTPUT', '2100'],
    ['REVENUE', '4000'],
    ['WIP', '1300'],
    ['COST_OF_REVENUE', '5000'],
    ['VAT_INPUT', '1400'],
    ['AP', '2000'],
    ['RETENTION_PAYABLE', '2050'],
    ['BANK', '1000'],
    ['CAPITAL', '3000'],
    ['RETAINED_EARNINGS', '3100'],
  ];
  for (const [purpose, code] of postingRules) {
    const accountId = accountsByCode.get(code)!;
    await prisma.accountMapping.upsert({
      where: { organizationId_purpose: { organizationId: org.id, purpose: purpose as any } },
      update: { accountId },
      create: { organizationId: org.id, purpose: purpose as any, accountId },
    });
  }

  // Tax codes. Saudi standard VAT is 15%.
  const taxCodes: Array<{ code: string; nameAr: string; nameEn: string; taxType: any; rate: number }> = [
    { code: 'S15', nameAr: 'ضريبة القيمة المضافة 15%', nameEn: 'VAT Standard 15%', taxType: 'VAT_STANDARD', rate: 15 },
    { code: 'Z0', nameAr: 'معدّل صفري', nameEn: 'VAT Zero-rated', taxType: 'VAT_ZERO', rate: 0 },
    { code: 'E0', nameAr: 'معفى', nameEn: 'VAT Exempt', taxType: 'VAT_EXEMPT', rate: 0 },
  ];
  for (const tc of taxCodes) {
    await prisma.taxCode.upsert({
      where: { organizationId_code: { organizationId: org.id, code: tc.code } },
      update: {},
      create: { organizationId: org.id, ...tc },
    });
  }

  await prisma.pricingScheme.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'STD' } },
    update: {},
    create: {
      organizationId: org.id,
      code: 'STD',
      nameAr: 'التسعير القياسي',
      nameEn: 'Standard Pricing',
      marginPct: 18,
      currency: 'SAR',
    },
  });

  const customer = await prisma.customer.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'CUS-00001' } },
    update: {},
    create: {
      organizationId: org.id,
      code: 'CUS-00001',
      nameAr: 'مصنع الرياض للصناعات',
      nameEn: 'Riyadh Industries Factory',
      customerType: 'CI' as CustomerType,
      vatNumber: '310000000000003',
      creditTermsDays: 30,
      phone: '+966500000000',
      email: 'procurement@riyadh-industries.sa',
    },
  });

  // SCM-04: default stock locations (site locations are created per project).
  const locations: Array<{ code: string; nameAr: string; nameEn: string; locationType: any }> = [
    { code: 'WH-MAIN', nameAr: 'المستودع المركزي', nameEn: 'Central Warehouse', locationType: 'WAREHOUSE' },
    { code: 'YARD-1', nameAr: 'ساحة التجميع', nameEn: 'Laydown Yard 1', locationType: 'LAYDOWN_YARD' },
  ];
  for (const loc of locations) {
    await prisma.location.upsert({
      where: { organizationId_code: { organizationId: org.id, code: loc.code } },
      update: {},
      create: { organizationId: org.id, ...loc },
    });
  }

  // A demo supplier so the W2 procurement flow is clickable immediately.
  await prisma.vendor.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'VEN-00001' } },
    update: {},
    create: {
      organizationId: org.id,
      code: 'VEN-00001',
      nameAr: 'شركة الخليج للألواح الشمسية',
      nameEn: 'Gulf Solar Panels Co.',
      vendorType: 'SUPPLIER',
      vatNumber: '311111111111113',
      isManufacturer: true,
      phone: '+966501111111',
      email: 'sales@gulfsolar.sa',
    },
  });

  await prisma.lead.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'LEAD-00001' } },
    update: {},
    create: {
      organizationId: org.id,
      code: 'LEAD-00001',
      contactName: 'أحمد العتيبي',
      companyName: 'مصنع الرياض للصناعات',
      source: 'REFERRAL' as LeadSource,
      status: 'NEW' as LeadStatus,
      estimatedKwp: 500,
      phone: '+966500000000',
      email: 'ahmed@riyadh-industries.sa',
      ownerId: admin.id,
      customerId: customer.id,
    },
  });

  // ── Package و: a starting approval matrix ─────────────────────────────────
  // Seeded so a fresh tenant has a working delegation of authority rather than
  // the pre-matrix state where one permission approved any amount. Deliberately
  // one band per document type with an open ceiling: everything below the
  // threshold keeps the old single-permission behaviour, which is what a small
  // customer wants on day one. Only created when absent — an organization that
  // has tuned its own bands must never have them overwritten by a re-seed.
  const matrixDefaults: Array<{
    documentType: 'PURCHASE_ORDER' | 'PROGRESS_CLAIM' | 'CHANGE_ORDER';
    minAmount: number;
    chain: string[];
  }> = [
    { documentType: 'PURCHASE_ORDER', minAmount: 100_000, chain: ['pm', 'accountant'] },
    { documentType: 'PROGRESS_CLAIM', minAmount: 250_000, chain: ['pm', 'accountant'] },
    { documentType: 'CHANGE_ORDER', minAmount: 100_000, chain: ['pm', 'admin'] },
  ];
  const roleIdByKey: Record<string, string> = {
    admin: adminRole.id,
    sales: salesRole.id,
    ...extraRoles,
  };

  for (const d of matrixDefaults) {
    const exists = await prisma.approvalRule.findFirst({
      where: { organizationId: org.id, documentType: d.documentType },
    });
    if (exists) continue;
    await prisma.approvalRule.create({
      data: {
        organizationId: org.id,
        documentType: d.documentType,
        minAmount: d.minAmount,
        maxAmount: null,
        steps: {
          create: d.chain.map((key, i) => ({ sequence: i + 1, roleId: roleIdByKey[key] })),
        },
      },
    });
  }

  console.log('✅ Seed complete.');
  console.log('   Organization : NPI Solar Energy Co. (org_npi_root)');
  console.log('   Admin login  : admin@npi.sa / Admin@123');
  console.log('   Sales login  : sales@npi.sa / Sales@123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
