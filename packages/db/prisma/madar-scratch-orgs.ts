/**
 * Dev-only: creates (and on re-run resets) six "scratch" Madar organizations,
 * one per Madar profile key, so the copilot's live setup eval (T-20) can apply
 * real configuration writes to NPI without touching the demo tenant
 * (org_npi_root).
 *
 * Each scratch org gets the same five roles and one login per role as the
 * demo seed (packages/db/prisma/seed.ts), plus numbering sequences for every
 * document type — nothing else. No departments, items, approval rules or
 * customers: the setup flow under test creates those itself.
 *
 * Idempotent: re-running deletes and recreates all six orgs (the "reset"
 * path), so two consecutive runs produce identical state.
 *
 * Usage:
 *   npm run db:seed:madar-scratch            # reset: delete + recreate all six
 *   npm run db:seed:madar-scratch -- --keep  # leave existing scratch orgs alone; only create missing ones
 *
 * Never import this file from seed.ts (or vice versa) — each runs its own
 * main() on import.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// The copilot's e2e fixture reads this constant by regex — keep this exact line.
const SCRATCH_PASSWORD = 'Scratch@12345';

const PROFILE_KEYS = [
  'epc',
  'om_provider',
  'ppa_operator',
  'general_contracting',
  'equipment_trading',
  'engineering_consulting',
] as const;
type ProfileKey = (typeof PROFILE_KEYS)[number];

function scratchOrgId(key: ProfileKey): string {
  return `org_madar_scratch_${key}`;
}

// ── Permission sets ──────────────────────────────────────────────────────
// packages/shared/src/permissions.ts exports the same 34 keys as ALL_PERMISSIONS
// below (as PERMISSIONS/ALL_PERMISSIONS), but @npi/shared is not a declared
// dependency of @npi/db (only @prisma/client is) — importing it here would
// work only by accident of npm workspace hoisting. Copied instead, per the
// same "kept in sync by comment" convention seed.ts already uses.

// Copied from packages/db/prisma/seed.ts (lines 18-34); keep in sync.
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
  'scm.procurement.read', 'scm.procurement.write', 'scm.requisition.write',
  'assets.serialunit.read',
  'fsm.workorder.read', 'fsm.workorder.write',
  'admin.org.manage', 'admin.user.manage', 'admin.audit.read', 'admin.approval.manage',
  'admin.department.manage', 'admin.delegation.manage', 'admin.workflow.manage',
  'platform.attachment.read', 'platform.attachment.write',
];

// Copied from packages/db/prisma/seed.ts (lines 36-45); keep in sync.
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

// Copied from packages/db/prisma/seed.ts (lines 48-55); keep in sync.
const ACCOUNTANT_PERMISSIONS = [
  'finance.invoice.read', 'finance.invoice.write', 'finance.ledger.read',
  'finance.payment.read', 'finance.payment.write', 'finance.period.manage',
  'crm.customer.read',
  'commercial.contract.read', 'commercial.proposal.read', 'commercial.item.read',
  'scm.procurement.read', 'scm.procurement.write', 'scm.requisition.write',
  'platform.attachment.read', 'platform.attachment.write',
];

// Copied from packages/db/prisma/seed.ts (lines 58-67); keep in sync.
const PM_PERMISSIONS = [
  'projects.project.read', 'projects.project.write',
  'scm.procurement.read', 'scm.procurement.write', 'scm.requisition.write',
  'assets.serialunit.read',
  'commercial.contract.read', 'commercial.item.read',
  'crm.customer.read',
  'fsm.workorder.read',
  'finance.invoice.read',
  'platform.attachment.read', 'platform.attachment.write',
];

// Copied from packages/db/prisma/seed.ts (lines 70-80); keep in sync.
const SITE_ENGINEER_PERMISSIONS = [
  'fsm.workorder.read', 'fsm.workorder.write',
  'assets.serialunit.read',
  'scm.procurement.read', 'scm.requisition.write',
  'commercial.item.read',
  'projects.project.read',
  'platform.attachment.read', 'platform.attachment.write',
];

// Identical in keys/names/permission sets to the demo seed's five roles
// (packages/db/prisma/seed.ts lines 99-136).
const ROLE_DEFS = [
  { key: 'admin', nameAr: 'مدير النظام', nameEn: 'Administrator', permissions: ALL_PERMISSIONS },
  { key: 'sales', nameAr: 'مندوب مبيعات', nameEn: 'Sales Representative', permissions: SALES_PERMISSIONS },
  { key: 'accountant', nameAr: 'محاسب', nameEn: 'Accountant', permissions: ACCOUNTANT_PERMISSIONS },
  { key: 'pm', nameAr: 'مدير مشاريع', nameEn: 'Project Manager', permissions: PM_PERMISSIONS },
  { key: 'site_engineer', nameAr: 'مهندس موقع', nameEn: 'Site Engineer', permissions: SITE_ENGINEER_PERMISSIONS },
] as const;

// One login per role. `emailLocal` is the part before "@<domain>", where the
// domain is `scratchDomain(key)`: the profile key with underscores turned into
// hyphens (NPI's `@IsEmail()` and the browser's `type="email"` both reject an
// underscore in a domain label), e.g. admin@om-provider.scratch.madar.test.
/** E-mail domain of a scratch org's users: underscores become hyphens. */
function scratchDomain(key: string): string {
  return `${key.replaceAll('_', '-')}.scratch.madar.test`;
}

