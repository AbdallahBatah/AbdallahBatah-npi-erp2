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
import { OrgSettingsService } from '../src/common/org-settings.service';
import { PostingService } from '../src/common/posting.service';
import { TaxService } from '../src/common/tax.service';
import { NotificationService } from '../src/common/notification.service';
import { ZatcaService } from '../src/modules/finance/zatca.service';
import { InvoicesService } from '../src/modules/finance/invoices.service';
import { ContractsService } from '../src/modules/commercial/contracts.service';
import { OutboxService } from '../src/common/workflow/outbox.service';
import { CustomersService } from '../src/modules/crm/customers.service';
import { OpportunitiesService } from '../src/modules/crm/opportunities.service';
import { LossReasonsService } from '../src/modules/crm/loss-reasons.service';
import { CustomerContactsService } from '../src/modules/crm/customer-contacts.service';
import { ActivitiesService } from '../src/modules/crm/activities.service';
import { FollowUpTasksService } from '../src/modules/crm/follow-up-tasks.service';
import { AttachmentsService } from '../src/modules/platform/attachments.service';
import type { AuthUser } from '../src/common/auth-user';
import { buildProposalStack } from './support/proposal-stack';

const prisma = new PrismaService();
const numbering = new NumberingService(prisma);
const audit = new AuditService(prisma);
const posting = new PostingService(prisma);
const notifications = new NotificationService(prisma);

const invoices = new InvoicesService(
  prisma, numbering, audit, posting, new TaxService(prisma), new ZatcaService(), notifications,
);
const opportunities = new OpportunitiesService(prisma, numbering, audit, new OutboxService(prisma));
const lossReasons = new LossReasonsService(prisma, audit);
const contracts = new ContractsService(prisma, numbering, audit, notifications, opportunities);
const customers = new CustomersService(prisma, numbering, audit, new OrgSettingsService(prisma, audit));
const customerContacts = new CustomerContactsService(prisma, audit);
const attachments = new AttachmentsService(prisma, audit);
// CRM Step 5: the communication log and the follow-up tasks.
const followUpTasks = new FollowUpTasksService(prisma, numbering, audit, notifications, new OrgSettingsService(prisma, audit));
const activities = new ActivitiesService(prisma, audit, followUpTasks);
// CRM Step 4: the proposal service with the real kernel behind it.
const proposals = buildProposalStack(prisma).proposals;

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
  opportunityId: '',
  lossReasonId: '',
  itemId: '',
  proposalId: '',
  revisionId: '',
  contactId: '',
  activityId: '',
  taskId: '',
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
  // `permissions` must exist since Step 1: contracts.get() reads it (canViewCosts).
  const USER_B = { userId: userB.id, organizationId: orgB.id, permissions: [] } as unknown as AuthUser;

  const customerB = await customers.create(USER_B, {
    nameAr: 'عميل الجارة', nameEn: 'Neighbour Customer', customerType: 'CI',
    // Step 2: a new company must carry a CR or VAT number.
    crNumber: `7${suffix}`.slice(0, 10),
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

  // CRM Step 3: org B owns an opportunity and a loss reason of its own.
  B.opportunityId = (await opportunities.create(USER_B, { name: 'فرصة الجارة', customerId: customerB.id } as never)).id;
  B.lossReasonId = (
    await lossReasons.create(
      { ...USER_B, permissions: ['admin.org.manage'] } as AuthUser,
      { nameAr: 'سبب الجارة', nameEn: 'Neighbour reason' },
    )
  ).id;

  // CRM Step 4: org B owns an item and a SENT proposal with one revision (written directly: org B has no workflow flow).
  const itemB = await prisma.item.create({
    data: { organizationId: orgB.id, sku: `B-${suffix}`, nameAr: 'صنف الجارة', nameEn: 'Neighbour item', itemCategory: 'MODULE', unitCost: 10 },
  });
  B.itemId = itemB.id;
  const proposalB = await prisma.proposal.create({
    data: { organizationId: orgB.id, code: `PRP-B-${suffix}`, opportunityId: B.opportunityId, status: 'SENT' },
  });
  B.proposalId = proposalB.id;
  B.revisionId = (
    await prisma.proposalRevision.create({
      data: { proposalId: proposalB.id, revisionNo: 1, status: 'SENT', totalAmount: 1000, validUntil: new Date('2099-01-01T00:00:00Z') },
    })
  ).id;

  // CRM Step 5: org B owns a contact, a log entry and an open follow-up task (written directly: no sequence is needed).
  B.contactId = (await prisma.customerContact.create({ data: { organizationId: orgB.id, customerId: customerB.id, name: 'جهة اتصال الجارة' } })).id;
  B.activityId = (
    await prisma.activity.create({
      data: { organizationId: orgB.id, customerId: customerB.id, activityType: 'CALL', occurredAt: new Date(), body: 'مكالمة سرية للجارة', createdById: userB.id },
    })
  ).id;
  B.taskId = (
    await prisma.followUpTask.create({
      data: {
        organizationId: orgB.id, code: `TSK-B-${suffix}`, customerId: customerB.id, title: 'مهمة سرية للجارة',
        dueAt: new Date('2020-01-01T00:00:00Z'), assigneeId: userB.id, createdById: userB.id,
      },
    })
  ).id;

  // The attacker: a legitimate user of org A, holding every permission.
  const attackerOrg = orgA!.id;
  const attacker = await prisma.user.findFirstOrThrow({ where: { organizationId: attackerOrg } });
  ATTACKER = {
    userId: attacker.id,
    organizationId: attackerOrg,
    permissions: ['*', 'admin.org.manage', 'crm.opportunity.read', 'crm.opportunity.write'],
  } as unknown as AuthUser;
});

