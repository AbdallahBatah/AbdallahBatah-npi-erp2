/**
 * Phase 2 — accounting reconciliation on a live system.
 *
 * Runs one full commercial cycle through the real services against a real
 * PostgreSQL, then asks the five questions an auditor asks. Nothing here
 * asserts that a function returned what it was told to return; every assertion
 * compares two independently-derived numbers — what a report claims against
 * what the ledger holds — because that is the only kind of check that can catch
 * a posting rule being wrong.
 *
 * The scenario is deliberately arithmetic-friendly so the expected figures can
 * be worked out on paper:
 *
 *   contract 1,000,000 · retention 5% · two milestones of 500,000
 *   milestone 1 invoiced   subtotal 500,000 · VAT 75,000 · total 575,000
 *                          retention 25,000 · net payable 550,000
 *   payment                200,000
 *   credit note (gross)     57,500  →  subtotal 50,000 · VAT 7,500
 *   purchase order          20,000  →  VAT 3,000 · total 23,000
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { NumberingService } from '../src/common/numbering.service';
import { AuditService } from '../src/common/audit.service';
import { PostingService } from '../src/common/posting.service';
import { TaxService } from '../src/common/tax.service';
import { NotificationService } from '../src/common/notification.service';
import { ApprovalService } from '../src/common/approval.service';
import { DelegationService } from '../src/common/delegation.service';
import { WorkflowEngine } from '../src/common/workflow/workflow.engine';
import { OutboxService } from '../src/common/workflow/outbox.service';
import { EventDispatcher } from '../src/common/workflow/event-dispatcher.service';
import { ZatcaService } from '../src/modules/finance/zatca.service';
import { InvoicesService } from '../src/modules/finance/invoices.service';
import { ReportsService } from '../src/modules/finance/reports.service';
import { ContractsService } from '../src/modules/commercial/contracts.service';
import { OpportunitiesService } from '../src/modules/crm/opportunities.service';
import { ProcurementService } from '../src/modules/procurement/procurement.service';
import { PayablesService } from '../src/modules/finance/payables.service';
import type { AuthUser } from '../src/common/auth-user';

const prisma = new PrismaService();
const numbering = new NumberingService(prisma);
const audit = new AuditService(prisma);
const posting = new PostingService(prisma);
const tax = new TaxService(prisma);
const notifications = new NotificationService(prisma);
const delegations = new DelegationService(prisma);
const approvals = new ApprovalService(prisma, audit, notifications, delegations);
const outbox = new OutboxService(prisma);
const engine = new WorkflowEngine(prisma, audit, outbox);
const events = new EventDispatcher(prisma);

const invoices = new InvoicesService(prisma, numbering, audit, posting, tax, new ZatcaService(), notifications);
const reports = new ReportsService(prisma, audit, posting);
const contracts = new ContractsService(prisma, numbering, audit, notifications, new OpportunitiesService(prisma, numbering, audit, outbox));
const procurement = new ProcurementService(prisma, numbering, audit, posting, tax, approvals, notifications, engine, events);
const payables = new PayablesService(prisma, numbering, audit, posting);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

let USER: AuthUser;
let organizationId: string;

/** Signed ledger balance (debit − credit) of one account, straight from the journal. */
async function ledgerBalance(accountId: string): Promise<number> {
  const agg = await prisma.journalLine.aggregate({
    where: { accountId, journalEntry: { organizationId } },
    _sum: { debit: true, credit: true },
  });
  return round2(Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0));
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    throw new Error('Refusing to run against a non-local database');
  }
  const org = await prisma.organization.findFirst({ select: { id: true } });
  if (!org) throw new Error('No organization — run npm run db:seed');
  organizationId = org.id;
  // The M4 workflow engine checks the caller's live permissions itself, so the
  // test user must carry the real permission set of its role, not a bare id.
  const user = await prisma.user.findFirst({
    where: { organizationId },
    select: { id: true, role: { select: { permissions: true } } },
  });
  USER = {
    userId: user!.id,
    organizationId,
    permissions: user!.role?.permissions ?? [],
  } as unknown as AuthUser;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a full cycle, then the five reconciliations', () => {
  // Carried between the ordered steps below.
  const state = {
    contractId: '',
    milestoneId: '',
    invoiceId: '',
    creditedRetention: 0,
  };

  it('runs customer → contract → milestone → invoice → payment → credit note', async () => {
    const customer = await prisma.customer.create({
      data: {
        organizationId,
        code: `CUS-IT-${Date.now()}`,
        nameAr: 'عميل سيناريو المطابقة',
        nameEn: 'Reconciliation Scenario Customer',
        customerType: 'CI',
        creditTermsDays: 30,
      },
    });

    const contract = await contracts.create(USER, {
      customerId: customer.id,
      contractType: 'EPC',
      totalValue: 1_000_000,
      retentionPct: 5,
      milestones: [
        { sequence: 1, descriptionAr: 'التوريد', descriptionEn: 'Supply', amount: 500_000 },
        { sequence: 2, descriptionAr: 'التركيب', descriptionEn: 'Installation', amount: 500_000 },
      ],
    } as never);
    await contracts.activate(USER, contract.id);
    state.contractId = contract.id;

    const milestones = await prisma.contractMilestone.findMany({
      where: { contractId: contract.id },
      orderBy: { sequence: 'asc' },
    });
    state.milestoneId = milestones[0].id;
    await contracts.verifyMilestone(USER, contract.id, state.milestoneId);

    const draft = await invoices.generateFromMilestone(USER, contract.id, state.milestoneId);
    state.invoiceId = draft.id;

    // The paper figures, asserted before anything downstream depends on them.
    expect(Number(draft.subtotal)).toBe(500_000);
    expect(Number(draft.vatAmount)).toBe(75_000);
    expect(Number(draft.total)).toBe(575_000);
    expect(Number(draft.retentionAmount)).toBe(25_000);
    expect(Number(draft.netPayable)).toBe(550_000);

    await invoices.issue(USER, draft.id);
    await invoices.addPayment(USER, draft.id, { amount: 200_000, method: 'BANK_TRANSFER' });
    await invoices.createCreditNote(USER, draft.id, { reason: 'Scope reduction', amount: 57_500 });

    // The credit note splits between AR and retention in the invoice's own
    // proportion: 57,500 × 25,000 / 575,000.
    state.creditedRetention = round2((57_500 * 25_000) / 575_000);
    expect(state.creditedRetention).toBe(2_500);

    const after = await invoices.get(USER, draft.id);
    // 550,000 due − 200,000 received − 55,000 of credit that hit AR.
    expect(Number(after.outstanding)).toBe(295_000);
  });

  it('runs purchase order → receipt → vendor bill → vendor payment', async () => {
    const vendor = await prisma.vendor.findFirst({ where: { organizationId }, select: { id: true } });
    const item = await prisma.item.findFirst({
      where: { organizationId, isSerialised: false },
      select: { id: true },
    });

    const po = await procurement.createPo(USER, {
      vendorId: vendor!.id,
      lines: [{ itemId: item!.id, qty: 1_000, unitPrice: 20 }],
    } as never);
    // 23,000 total sits under the 100,000 approval threshold, so this clears
    // in one step rather than entering the matrix.
    await procurement.approvePo(USER, po.id);
    // M4: goods may only be received against an order the vendor was told about.
    await procurement.sendPo(USER, po.id);

    const poLines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
    const grn = await procurement.receive(USER, po.id, {
      lines: [{ poLineId: poLines[0].id, qty: 1_000 }],
    } as never);

    // M4: a bill can only be raised against an inspected-and-accepted receipt.
    await procurement.inspectGrn(USER, grn!.id);
    await procurement.acceptGrn(USER, grn!.id);

    const bill = await procurement.createBill(USER, { goodsReceiptId: grn!.id } as never);
    expect(Number(bill.subtotal)).toBe(20_000);
    expect(Number(bill.total)).toBe(23_000);

    // M4: the journal entry now follows approval, not registration, so the
    // bill must pass the three-way match and be approved before it can be paid.
    await procurement.matchBill(USER, bill.id);
    await procurement.approveBill(USER, bill.id);

    await payables.pay(USER, {
      vendorId: vendor!.id,
      allocations: [{ kind: 'BILL', documentId: bill.id, amount: 23_000 }],
    } as never);
  });

  // ── The five reconciliations ────────────────────────────────────────────

  it('1. the trial balance balances to the halala', async () => {
    const tb = await reports.trialBalance(USER, '2000-01-01', '2100-12-31');
    expect(tb.isBalanced).toBe(true);

    // Independently of the report: every journal line ever written.
    const agg = await prisma.journalLine.aggregate({
      where: { journalEntry: { organizationId } },
      _sum: { debit: true, credit: true },
    });
    expect(round2(Number(agg._sum.debit))).toBe(round2(Number(agg._sum.credit)));
  });

  it('2. receivables in the finance summary equal the AR account in the ledger', async () => {
    const acc = await posting.accounts(organizationId, ['AR'] as const);
    const summary = await invoices.summary(USER);
    expect(round2(Number(summary.accountsReceivable))).toBe(await ledgerBalance(acc.AR));
  });

  it('3. output VAT in the return equals the VAT payable account', async () => {
    const acc = await posting.accounts(organizationId, ['VAT_OUTPUT'] as const);
    const vat = await reports.vatReturn(USER, '2000-01-01', '2100-12-31');
    // The VAT account is a liability: credit-heavy, so its signed balance is
    // negative where the return states a positive amount owed.
    expect(vat.boxes.outputVat).toBe(round2(-(await ledgerBalance(acc.VAT_OUTPUT))));
  });

  it('4. percentage-of-completion revenue matches the IFRS-15 figure worked by hand', async () => {
    const row = (await reports.poc(USER)).find((r) => r.contractId === state.contractId);
    expect(row).toBeDefined();

    // By hand: progress is certified milestone value over total milestone
    // value — one of two 500,000 milestones is INVOICED, so 50%. Recognised
    // revenue is contract value × progress = 1,000,000 × 0.5.
    const milestones = await prisma.contractMilestone.findMany({ where: { contractId: state.contractId } });
    const certified = milestones
      .filter((m) => ['VERIFIED', 'INVOICED'].includes(m.status))
      .reduce((s, m) => s + Number(m.amount), 0);
    const total = milestones.reduce((s, m) => s + Number(m.amount), 0);
    const byHand = round2(1_000_000 * (certified / total));

    expect(byHand).toBe(500_000);
    expect(round2(Number(row!.recognizedRevenue))).toBe(byHand);
  });

  it('5. retention on the balance sheet equals the unreleased retention entries', async () => {
    const acc = await posting.accounts(organizationId, ['RETENTION_RECEIVABLE'] as const);
    const entries = await prisma.retentionEntry.aggregate({
      where: { organizationId, status: 'WITHHELD' },
      _sum: { withheldAmount: true, creditedAmount: true },
    });
    // Net of credit notes: what is still withheld, which is what the ledger
    // holds. Comparing the gross figure was what exposed the defect.
    const held = round2(
      Number(entries._sum.withheldAmount ?? 0) - Number(entries._sum.creditedAmount ?? 0),
    );
    expect(await ledgerBalance(acc.RETENTION_RECEIVABLE)).toBe(held);
  });
});
