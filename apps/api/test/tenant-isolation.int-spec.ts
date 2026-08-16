/**
 * Phase 3 — tenant isolation, against a real PostgreSQL.
 *
 * A second organization is built with its own customer, contract, milestone,
 * invoice, retention entry, journal and attachment. Then a user of org A is
 * pointed at each of org B's records by explicit id — the attack that matters,
 * because ids travel in URLs and nothing stops a caller from typing one.
 *
 * Every attempt must fail with 404, never 403. The distinction is not
 * cosmetic: 403 confirms the record exists, and "there is an invoice with this
 * id, you just cannot see it" is itself a disclosure. A tenant must not be able
 * to learn that another tenant's data exists.
 */
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { NumberingService } from '../src/common/numbering.service';
import { AuditService } from '../src/common/audit.service';
import { PostingService } from '../src/common/posting.service';
import { TaxService } from '../src/common/tax.service';
import { NotificationService } from '../src/common/notification.service';
import { ZatcaService } from '../src/modules/finance/zatca.service';
import { InvoicesService } from '../src/modules/finance/invoices.service';
import { ContractsService } from '../src/modules/commercial/contracts.service';
import { CustomersService } from '../src/modules/crm/customers.service';
import { AttachmentsService } from '../src/modules/platform/attachments.service';
import type { AuthUser } from '../src/common/auth-user';

const prisma = new PrismaService();
const numbering = new NumberingService(prisma);
const audit = new AuditService(prisma);
const posting = new PostingService(prisma);
const notifications = new NotificationService(prisma);

const invoices = new InvoicesService(
  prisma, numbering, audit, posting, new TaxService(prisma), new ZatcaService(), notifications,
);
const contracts = new ContractsService(prisma, numbering, audit, notifications);
const customers = new CustomersService(prisma, numbering, audit);
const attachments = new AttachmentsService(prisma, audit);

/** Everything org B owns, for org A to fail to reach. */
const B = {
  organizationId: '',
  userId: '',
  customerId: '',
  contractId: '',
  milestoneId: '',
  invoiceId: '',
  retentionEntryId: '',
  journalEntryId: '',
  attachmentId: '',
};
let ATTACKER: AuthUser;

/**
 * A 404 and nothing else. A ForbiddenException is called out by name because
 * it is the plausible wrong answer: it means the code found the record, knew
 * it belonged to someone else, and said so.
 */