const USER_DEFS = [
  { emailLocal: 'admin', roleKey: 'admin', nameAr: 'مدير النظام', nameEn: 'System Administrator' },
  { emailLocal: 'sales', roleKey: 'sales', nameAr: 'مندوب المبيعات', nameEn: 'Sales Rep' },
  { emailLocal: 'accountant', roleKey: 'accountant', nameAr: 'أمين الحسابات', nameEn: 'Chief Accountant' },
  { emailLocal: 'pm', roleKey: 'pm', nameAr: 'مدير المشاريع', nameEn: 'Projects Manager' },
  { emailLocal: 'engineer', roleKey: 'site_engineer', nameAr: 'مهندس الموقع', nameEn: 'Site Engineer' },
] as const;

// Same document types/prefixes as packages/db/prisma/seed.ts's seqDefs (lines
// 194-220). Scratch orgs have no pre-seeded documents, so every sequence
// starts at nextValue 1 (seed.ts's startValue bump for CUSTOMER/LEAD/VENDOR
// does not apply here).
const SEQ_DEFS: Array<{ documentType: string; prefix: string }> = [
  { documentType: 'CUSTOMER', prefix: 'CUS' },
  { documentType: 'LEAD', prefix: 'LEAD' },
  { documentType: 'OPPORTUNITY', prefix: 'OPP' },
  { documentType: 'PROPOSAL', prefix: 'PRP' },
  { documentType: 'CONTRACT', prefix: 'CTR' },
  { documentType: 'INVOICE', prefix: 'INV' },
  { documentType: 'VENDOR', prefix: 'VEN' },
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
];

/** Same guard as apps/api/test/tenant-isolation.int-spec.ts (lines ~77-80). */
function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
    return;
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    console.error('DATABASE_URL could not be parsed as a URL. Refusing to run.');
    process.exit(1);
    return;
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    // The host name is deliberately not echoed: it is derived from DATABASE_URL,
    // and a connection string's parts do not belong in a log line.
    console.error(
      'Refusing to run against a non-local database. ' +
        'This script deletes and recreates organizations and must only ever run against a local database.',
    );
    process.exit(1);
  }
}

/**
 * Deletes one scratch org (if it exists) and everything under it, scoped
 * strictly to its own id.
 *
 * Most children cascade automatically when Organization is deleted (Role,
 * User, Department, Item, NumberingSequence, ApprovalRule/Step, Notification,
 * the workflow tables, etc. — see schema.prisma). Three tables are
 * `onDelete: Restrict` on their organization relation because they are
 * statutory records (AuditLog, Invoice, JournalEntry) and must be deleted
 * explicitly first, children before parents, in one transaction. A scratch
 * org created by this script never has Invoice/JournalEntry rows on its own,
 * but the config-apply flow under test writes AuditLog entries for every
 * mutation, so that one is cleared on every real run.
 */
async function resetScratchOrg(id: string): Promise<void> {
  const existing = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return;

  await prisma.$transaction([
    // ApprovalRuleStep.role has no onDelete rule (schema.prisma, model
    // ApprovalRuleStep), so once the setup under test has created approval
    // rules, deleting the org's roles would be refused — delete the steps
    // of this org's rules first. Found on the second T-20 live run.
    prisma.approvalRuleStep.deleteMany({ where: { rule: { organizationId: id } } }),
    // JournalLine/InvoiceLine/EInvoiceDocument cascade from these automatically.
    prisma.journalEntry.deleteMany({ where: { organizationId: id } }),
    prisma.invoice.deleteMany({ where: { organizationId: id } }),
    prisma.auditLog.deleteMany({ where: { organizationId: id } }),
    prisma.organization.delete({ where: { id } }),
  ]);
}

async function createScratchOrg(key: ProfileKey, id: string, fiscalYear: number, passwordHash: string): Promise<void> {
  const org = await prisma.organization.create({
    data: {
      id,
      legalNameAr: `منشأة تجريبية — مَدار (${key})`,
      legalNameEn: `Madar scratch organization (${key})`,
      baseCurrency: 'SAR',
      isTenantRoot: true,
    },
  });

  const roleIdByKey: Record<string, string> = {};
  for (const rd of ROLE_DEFS) {
    const role = await prisma.role.create({
      data: {
        organizationId: org.id,
        key: rd.key,
        nameAr: rd.nameAr,
        nameEn: rd.nameEn,
        permissions: rd.permissions,
      },
    });
    roleIdByKey[rd.key] = role.id;
  }

  for (const ud of USER_DEFS) {
    await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `${ud.emailLocal}@${scratchDomain(key)}`,
        passwordHash,
        nameAr: ud.nameAr,
        nameEn: ud.nameEn,
        locale: 'AR',
        isActive: true,
        roleId: roleIdByKey[ud.roleKey],
      },
    });
  }

  for (const s of SEQ_DEFS) {
    await prisma.numberingSequence.create({
      data: {
        organizationId: org.id,
        documentType: s.documentType,
        prefix: s.prefix,
        fiscalYear,
        nextValue: 1,
      },
    });
  }
}

async function main(): Promise<void> {
  assertLocalDatabase();

  const keep = process.argv.includes('--keep');
  const fiscalYear = new Date().getUTCFullYear();
  const passwordHash = await bcrypt.hash(SCRATCH_PASSWORD, 10);

  for (const key of PROFILE_KEYS) {
    const id = scratchOrgId(key);

    if (keep) {
      const existing = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
      if (existing) {
        console.log(`kept ${id} (--keep)`);
        continue;
      }
    } else {
      await resetScratchOrg(id);
    }

    await createScratchOrg(key, id, fiscalYear, passwordHash);
    console.log(`created ${id} (5 users)`);
  }

  console.log('Done. Admin logins follow the pattern admin@<key-with-hyphens>.scratch.madar.test for each profile key above.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