afterAll(async () => {
  // CRM Step 5: the neighbour's task and log entry were written by hand; take them out again
  // so a later rollback of the activity migration is not blocked by test data.
  await prisma.followUpTask.deleteMany({ where: { id: B.taskId || '-' } });
  await prisma.activity.deleteMany({ where: { id: B.activityId || '-' } });
  await prisma.$disconnect();
});

describe('a tenant cannot reach another tenant by id', () => {
  describe('CRM Step 4 — proposals', () => {
    const ATTACKER_COSTS = () => ({ ...ATTACKER, permissions: [...ATTACKER.permissions, 'finance.costs.view', 'commercial.proposal.write', 'commercial.proposal.read'] }) as AuthUser;
    const line = () => ({ itemId: B.itemId, qty: 1, unitPrice: 1 });

    it('cost-lookup for the neighbour’s item returns nothing — not its cost, not even that it exists', async () => {
      await expect(proposals.costLookup(ATTACKER_COSTS(), { itemIds: [B.itemId], currency: 'SAR' })).resolves.toEqual([]);
    });
    it('cannot read the proposal', () => must404('proposal.get', () => proposals.get(ATTACKER, B.proposalId)));
    it('cannot raise it for approval', () => must404('proposal.submit', () => proposals.submit(ATTACKER_COSTS(), B.proposalId)));
    it('cannot send it to the customer', () => must404('proposal.send', () => proposals.send(ATTACKER_COSTS(), B.proposalId)));
    it('cannot record the customer’s refusal', () =>
      must404('proposal.rejectByCustomer', () => proposals.rejectByCustomer(ATTACKER_COSTS(), B.proposalId, { reason: 'x' })));
    it('cannot accept its revision', () =>
      must404('proposal.acceptRevision', () => proposals.acceptRevision(ATTACKER_COSTS(), B.proposalId, B.revisionId)));
    it('cannot add or edit a revision', async () => {
      await must404('proposal.addRevision', () => proposals.addRevision(ATTACKER_COSTS(), B.proposalId, { validUntil: '2099-01-01', bomLines: [line()] }));
      await must404('proposal.updateRevision', () =>
        proposals.updateRevision(ATTACKER_COSTS(), B.proposalId, B.revisionId, { validUntil: '2099-01-01', bomLines: [line()] }));
    });
    it('never lists the neighbour’s proposal', async () => {
      const rows = await proposals.list(ATTACKER);
      expect(rows.map((r: { id: string }) => r.id)).not.toContain(B.proposalId);
    });
    it('expireBySystem for another organization’s proposal does nothing', async () => {
      await expect(proposals.expireBySystem(ATTACKER.organizationId, B.proposalId)).resolves.toBe(false);
      expect((await prisma.proposalRevision.findUniqueOrThrow({ where: { id: B.revisionId } })).status).toBe('SENT');
    });
  });

  describe('CRM Step 5 — the communication log and the follow-up tasks', () => {
    const ATTACKER_CRM = () => ({ ...ATTACKER, permissions: [...ATTACKER.permissions, 'crm.customer.read', 'crm.customer.write'] }) as AuthUser;
    const dueTomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    it('lists nothing of the neighbour’s log, by customer or by opportunity', async () => {
      const byCustomer = (await activities.list(ATTACKER_CRM(), { customerId: B.customerId })) as { items: unknown[] };
      expect(byCustomer.items).toEqual([]);
      const byOpportunity = (await activities.list(ATTACKER_CRM(), { opportunityId: B.opportunityId })) as { items: unknown[] };
      expect(byOpportunity.items).toEqual([]);
    });
    it('never lists the neighbour’s tasks, not even for all customers and all statuses', async () => {
      const rows = (await followUpTasks.list(ATTACKER_CRM(), { status: 'ALL' })) as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).not.toContain(B.taskId);
      expect(await followUpTasks.list(ATTACKER_CRM(), { customerId: B.customerId, status: 'ALL' })).toEqual([]);
    });
    it('cannot read the task', () => must404('followUpTask.get', () => followUpTasks.get(ATTACKER_CRM(), B.taskId)));
    it('cannot complete, cancel, edit or re-assign the task (404, and it stays open)', async () => {
      await must404('followUpTask.complete', () => followUpTasks.complete(ATTACKER_CRM(), B.taskId));
      await must404('followUpTask.cancel', () => followUpTasks.cancel(ATTACKER_CRM(), B.taskId, 'x'));
      await must404('followUpTask.update', () => followUpTasks.update(ATTACKER_CRM(), B.taskId, { title: 'Owned' }));
      await must404('followUpTask.reassign', () => followUpTasks.update(ATTACKER_CRM(), B.taskId, { assigneeId: ATTACKER.userId }));
      const after = await prisma.followUpTask.findUniqueOrThrow({ where: { id: B.taskId } });
      expect(after.status).toBe('OPEN');
      expect(after.title).toBe('مهمة سرية للجارة');
    });
    it('cannot edit the entry', () => must404('activity.update', () => activities.update(ATTACKER_CRM(), B.activityId, { body: 'Owned' })));
    it('cannot write an entry or a task against the neighbour’s customer, opportunity or contact', async () => {
      await must404('activity.create(customer)', () =>
        activities.create(ATTACKER_CRM(), { customerId: B.customerId, activityType: 'NOTE', body: 'x' }));
      await must404('followUpTask.create(customer)', () =>
        followUpTasks.create(ATTACKER_CRM(), { customerId: B.customerId, title: 'x', dueAt: dueTomorrow() }));
      const mine = await prisma.customer.findFirstOrThrow({ where: { organizationId: ATTACKER.organizationId, mergedIntoId: null } });
      await must404('activity.create(foreign opportunity)', () =>
        activities.create(ATTACKER_CRM(), { customerId: mine.id, opportunityId: B.opportunityId, activityType: 'NOTE', body: 'x' }));
      // a contact of another tenant is "not this customer's" — 400, not a hint that it exists elsewhere
      await expect(
        activities.create(ATTACKER_CRM(), { customerId: mine.id, contactId: B.contactId, activityType: 'NOTE', body: 'x' }),
      ).rejects.toThrow('Contact does not belong to this customer');
    });
    it('cannot give the neighbour’s user a task of its own organization', async () => {
      const mine = await prisma.customer.findFirstOrThrow({ where: { organizationId: ATTACKER.organizationId, mergedIntoId: null } });
      await expect(
        followUpTasks.create(ATTACKER_CRM(), { customerId: mine.id, title: 'x', dueAt: dueTomorrow(), assigneeId: B.userId }),
      ).rejects.toThrow('Assignee not found');
    });
    it('the assignee list of the attacker’s organization does not contain the neighbour’s user', async () => {
      const rows = (await followUpTasks.assignees(ATTACKER_CRM())) as Array<{ id: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.id)).not.toContain(B.userId);
    });
    it('the dashboard summary never counts the neighbour’s tasks', async () => {
      // the neighbour's task is open and long overdue: it counts for its own assignee ...
      const own = await followUpTasks.mySummary({ userId: B.userId, organizationId: B.organizationId, permissions: ['crm.task.read'] } as unknown as AuthUser);
      expect(own.overdue).toBe(1);
      // ... and not for anyone asking inside the attacker's organization, even with the neighbour's user id
      const crossed = await followUpTasks.mySummary({ userId: B.userId, organizationId: ATTACKER.organizationId, permissions: ['crm.task.read'] } as unknown as AuthUser);
      expect(crossed).toEqual({ dueToday: 0, overdue: 0 });
    });
    it('cannot attach a file to the neighbour’s log entry (404 from the entity check)', async () => {
      const files = { buffer: Buffer.from('x'), size: 1, originalname: 'a.pdf', mimetype: 'application/pdf' } as Express.Multer.File;
      await must404('attachment.upload(ACTIVITY)', () => attachments.upload(ATTACKER_CRM(), 'ACTIVITY', B.activityId, files));
    });
  });

  describe('reads', () => {
    it('cannot read the invoice', () => must404('invoice.get', () => invoices.get(ATTACKER, B.invoiceId)));
    it('cannot read the contract', () => must404('contract.get', () => contracts.get(ATTACKER, B.contractId)));
    it('cannot read the customer', () => must404('customer.get', () => customers.get(ATTACKER, B.customerId)));
    it('cannot open the customer overview page', () =>
      must404('customer.overview', () => customers.overview(ATTACKER, B.customerId)));
    it('cannot list the customer contacts', () =>
      must404('customerContacts.list', () => customerContacts.list(ATTACKER, B.customerId)));
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

    // CRM Step 3 — the funnel and the loss-reason list.
    it('cannot read the opportunity', () =>
      must404('opportunity.get', () => opportunities.get(ATTACKER, B.opportunityId)));
    it('cannot move the opportunity through its stages', () =>
      must404('opportunity.changeStage', () =>
        opportunities.changeStage(ATTACKER, B.opportunityId, { stage: 'QUALIFICATION' })));
    it('cannot edit the opportunity', () =>
      must404('opportunity.update', () => opportunities.update(ATTACKER, B.opportunityId, { name: 'Owned' })));
    it('cannot edit or switch off the loss reason', () =>
      must404('lossReasons.update', () => lossReasons.update(ATTACKER, B.lossReasonId, { isActive: false })));
    it('cannot lose its OWN opportunity for a loss reason of another tenant (404, and nothing changes)', async () => {
      const customerA = await prisma.customer.findFirstOrThrow({ where: { organizationId: ATTACKER.organizationId } });
      const mine = await opportunities.create(ATTACKER, { name: 'فرصة المهاجم', customerId: customerA.id } as never);
      await must404('opportunity.changeStage(foreign loss reason)', () =>
        opportunities.changeStage(ATTACKER, mine.id, { stage: 'LOST', lossReasonId: B.lossReasonId }));
      expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: mine.id } })).stage).toBe('PROSPECTING');
    });
    it('cannot attach a file to the opportunity (404 from the entity check)', async () => {
      const files = { buffer: Buffer.from('x'), size: 1, originalname: 'a.pdf', mimetype: 'application/pdf' } as Express.Multer.File;
      await must404('attachment.upload(OPPORTUNITY)', () =>
        attachments.upload(ATTACKER, 'OPPORTUNITY', B.opportunityId, files));
    });
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

    it('similar-name search never reveals a neighbour customer, even for its exact name', async () => {
      const hits = await customers.similar(ATTACKER, 'عميل الجارة');
      expect(hits.map((h: { id: string }) => h.id)).not.toContain(B.customerId);
      // ...and only ever returns rows of the attacker's own organization.
      const own = await prisma.customer.findMany({
        where: { organizationId: ATTACKER.organizationId },
        select: { id: true },
      });
      const ownIds = new Set(own.map((c) => c.id));
      for (const h of hits as Array<{ id: string }>) expect(ownIds.has(h.id)).toBe(true);
    });

    it('never lists the neighbour opportunity or loss reason, not even to an administrator asking for all', async () => {
      const [opps, reasons] = await Promise.all([
        opportunities.list(ATTACKER, {}),
        lossReasons.list(ATTACKER, true),
      ]);
      expect(opps.map((r: { id: string }) => r.id)).not.toContain(B.opportunityId);
      expect(reasons.map((r: { id: string }) => r.id)).not.toContain(B.lossReasonId);
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
