/**
 * Seed the NPI Solar ERP with a working tenant so the W1 slice is usable
 * immediately after `npm run db:seed`:
 *   • one organization (NPI) and nine roles: admin (every key), sales, and
 *     the company's seven roles from ROLE_PRESETS (P1-13)
 *   • one login per role, and the five approval rules of
 *     PROPOSED_APPROVAL_RULES
 *   • numbering sequences, a catalogue of solar items, a pricing scheme
 *   • one demo customer + one demo lead to click through the pipeline
 *
 * Idempotent: re-running upserts the same records rather than duplicating them.
 */
import { PrismaClient, CustomerType, ItemCategory, LeadSource, LeadStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
// The company's seven roles and five approval rules (ADR-02 §3-4). Resolved
// through the workspace link node_modules/@npi/shared -> packages/shared/dist,
// the same way the API loads it, locally and in the api image the demo-reset
// job runs this file in. Run `npm run build -w @npi/shared` after editing them.
import { PROPOSED_APPROVAL_RULES, ROLE_PRESETS } from '@npi/shared';

const prisma = new PrismaClient();

// Full permission surface for the current slice. Kept in sync with
// packages/shared/src/permissions.ts (the API imports it from there).
const ALL_PERMISSIONS = [
  'crm.customer.read', 'crm.customer.write', 'crm.customer.merge', 'crm.task.read',
  'crm.lead.read', 'crm.lead.write',
  'crm.opportunity.read', 'crm.opportunity.write',
  'commercial.item.read', 'commercial.item.write',
  'commercial.proposal.read', 'commercial.proposal.write', 'commercial.proposal.approve',
  'commercial.contract.read', 'commercial.contract.write',
  'finance.invoice.read', 'finance.invoice.write', 'finance.ledger.read',
  'finance.report.read', 'finance.statement.read',
  'finance.costs.view',
  'finance.payment.read', 'finance.payment.write', 'finance.period.manage',
  'projects.project.read', 'projects.project.write', 'projects.project.approve',
  'scm.procurement.read', 'scm.procurement.write', 'scm.procurement.approve',
  'scm.requisition.read', 'scm.requisition.write',
  'assets.serialunit.read',
  'fsm.workorder.read', 'fsm.workorder.write',
  'admin.org.manage', 'admin.user.manage', 'admin.audit.read', 'admin.approval.manage',
  'admin.department.manage', 'admin.delegation.manage', 'admin.workflow.manage',
  'platform.attachment.read', 'platform.attachment.write',
];

// P1-6 (migration 0030_split_view_permissions): the sales array holds
// crm.task.read with crm.customer.read, and finance.report.read with
// finance.statement.read beside finance.ledger.read — the view keys split off
// for /tasks, /finance and /statements. The company's seven roles are not
// written here: they are ROLE_PRESETS (packages/shared/src/presets.ts).
const SALES_PERMISSIONS = [
  'crm.customer.read', 'crm.customer.write', 'crm.task.read',
  'crm.lead.read', 'crm.lead.write',
  'crm.opportunity.read', 'crm.opportunity.write',
  'commercial.item.read',
  'commercial.proposal.read', 'commercial.proposal.write',
  'commercial.contract.read', 'commercial.contract.write',
  'finance.invoice.read', 'finance.invoice.write', 'finance.ledger.read',
  'finance.report.read', 'finance.statement.read',
  'finance.costs.view',
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

  // P1-13 (owner decision 2026-10-12): the company's seven roles are the
  // seed's default, taken from ROLE_PRESETS as they are (key, names, keys), so
  // a fresh tenant — and the demo server after its nightly reset — starts with
  // them and /admin/presets reads every card «مطابق». The upsert also brings a
  // role of an older seed to its preset (names and keys) when the seed is
  // re-run on an existing database; nothing re-runs it on a live tenant (the
  // api image runs `prisma migrate deploy` on boot, never the seed), where the
  // owner applies a preset from /admin/presets through the role service's
  // guards instead.
  const extraRoles: Record<string, string> = {};
  for (const preset of ROLE_PRESETS) {
    const names = { nameAr: preset.nameAr, nameEn: preset.nameEn };
    const permissions = [...preset.permissions];
    const r = await prisma.role.upsert({
      where: { organizationId_key: { organizationId: org.id, key: preset.key } },
      update: { ...names, permissions },
      create: { organizationId: org.id, key: preset.key, ...names, permissions },
    });
    extraRoles[preset.key] = r.id;
  }
  // One login per role. The last three (P1-13) hold the roles the presets
  // added. The Madar e2e fixtures (apps/copilot/e2e/fixtures/accounts.ts) read
  // these entries by regex: keep each on one line, in this shape.
  const userDefs = [
    { email: 'accountant@npi.sa', pass: 'Acc@12345', nameAr: 'أمين الحسابات', nameEn: 'Chief Accountant', role: 'accountant' },
    { email: 'pm@npi.sa', pass: 'Pm@123456', nameAr: 'مدير المشاريع', nameEn: 'Projects Manager', role: 'pm' },
    { email: 'engineer@npi.sa', pass: 'Eng@12345', nameAr: 'مهندس الموقع', nameEn: 'Site Engineer', role: 'site_engineer' },
    { email: 'ceo@npi.sa', pass: 'Ceo@12345', nameAr: 'الرئيس التنفيذي', nameEn: 'Chief Executive', role: 'executive' },
    { email: 'finance@npi.sa', pass: 'Fin@12345', nameAr: 'مدير الإدارة المالية', nameEn: 'Finance Manager', role: 'finance_manager' },
    { email: 'tech@npi.sa', pass: 'Tech@12345', nameAr: 'مهندس المكتب الفني', nameEn: 'Technical Office Engineer', role: 'technical_office' },
    { email: 'store@npi.sa', pass: 'Store@12345', nameAr: 'أمين المستودع', nameEn: 'Warehouse Keeper', role: 'warehouse_keeper' },
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
    { documentType: 'PURCHASE_REQUISITION', prefix: 'PR' },
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
    // Package 4: material requests (MR-00001 …) and issue vouchers (MIS-00001 …).
    { documentType: 'MATERIAL_REQUEST', prefix: 'MR' },
    { documentType: 'EXECUTION_OVERRUN', prefix: 'OVR' },
    { documentType: 'MATERIAL_RETURN', prefix: 'MRT' },
    { documentType: 'MATERIAL_ISSUE', prefix: 'MIS' },
    // CRM Step 5: follow-up tasks (TSK-00001 …).
    { documentType: 'FOLLOWUP_TASK', prefix: 'TSK' },
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
      // CRM Step 2: the unified record's keys. nameNormalized is
      // normalizeArabicName('مصنع الرياض للصناعات') — mirrored by migration 0022's SQL function.
      entityKind: 'COMPANY',
      vatNumber: '310000000000003',
      crNumber: '1010000001',
      creditTermsDays: 30,
      phone: '+966500000000',
      mobile: '+966500000000',
      nameNormalized: 'مصنع رياض للصناعات',
      email: 'procurement@riyadh-industries.sa',
    },
  });
  // `update: {}` above never touches an existing row, so a database seeded
  // before Step 2 would keep a CUS-00001 without the new keys. Fill them in —
  // only where they are still empty, so a real edit is never overwritten.
  await prisma.customer.updateMany({
    where: { id: customer.id, crNumber: null },
    data: { crNumber: '1010000001' },
  });
  await prisma.customer.updateMany({
    where: { id: customer.id, mobile: null },
    data: { mobile: '+966500000000' },
  });
  await prisma.customer.updateMany({
    where: { id: customer.id, nameNormalized: null },
    data: { nameNormalized: 'مصنع رياض للصناعات' },
  });

  // CRM Step 2 settings. `update: {}` — a value an administrator has set is kept.
  for (const [key, value] of [
    ['crm.customer.similarityThreshold', 0.8],
    ['crm.customer.mergeEnabled', false],
    // CRM Step 4: default proposal validity and the cost-age warning limit, in days.
    ['crm.proposal.validityDays', 30],
    ['crm.proposal.costAgeWarnDays', 30],
    // CRM Step 5: a follow-up reminder goes this many days before the due day, at this Riyadh hour.
    ['crm.task.reminderDaysBefore', 1],
    ['crm.task.reminderHour', 8],
  ] as const) {
    await prisma.orgSetting.upsert({
      where: { organizationId_key: { organizationId: org.id, key } },
      update: {},
      create: { organizationId: org.id, key, valueJson: value },
    });
  }

  // CRM Step 5: one example of the communication log and one open follow-up on the demo
  // customer, so the new tabs are not empty on a fresh database. Idempotent: each is
  // created only if its text / title is not there yet, so re-seeding never duplicates
  // and never touches one that was edited or finished.
  {
    const salesUser = await prisma.user.findUniqueOrThrow({ where: { email: 'sales@npi.sa' } });
    const DAY = 86_400_000;
    const callText =
      'اتصلت بالأستاذ أحمد العتيبي (مدير المشتريات) وأكّد اهتمام المصنع بمحطة سقفية بقدرة 500 ك.و.ذ، وطلب عرضاً فنياً ومالياً قبل نهاية الشهر.';
    const hasCall = await prisma.activity.findFirst({
      where: { organizationId: org.id, customerId: customer.id, body: callText },
      select: { id: true },
    });
    if (!hasCall) {
      await prisma.activity.create({
        data: {
          organizationId: org.id,
          customerId: customer.id,
          activityType: 'CALL',
          occurredAt: new Date(Date.now() - DAY),
          body: callText,
          createdById: salesUser.id,
        },
      });
    }

    const taskTitle = 'إرسال العرض الفني المبدئي لمصنع الرياض';
    const hasTask = await prisma.followUpTask.findFirst({
      where: { organizationId: org.id, customerId: customer.id, title: taskTitle },
      select: { id: true },
    });
    if (!hasTask) {
      // The due DAY is stored as UTC midnight of its Riyadh date (Riyadh = UTC+3), the
      // reminder at 08:00 Riyadh the day before — the defaults the application applies.
      const todayRiyadh = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
      const dueAt = new Date(Date.parse(`${todayRiyadh}T00:00:00Z`) + 3 * DAY);
      const remindAt = new Date(dueAt.getTime() - 3 * 3_600_000 - DAY + 8 * 3_600_000);
      // The same atomic increment NumberingService uses.
      const seq = await prisma.numberingSequence.update({
        where: {
          organizationId_documentType_fiscalYear: { organizationId: org.id, documentType: 'FOLLOWUP_TASK', fiscalYear },
        },
        data: { nextValue: { increment: 1 } },
      });
      await prisma.followUpTask.create({
        data: {
          organizationId: org.id,
          code: `${seq.prefix}-${String(seq.nextValue - 1).padStart(seq.padding, '0')}`,
          customerId: customer.id,
          title: taskTitle,
          details: 'يشمل الجدول الزمني للتركيب وملخص العائد المتوقع.',
          dueAt,
          remindAt,
          assigneeId: salesUser.id,
          createdById: salesUser.id,
        },
      });
    }
  }

  // CRM Phase 1 (Step 3): the six default reasons an opportunity is lost, in the
  // order a salesperson sees them. Editable from Admin > Loss reasons; a reason
  // is switched off, never deleted. Re-seeding never touches a reason the
  // administrator has renamed, reordered or switched off (update: {}).
  const lossReasons: Array<{ nameAr: string; nameEn: string; sortOrder: number }> = [
    { nameAr: 'السعر', nameEn: 'Price', sortOrder: 1 },
    { nameAr: 'اختيار منافس', nameEn: 'Competitor chosen', sortOrder: 2 },
    { nameAr: 'إلغاء المشروع أو تأجيله', nameEn: 'Project cancelled or postponed', sortOrder: 3 },
    { nameAr: 'عدم توفر التمويل', nameEn: 'Funding not available', sortOrder: 4 },
    { nameAr: 'عدم استيفاء شروط المناقصة', nameEn: 'Tender requirements not met', sortOrder: 5 },
    { nameAr: 'أخرى', nameEn: 'Other', sortOrder: 6 },
  ];
  for (const r of lossReasons) {
    await prisma.lossReason.upsert({
      where: { organizationId_nameAr: { organizationId: org.id, nameAr: r.nameAr } },
      update: {},
      create: { organizationId: org.id, ...r },
    });
  }

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
      status: 'NEGOTIATING' as LeadStatus,
      estimatedKwp: 500,
      phone: '+966500000000',
      email: 'ahmed@riyadh-industries.sa',
      ownerId: admin.id,
      customerId: customer.id,
    },
  });

  // ── M4: adopt the documents that existed before the engine did ───────────
  //
  // Every purchase order, receipt and vendor bill written before this release
  // has a status but no flow instance. Without an instance the engine refuses
  // to move them — `transition()` starts by looking one up — so an approved PO
  // from last week could never be sent, received, or closed. They would be
  // quietly frozen, which is the kind of migration failure nobody notices
  // until a user does.
  //
  // Idempotent, and safe to re-run: it only ever adopts documents that have no
  // instance yet. The state codes were deliberately named after the existing
  // enum values, so adoption is a lookup rather than a translation — with one
  // exception, noted below.
  const adoptions: Array<{
    flow: string;
    rows: Array<{ id: string; code: string; status: string }>;
  }> = [
    {
      flow: 'PURCHASE_REQUISITION',
      rows: await prisma.purchaseRequisition.findMany({
        where: { organizationId: org.id },
        select: { id: true, code: true, status: true },
      }),
    },
    {
      flow: 'PURCHASE_ORDER',
      rows: await prisma.purchaseOrder.findMany({
        where: { organizationId: org.id },
        select: { id: true, code: true, status: true },
      }),
    },
    {
      flow: 'GOODS_RECEIPT',
      rows: await prisma.goodsReceipt.findMany({
        where: { organizationId: org.id },
        select: { id: true, code: true, status: true },
      }),
    },
    {
      flow: 'VENDOR_BILL',
      rows: await prisma.vendorBill.findMany({
        where: { organizationId: org.id },
        select: { id: true, code: true, status: true },
      }),
    },
    // CRM Step 4: proposals written before the engine knew them are adopted in the
    // state they are in (migration 0027 does the same for existing organizations).
    {
      flow: 'PROPOSAL',
      rows: await prisma.proposal.findMany({
        where: { organizationId: org.id },
        select: { id: true, code: true, status: true },
      }),
    },
  ];

  let adopted = 0;
  for (const group of adoptions) {
    const def = await prisma.wfDefinition.findFirst({
      where: { organizationId: org.id, code: group.flow, isActive: true },
      include: { states: true },
      orderBy: { version: 'desc' },
    });
    if (!def) continue;
    const byCode = new Map(def.states.map((st) => [st.code, st]));

    for (const row of group.rows) {
      const existing = await prisma.wfInstance.findFirst({
        where: {
          organizationId: org.id,
          documentType: def.documentType,
          documentId: row.id,
        },
        select: { id: true },
      });
      if (existing) continue;

      // The one translation: 'POSTED' is a pre-M4 vendor-bill status with no
      // state in the new flow. It meant "the journal has been posted", which is
      // exactly what APPROVED means now.
      const stateCode = row.status === 'POSTED' ? 'APPROVED' : row.status;
      const state = byCode.get(stateCode);
      if (!state) {
        console.warn(
          `   ⚠ ${group.flow} ${row.code}: status "${row.status}" has no state in the flow — left unadopted`,
        );
        continue;
      }

      await prisma.wfInstance.create({
        data: {
          organizationId: org.id,
          definitionId: def.id,
          documentType: def.documentType,
          documentId: row.id,
          documentCode: row.code,
          currentState: state.code,
          // A document already in a final state is finished: closing it keeps
          // it out of every task box rather than parking historic paperwork in
          // somebody's inbox on the day of the upgrade.
          closedAt: state.kind === 'FINAL' ? new Date() : null,
          history: {
            create: {
              fromState: state.code,
              toState: state.code,
              actionCode: 'ADOPT',
              // No actor: nobody performed this move. Attributing it to whoever
              // happened to run the seed would be a false entry in an
              // append-only trail.
              actorId: null,
              comment: 'Adopted into the workflow engine at the M4 migration',
            },
          },
        },
      });
      adopted += 1;
    }
  }
  if (adopted > 0) console.log(`   Adopted ${adopted} pre-M4 document(s) into the workflow engine.`);

  // ── Package و: a starting approval matrix ─────────────────────────────────
  // Seeded so a fresh tenant has a working delegation of authority rather than
  // the pre-matrix state where one permission approved any amount. P1-13 (owner
  // decision 2026-10-12): the five rules of PROPOSED_APPROVAL_RULES, one active
  // rule per document type, each from 0 SAR with an open ceiling (so the
  // matrix's overlap guard has nothing to compare), and every requisition,
  // order, claim, change order and proposal is signed by its chain:
  //   requisition: pm · order: executive · claim: pm, then executive ·
  //   change order: executive · proposal: executive (CRM-S4-a, as before).
  // Floors and chains are edited from Admin > Approval matrix, not in code.
  // Only created when absent — an organization that has tuned its own bands
  // must never have them overwritten by a re-seed (the nightly demo reset
  // drops the database first, so it always starts from these five).
  const roleIdByKey: Record<string, string> = {
    admin: adminRole.id,
    sales: salesRole.id,
    ...extraRoles,
  };

  for (const rule of PROPOSED_APPROVAL_RULES) {
    const exists = await prisma.approvalRule.findFirst({
      where: { organizationId: org.id, documentType: rule.documentType },
    });
    if (exists) continue;
    await prisma.approvalRule.create({
      data: {
        organizationId: org.id,
        documentType: rule.documentType,
        minAmount: rule.minAmount,
        maxAmount: null,
        // M4: 48 hours before the chain is escalated. Escalation notifies —
        // it never signs. See ApprovalEscalationScheduler.
        escalationHours: 48,
        steps: {
          create: rule.steps.map((key, i) => ({ sequence: i + 1, roleId: roleIdByKey[key] })),
        },
      },
    });
  }

  // ── M4: departments, the third dimension of the approval matrix ──────────
  // "مدير القسم" in §5 is meaningless without one, and the system had no
  // notion of a department at all before this.
  const deptDefs = [
    { code: 'OPS', nameAr: 'العمليات والمشاريع', nameEn: 'Operations & Projects' },
    { code: 'ENG', nameAr: 'الهندسة', nameEn: 'Engineering' },
    { code: 'FIN', nameAr: 'المالية', nameEn: 'Finance' },
    { code: 'ADM', nameAr: 'الإدارة', nameEn: 'Administration' },
  ];
  const deptIdByCode: Record<string, string> = {};
  for (const d of deptDefs) {
    const dept = await prisma.department.upsert({
      where: { organizationId_code: { organizationId: org.id, code: d.code } },
      update: { nameAr: d.nameAr, nameEn: d.nameEn },
      create: { organizationId: org.id, code: d.code, nameAr: d.nameAr, nameEn: d.nameEn },
    });
    deptIdByCode[d.code] = dept.id;
  }

  // ── M4: the four flows of §7 ─────────────────────────────────────────────
  //
  // These are data, not code. Which states exist and which moves are legal is
  // configurable per organization and versioned — the engine reads them, and
  // an unlisted move cannot happen. Editing a flow does not need a deploy;
  // editing what a *transition means* does, which is the correct division.
  type StateSeed = { code: string; nameAr: string; nameEn: string; kind: 'INITIAL' | 'INTERMEDIATE' | 'FINAL' };
  type TransitionSeed = {
    from: string;
    to: string;
    action: string;
    nameAr: string;
    nameEn: string;
    permission: string;
    condition?: string;
    emits?: string;
    requiresApproval?: boolean;
  };
  const flows: Array<{
    code: string;
    nameAr: string;
    nameEn: string;
    documentType: string;
    states: StateSeed[];
    transitions: TransitionSeed[];
  }> = [
    {
      code: 'PURCHASE_REQUISITION',
      nameAr: 'طلب شراء',
      nameEn: 'Purchase requisition',
      documentType: 'PurchaseRequisition',
      states: [
        { code: 'DRAFT', nameAr: 'مسودة', nameEn: 'Draft', kind: 'INITIAL' },
        { code: 'PENDING_APPROVAL', nameAr: 'قيد الاعتماد', nameEn: 'Pending approval', kind: 'INTERMEDIATE' },
        { code: 'APPROVED', nameAr: 'معتمد', nameEn: 'Approved', kind: 'INTERMEDIATE' },
        { code: 'RETURNED', nameAr: 'معاد', nameEn: 'Returned', kind: 'INTERMEDIATE' },
        { code: 'REJECTED', nameAr: 'مرفوض', nameEn: 'Rejected', kind: 'FINAL' },
        { code: 'CONVERTED', nameAr: 'محوَّل لأمر شراء', nameEn: 'Converted to PO', kind: 'FINAL' },
        { code: 'CANCELLED', nameAr: 'ملغى', nameEn: 'Cancelled', kind: 'FINAL' },
      ],
      transitions: [
        // A requisition with no value cannot be banded by the matrix, so it
        // cannot be approved by the right people. Refuse it at submission.
        { from: 'DRAFT', to: 'PENDING_APPROVAL', action: 'SUBMIT', nameAr: 'رفع للاعتماد', nameEn: 'Submit for approval', permission: 'scm.requisition.write', condition: 'estimatedTotal > 0', requiresApproval: true },
        { from: 'RETURNED', to: 'PENDING_APPROVAL', action: 'SUBMIT', nameAr: 'إعادة الرفع', nameEn: 'Resubmit', permission: 'scm.requisition.write', condition: 'estimatedTotal > 0', requiresApproval: true },
        { from: 'DRAFT', to: 'CANCELLED', action: 'CANCEL', nameAr: 'إلغاء', nameEn: 'Cancel', permission: 'scm.requisition.write' },
        { from: 'PENDING_APPROVAL', to: 'APPROVED', action: 'APPROVE', nameAr: 'اعتماد', nameEn: 'Approve', permission: 'scm.procurement.approve', emits: 'pr.approved' },
        { from: 'PENDING_APPROVAL', to: 'REJECTED', action: 'REJECT', nameAr: 'رفض', nameEn: 'Reject', permission: 'scm.procurement.approve' },
        { from: 'PENDING_APPROVAL', to: 'RETURNED', action: 'RETURN', nameAr: 'إعادة لمقدّم الطلب', nameEn: 'Return to requester', permission: 'scm.procurement.write' },
        { from: 'APPROVED', to: 'CONVERTED', action: 'CONVERT', nameAr: 'تحويل لأمر شراء', nameEn: 'Convert to purchase order', permission: 'scm.procurement.write' },
      ],
    },
    {
      code: 'PURCHASE_ORDER',
      nameAr: 'أمر شراء',
      nameEn: 'Purchase order',
      documentType: 'PurchaseOrder',
      states: [
        { code: 'DRAFT', nameAr: 'مسودة', nameEn: 'Draft', kind: 'INITIAL' },
        { code: 'PENDING_APPROVAL', nameAr: 'قيد الاعتماد', nameEn: 'Pending approval', kind: 'INTERMEDIATE' },
        { code: 'APPROVED', nameAr: 'معتمد', nameEn: 'Approved', kind: 'INTERMEDIATE' },
        { code: 'SENT', nameAr: 'مرسَل للمورّد', nameEn: 'Sent to vendor', kind: 'INTERMEDIATE' },
        { code: 'PARTIALLY_RECEIVED', nameAr: 'مستلَم جزئياً', nameEn: 'Partially received', kind: 'INTERMEDIATE' },
        { code: 'RECEIVED', nameAr: 'مستلَم', nameEn: 'Received', kind: 'INTERMEDIATE' },
        { code: 'CLOSED', nameAr: 'مغلق', nameEn: 'Closed', kind: 'FINAL' },
        { code: 'CANCELLED', nameAr: 'ملغى', nameEn: 'Cancelled', kind: 'FINAL' },
      ],
      transitions: [
        { from: 'DRAFT', to: 'PENDING_APPROVAL', action: 'SUBMIT', nameAr: 'رفع للاعتماد', nameEn: 'Submit for approval', permission: 'scm.procurement.write', condition: 'total > 0', requiresApproval: true },
        { from: 'DRAFT', to: 'CANCELLED', action: 'CANCEL', nameAr: 'إلغاء', nameEn: 'Cancel', permission: 'scm.procurement.write' },
        { from: 'PENDING_APPROVAL', to: 'APPROVED', action: 'APPROVE', nameAr: 'اعتماد', nameEn: 'Approve', permission: 'scm.procurement.approve', emits: 'po.approved' },
        { from: 'PENDING_APPROVAL', to: 'CANCELLED', action: 'REJECT', nameAr: 'رفض', nameEn: 'Reject', permission: 'scm.procurement.approve' },
        { from: 'APPROVED', to: 'SENT', action: 'SEND', nameAr: 'إرسال للمورّد', nameEn: 'Send to vendor', permission: 'scm.procurement.write', emits: 'po.sent' },
        // RECEIVE moves are written by the receipt flow's acceptance, inside
        // its transaction — they are listed so the map is complete and the
        // history reads as one story.
        { from: 'SENT', to: 'PARTIALLY_RECEIVED', action: 'RECEIVE', nameAr: 'استلام جزئي', nameEn: 'Partial receipt', permission: 'scm.procurement.write' },
        { from: 'SENT', to: 'RECEIVED', action: 'CLOSE', nameAr: 'استلام كامل', nameEn: 'Full receipt', permission: 'scm.procurement.write' },
        { from: 'PARTIALLY_RECEIVED', to: 'RECEIVED', action: 'CLOSE', nameAr: 'اكتمال الاستلام', nameEn: 'Complete receipt', permission: 'scm.procurement.write' },
        { from: 'RECEIVED', to: 'CLOSED', action: 'CLOSE', nameAr: 'إقفال', nameEn: 'Close', permission: 'scm.procurement.write' },
      ],
    },
    {
      code: 'GOODS_RECEIPT',
      nameAr: 'محضر استلام',
      nameEn: 'Goods receipt',
      documentType: 'GoodsReceipt',
      states: [
        { code: 'DRAFT', nameAr: 'مسودة', nameEn: 'Draft', kind: 'INITIAL' },
        { code: 'INSPECTED', nameAr: 'مفحوص', nameEn: 'Inspected', kind: 'INTERMEDIATE' },
        { code: 'ACCEPTED', nameAr: 'مقبول', nameEn: 'Accepted', kind: 'FINAL' },
        { code: 'PARTIALLY_REJECTED', nameAr: 'مرفوض جزئياً', nameEn: 'Partially rejected', kind: 'FINAL' },
      ],
      transitions: [
        { from: 'DRAFT', to: 'INSPECTED', action: 'INSPECT', nameAr: 'تسجيل الفحص', nameEn: 'Record inspection', permission: 'scm.procurement.write' },
        { from: 'INSPECTED', to: 'ACCEPTED', action: 'ACCEPT', nameAr: 'قبول الاستلام', nameEn: 'Accept delivery', permission: 'scm.procurement.write', emits: 'goods.received' },
        { from: 'INSPECTED', to: 'PARTIALLY_REJECTED', action: 'REJECT_PARTIAL', nameAr: 'رفض جزئي', nameEn: 'Partially reject', permission: 'scm.procurement.write' },
      ],
    },
    {
      code: 'VENDOR_BILL',
      nameAr: 'فاتورة مورّد',
      nameEn: 'Vendor bill',
      documentType: 'VendorBill',
      states: [
        { code: 'DRAFT', nameAr: 'مسجَّلة', nameEn: 'Recorded', kind: 'INITIAL' },
        { code: 'MATCHED', nameAr: 'مطابقة ثلاثياً', nameEn: 'Three-way matched', kind: 'INTERMEDIATE' },
        { code: 'APPROVED', nameAr: 'معتمدة', nameEn: 'Approved', kind: 'INTERMEDIATE' },
        { code: 'SCHEDULED', nameAr: 'مجدولة للدفع', nameEn: 'Scheduled for payment', kind: 'INTERMEDIATE' },
        { code: 'PAID', nameAr: 'مدفوعة', nameEn: 'Paid', kind: 'FINAL' },
      ],
      transitions: [
        { from: 'DRAFT', to: 'MATCHED', action: 'MATCH', nameAr: 'مطابقة ثلاثية', nameEn: 'Run three-way match', permission: 'scm.procurement.write', emits: 'invoice.matched' },
        // The condition is the control: a bill whose match came back with a
        // variance cannot be approved until someone fixes the variance. A
        // company that wants to allow approving a price variance edits this
        // row — it does not need a release.
        { from: 'MATCHED', to: 'APPROVED', action: 'APPROVE', nameAr: 'اعتماد الفاتورة', nameEn: 'Approve bill', permission: 'finance.payment.write', condition: 'matchResult == "MATCHED"', emits: 'invoice.approved' },
        { from: 'MATCHED', to: 'DRAFT', action: 'RETURN', nameAr: 'إعادة للمراجعة', nameEn: 'Return for review', permission: 'finance.payment.write' },
        { from: 'APPROVED', to: 'SCHEDULED', action: 'SCHEDULE', nameAr: 'جدولة الدفع', nameEn: 'Schedule payment', permission: 'finance.payment.write' },
        { from: 'SCHEDULED', to: 'PAID', action: 'PAY', nameAr: 'سداد', nameEn: 'Pay', permission: 'finance.payment.write', emits: 'invoice.paid' },
      ],
    },
    // CRM Step 4 (spec 4.3 / §9): the numbered, approved proposal. The same 7 states and
    // 12 transitions migration 0027 writes for the organizations that already exist.
    // REJECTED and EXPIRED are not final: the document itself says a change after
    // sending is a new revision, and a refused or expired offer can be revived the same way.
    {
      code: 'PROPOSAL',
      nameAr: 'عرض سعر',
      nameEn: 'Proposal',
      documentType: 'Proposal',
      states: [
        { code: 'DRAFT', nameAr: 'مسودة', nameEn: 'Draft', kind: 'INITIAL' },
        { code: 'PENDING_APPROVAL', nameAr: 'بانتظار الاعتماد', nameEn: 'Pending approval', kind: 'INTERMEDIATE' },
        { code: 'APPROVED', nameAr: 'معتمد', nameEn: 'Approved', kind: 'INTERMEDIATE' },
        { code: 'SENT', nameAr: 'مُرسَل', nameEn: 'Sent to customer', kind: 'INTERMEDIATE' },
        { code: 'ACCEPTED', nameAr: 'مقبول', nameEn: 'Accepted', kind: 'FINAL' },
        { code: 'REJECTED', nameAr: 'مرفوض', nameEn: 'Rejected by customer', kind: 'INTERMEDIATE' },
        { code: 'EXPIRED', nameAr: 'منتهي الصلاحية', nameEn: 'Expired', kind: 'INTERMEDIATE' },
      ],
      transitions: [
        { from: 'DRAFT', to: 'PENDING_APPROVAL', action: 'SUBMIT', nameAr: 'رفع للاعتماد', nameEn: 'Submit for approval', permission: 'commercial.proposal.write', condition: 'total > 0', requiresApproval: true },
        // Performed by the matrix's applier / rejecter only — no endpoint offers these.
        { from: 'PENDING_APPROVAL', to: 'APPROVED', action: 'APPROVE', nameAr: 'اعتماد', nameEn: 'Approve', permission: 'commercial.proposal.approve', emits: 'proposal.approved' },
        { from: 'PENDING_APPROVAL', to: 'DRAFT', action: 'RETURN', nameAr: 'إعادة للمسودة', nameEn: 'Return to draft', permission: 'commercial.proposal.approve' },
        { from: 'APPROVED', to: 'SENT', action: 'SEND', nameAr: 'إرسال للعميل', nameEn: 'Send to customer', permission: 'commercial.proposal.write', emits: 'proposal.sent' },
        { from: 'SENT', to: 'ACCEPTED', action: 'ACCEPT', nameAr: 'قبول العميل', nameEn: 'Customer accepted', permission: 'commercial.proposal.write', emits: 'proposal.accepted' },
        { from: 'SENT', to: 'REJECTED', action: 'REJECT', nameAr: 'رفض العميل', nameEn: 'Customer rejected', permission: 'commercial.proposal.write' },
        // EXPIRE is performed by the system actor (nightly sweep), never by a person.
        { from: 'APPROVED', to: 'EXPIRED', action: 'EXPIRE', nameAr: 'انتهاء الصلاحية', nameEn: 'Expire', permission: 'commercial.proposal.write', emits: 'proposal.expired' },
        { from: 'SENT', to: 'EXPIRED', action: 'EXPIRE', nameAr: 'انتهاء الصلاحية', nameEn: 'Expire', permission: 'commercial.proposal.write', emits: 'proposal.expired' },
        { from: 'APPROVED', to: 'DRAFT', action: 'REVISE', nameAr: 'نسخة جديدة', nameEn: 'New revision', permission: 'commercial.proposal.write' },
        { from: 'SENT', to: 'DRAFT', action: 'REVISE', nameAr: 'نسخة جديدة', nameEn: 'New revision', permission: 'commercial.proposal.write' },
        { from: 'REJECTED', to: 'DRAFT', action: 'REVISE', nameAr: 'نسخة جديدة', nameEn: 'New revision', permission: 'commercial.proposal.write' },
        { from: 'EXPIRED', to: 'DRAFT', action: 'REVISE', nameAr: 'نسخة جديدة', nameEn: 'New revision', permission: 'commercial.proposal.write' },
      ],
    },
  ];

  for (const f of flows) {
    const def = await prisma.wfDefinition.upsert({
      where: { organizationId_code_version: { organizationId: org.id, code: f.code, version: 1 } },
      update: { nameAr: f.nameAr, nameEn: f.nameEn, documentType: f.documentType, isActive: true },
      create: {
        organizationId: org.id,
        code: f.code,
        nameAr: f.nameAr,
        nameEn: f.nameEn,
        documentType: f.documentType,
        version: 1,
      },
    });
    for (const [i, st] of f.states.entries()) {
      await prisma.wfState.upsert({
        where: { definitionId_code: { definitionId: def.id, code: st.code } },
        update: { nameAr: st.nameAr, nameEn: st.nameEn, kind: st.kind, sortOrder: i },
        create: {
          definitionId: def.id,
          code: st.code,
          nameAr: st.nameAr,
          nameEn: st.nameEn,
          kind: st.kind,
          sortOrder: i,
        },
      });
    }
    for (const [i, t] of f.transitions.entries()) {
      await prisma.wfTransition.upsert({
        where: {
          definitionId_fromState_actionCode: {
            definitionId: def.id,
            fromState: t.from,
            actionCode: t.action,
          },
        },
        update: {
          toState: t.to,
          nameAr: t.nameAr,
          nameEn: t.nameEn,
          requiredPermission: t.permission,
          conditionExpr: t.condition ?? null,
          emitsEvent: t.emits ?? null,
          requiresApproval: t.requiresApproval ?? false,
          sortOrder: i,
        },
        create: {
          definitionId: def.id,
          fromState: t.from,
          toState: t.to,
          actionCode: t.action,
          nameAr: t.nameAr,
          nameEn: t.nameEn,
          requiredPermission: t.permission,
          conditionExpr: t.condition ?? null,
          emitsEvent: t.emits ?? null,
          requiresApproval: t.requiresApproval ?? false,
          sortOrder: i,
        },
      });
    }
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