async function must404(what: string, attempt: () => Promise<unknown>) {
  let thrown: unknown;
  try {
    await attempt();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`${what}: crossed the tenant boundary and returned data`);
  }
  if (thrown instanceof ForbiddenException) {
    throw new Error(`${what}: answered 403, which confirms the record exists`);
  }
  expect(thrown).toBeInstanceOf(NotFoundException);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    throw new Error('Refusing to run against a non-local database');
  }

  const suffix = `${Date.now()}`;
  const orgB = await prisma.organization.create({
    data: {
      legalNameAr: 'منشأة الجارة',
      legalNameEn: `Neighbour Tenant ${suffix}`,
      baseCurrency: 'SAR',
    },
  });
  B.organizationId = orgB.id;

  // Org B needs the same posting rules and sequences org A has, or its own
  // invoice could not be issued and there would be nothing to attack.
  const orgA = await prisma.organization.findFirst({
    where: { id: { not: orgB.id } },
    select: { id: true },
  });
  const mappings = await prisma.accountMapping.findMany({ where: { organizationId: orgA!.id } });
  const accounts = await prisma.account.findMany({ where: { organizationId: orgA!.id } });
  const accountIdByCode = new Map<string, string>();
  for (const a of accounts) {
    const copy = await prisma.account.create({
      data: {
        organizationId: orgB.id,
        code: a.code,
        nameAr: a.nameAr,
        nameEn: a.nameEn,
        accountType: a.accountType,
      },
    });
    accountIdByCode.set(a.code, copy.id);
  }
  for (const m of mappings) {
    const source = accounts.find((a) => a.id === m.accountId);
    if (!source) continue;
    await prisma.accountMapping.create({
      data: {
        organizationId: orgB.id,
        purpose: m.purpose,
        accountId: accountIdByCode.get(source.code)!,
      },
    });
  }
  const sequences = await prisma.numberingSequence.findMany({ where: { organizationId: orgA!.id } });
  await prisma.numberingSequence.createMany({
    data: sequences.map((s) => ({
      organizationId: orgB.id,
      documentType: s.documentType,
      prefix: s.prefix,
      fiscalYear: s.fiscalYear,
      nextValue: 1,
      padding: s.padding,
    })),
  });
  const taxCode = await prisma.taxCode.findFirstOrThrow({
    where: { organizationId: orgA!.id, taxType: 'VAT_STANDARD' },
  });
  await prisma.taxCode.create({
    data: {
      organizationId: orgB.id,
      code: taxCode.code,
      nameAr: taxCode.nameAr,
      nameEn: taxCode.nameEn,
      taxType: taxCode.taxType,
      rate: taxCode.rate,
    },
  });

  const role = await prisma.role.create({
    data: { organizationId: orgB.id, key: 'admin', nameAr: 'مدير', nameEn: 'Admin', permissions: [] },
  });
  const userB = await prisma.user.create({
    data: {
      organizationId: orgB.id,
      email: `owner-${suffix}@neighbour.test`,
      passwordHash: 'x',
      nameAr: 'مالك', nameEn: 'Owner',
      roleId: role.id,
    },
  });
  B.userId = userB.id;
  const USER_B = { userId: userB.id, organizationId: orgB.id } as unknown as AuthUser;

  const customerB = await customers.create(USER_B, {
    nameAr: 'عميل الجارة', nameEn: 'Neighbour Customer', customerType: 'CI',
  } as never);
  B.customerId = customerB.id;

  const contractB = await contracts.create(USER_B, {
    customerId: customerB.id,
    contractType: 'EPC',
    totalValue: 200_000,
    retentionPct: 5,
    milestones: [{ sequence: 1, descriptionAr: 'دفعة', descriptionEn: 'Stage', amount: 200_000 }],
  } as never);
  B.contractId = contractB.id;
  await contracts.activate(USER_B, contractB.id);

  const milestoneB = await prisma.contractMilestone.findFirstOrThrow({
    where: { contractId: contractB.id },
  });
  B.milestoneId = milestoneB.id;
  await contracts.verifyMilestone(USER_B, contractB.id, milestoneB.id);

  const invoiceB = await invoices.generateFromMilestone(USER_B, contractB.id, milestoneB.id);
  B.invoiceId = invoiceB.id;
  await invoices.issue(USER_B, invoiceB.id);

  B.retentionEntryId = (
    await prisma.retentionEntry.findFirstOrThrow({ where: { invoiceId: invoiceB.id } })
  ).id;
  B.journalEntryId = (
    await prisma.journalEntry.findFirstOrThrow({ where: { organizationId: orgB.id } })
  ).id;
  B.attachmentId = (
    await prisma.attachment.create({
      data: {
        organizationId: orgB.id,
        entityType: 'INVOICE',
        entityId: invoiceB.id,
        fileName: 'neighbour-secret.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        storageKey: `orgB/${suffix}.pdf`,
        uploadedById: userB.id,
      },
    })
  ).id;

  // The attacker: a legitimate user of org A, holding every permission.
  const attackerOrg = orgA!.id;
  const attacker = await prisma.user.findFirstOrThrow({ where: { organizationId: attackerOrg } });
  ATTACKER = {
    userId: attacker.id,
    organizationId: attackerOrg,
    permissions: ['*'],
  } as unknown as AuthUser;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a tenant cannot reach another tenant by id', () => {
  describe('reads', () => {
    it('cannot read the invoice', () => must404('invoice.get', () => invoices.get(ATTACKER, B.invoiceId)));
    it('cannot read the contract', () => must404('contract.get', () => contracts.get(ATTACKER, B.contractId)));
    it('cannot read the customer', () => must404('customer.get', () => customers.get(ATTACKER, B.customerId)));
    it('cannot download the attachment', () =>
      must404('attachment.download', () => attachments.download(ATTACKER, B.attachmentId)));
  });

  describe('writes', () => {
    it('cannot issue the invoice', () =>
      must404('invoice.issue', () => invoices.issue(ATTACKER, B.invoiceId)));
    it('cannot take a payment against it', () =>
      must404('invoice.addPayment', () =>
        invoices.addPayment(ATTACKER, B.invoiceId, { amount: 1 })));
    it('cannot credit it', () =>
      must404('invoice.createCreditNote', () =>
        invoices.createCreditNote(ATTACKER, B.invoiceId, { reason: 'not mine', amount: 1 })));
    it('cannot release its retention', () =>
      must404('invoice.releaseRetention', () =>
        invoices.releaseRetention(ATTACKER, B.retentionEntryId)));
    it('cannot activate the contract', () =>
      must404('contract.activate', () => contracts.activate(ATTACKER, B.contractId)));
    it('cannot verify its milestone', () =>
      must404('contract.verifyMilestone', () =>
        contracts.verifyMilestone(ATTACKER, B.contractId, B.milestoneId)));
    it('cannot invoice its milestone', () =>
      must404('invoice.generateFromMilestone', () =>
        invoices.generateFromMilestone(ATTACKER, B.contractId, B.milestoneId)));
    it('cannot edit the customer', () =>
      must404('customer.update', () =>
        customers.update(ATTACKER, B.customerId, { nameEn: 'Owned' } as never)));
    it('cannot delete the attachment', () =>
      must404('attachment.remove', () => attachments.remove(ATTACKER, B.attachmentId)));
  });

  describe('listings', () => {
    it('never lists the neighbour in its own results', async () => {
      const [invoiceRows, contractRows, customerRows] = await Promise.all([
        invoices.list(ATTACKER),
        contracts.list(ATTACKER),
        customers.list(ATTACKER),
      ]);
      expect(invoiceRows.map((r: { id: string }) => r.id)).not.toContain(B.invoiceId);
      expect(contractRows.map((r: { id: string }) => r.id)).not.toContain(B.contractId);
      expect(customerRows.map((r: { id: string }) => r.id)).not.toContain(B.customerId);
    });

    it('keeps the ledger apart', async () => {
      const entries = await prisma.journalEntry.findMany({
        where: { organizationId: ATTACKER.organizationId },
        select: { id: true },
      });
      expect(entries.map((e) => e.id)).not.toContain(B.journalEntryId);
    });
  });
});
