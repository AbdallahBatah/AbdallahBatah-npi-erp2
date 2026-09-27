/**
 * Phase 1 — transaction integrity under concurrency, against a real PostgreSQL.
 *
 * Everything else in this repository tests behaviour against in-memory doubles.
 * The three properties below cannot be tested that way at all, because they are
 * properties of the *database*, not of the code: whether two overlapping
 * transactions can take the same sequence number, whether they can both chain
 * onto the same ZATCA predecessor hash, and whether a failed issue leaves a
 * fragment behind. A fake `$transaction` that just runs the callback proves
 * none of it.
 *
 * Not part of `npm test` — see jest.integration.config.js.
 */
import { InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { NumberingService } from '../src/common/numbering.service';
import { AuditService } from '../src/common/audit.service';
import { PostingService } from '../src/common/posting.service';
import { TaxService } from '../src/common/tax.service';
import { NotificationService } from '../src/common/notification.service';
import { ZatcaService } from '../src/modules/finance/zatca.service';
import { InvoicesService } from '../src/modules/finance/invoices.service';
import type { AuthUser } from '../src/common/auth-user';

const prisma = new PrismaService();
const invoices = new InvoicesService(
  prisma,
  new NumberingService(prisma),
  new AuditService(prisma),
  new PostingService(prisma),
  new TaxService(prisma),
  new ZatcaService(),
  new NotificationService(prisma),
);

let USER: AuthUser;
let organizationId: string;
let customerId: string;

/**
 * This suite writes, and one case corrupts state on purpose. It must never be
 * pointed at anything but a local throwaway database.
 */
function assertDisposableDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set — start the stack first (docker compose up -d postgres)');
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) {
    throw new Error(
      `Refusing to run destructive integration tests against host "${host}". ` +
        'Point DATABASE_URL at a local throwaway database.',
    );
  }
}

/** A contract with `count` verified milestones, ready to be invoiced. */
async function makeContract(count: number, amount: number) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const contract = await prisma.contract.create({
    data: {
      organizationId,
      code: `ITEST-${suffix}`,
      customerId,
      status: 'ACTIVE',
      currency: 'SAR',
      totalValue: amount * count,
      retentionPct: 5,
      milestones: {
        create: Array.from({ length: count }, (_, i) => ({
          sequence: i + 1,
          descriptionAr: `دفعة اختبار ${i + 1}`,
          descriptionEn: `Test milestone ${i + 1}`,
          amount,
          status: 'VERIFIED' as const,
          verifiedAt: new Date(),
        })),
      },
    },
    include: { milestones: { orderBy: { sequence: 'asc' } } },
  });
  return contract;
}

/**
 * Walks the organization's whole e-invoice chain and returns what is wrong with
 * it. An empty array means the chain is intact.
 *
 * This is the check the codebase does not have anywhere: nothing in the
 * application can currently answer "is the PIH chain unbroken?", which is the
 * first question ZATCA would ask of it.
 */
async function chainDefects(): Promise<string[]> {
  const docs = await prisma.eInvoiceDocument.findMany({
    where: { invoice: { organizationId } },
    orderBy: { submittedAt: 'asc' },
    select: { id: true, invoiceHash: true, previousInvoiceHash: true, invoice: { select: { code: true } } },
  });
  const defects: string[] = [];
  const genesis = ZatcaService.GENESIS_PIH;

  const roots = docs.filter((d) => d.previousInvoiceHash === genesis);
  if (docs.length > 0 && roots.length !== 1) {
    defects.push(`expected exactly one genesis document, found ${roots.length}`);
  }

  // A fork is two documents claiming the same predecessor: the fatal one, and
  // exactly what two concurrent issues would produce without serialization.
  const byPredecessor = new Map<string, string[]>();
  for (const d of docs) {
    byPredecessor.set(d.previousInvoiceHash, [
      ...(byPredecessor.get(d.previousInvoiceHash) ?? []),
      d.invoice.code,
    ]);
  }
  for (const [pih, codes] of byPredecessor) {
    if (codes.length > 1) {
      defects.push(`fork: ${codes.join(' and ')} both chain onto ${pih.slice(0, 12)}…`);
    }
  }

  // Every non-genesis predecessor must actually exist.
  const hashes = new Set(docs.map((d) => d.invoiceHash));
  for (const d of docs) {
    if (d.previousInvoiceHash !== genesis && !hashes.has(d.previousInvoiceHash)) {
      defects.push(`${d.invoice.code} chains onto a hash no document carries`);
    }
  }
  return defects;
}

beforeAll(async () => {
  assertDisposableDatabase();
  const org = await prisma.organization.findFirst({ select: { id: true } });
  if (!org) throw new Error('No organization found — run the seed first (npm run db:seed)');
  organizationId = org.id;

  const customer = await prisma.customer.findFirst({ where: { organizationId }, select: { id: true } });
  if (!customer) throw new Error('No customer found — run the seed first');
  customerId = customer.id;

  const user = await prisma.user.findFirst({ where: { organizationId }, select: { id: true } });
  USER = { userId: user?.id ?? 'integration-test', organizationId } as unknown as AuthUser;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('concurrent invoice issuing', () => {
  it('gives two simultaneous issues distinct numbers and an unforked hash chain', async () => {
    const contract = await makeContract(2, 100_000);
    const [a, b] = await Promise.all(
      contract.milestones.map((m) => invoices.generateFromMilestone(USER, contract.id, m.id)),
    );

    // The moment of truth: both issues in flight at once, each reading the
    // chain head and appending to it.
    const results = await Promise.allSettled([
      invoices.issue(USER, a.id),
      invoices.issue(USER, b.id),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    // A serialization abort is a legitimate outcome — Postgres refusing to let
    // the chain fork is the protection working. What must never happen is a
    // fork. Report the abort so the run is honest about which path it took.
    if (rejected.length > 0) {
      console.warn(
        `${rejected.length} of 2 concurrent issues were rejected: ` +
          rejected.map((r) => (r.reason as Error)?.message).join(' | '),
      );
    }

    expect(await chainDefects()).toEqual([]);

    const issued = await prisma.invoice.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { code: true, status: true, eInvoice: { select: { id: true } } },
    });
    const codes = issued.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length); // no duplicate numbers

    // Every invoice that reached CLEARED has exactly one e-invoice document,
    // and every one that did not has none.
    for (const inv of issued) {
      if (inv.status === 'CLEARED') expect(inv.eInvoice).not.toBeNull();
      else expect(inv.eInvoice).toBeNull();
    }
  });

  it('never issues the same number twice under parallel document creation', async () => {
    const contract = await makeContract(8, 10_000);
    const before = await prisma.numberingSequence.findFirst({
      where: { organizationId, documentType: 'INVOICE' },
      select: { nextValue: true },
    });

    const created = await Promise.all(
      contract.milestones.map((m) => invoices.generateFromMilestone(USER, contract.id, m.id)),
    );

    const codes = created.map((c) => c.code);
    expect(new Set(codes).size).toBe(8); // no two milestones took the same number

    const after = await prisma.numberingSequence.findFirst({
      where: { organizationId, documentType: 'INVOICE' },
      select: { nextValue: true },
    });
    // Gapless: the counter advanced by exactly the number of documents issued.
    expect(after!.nextValue - before!.nextValue).toBe(8);
  });

  it('leaves nothing behind when an issue fails', async () => {
    const contract = await makeContract(1, 50_000);
    const [draft] = await Promise.all(
      contract.milestones.map((m) => invoices.generateFromMilestone(USER, contract.id, m.id)),
    );

    // The same invoice issued twice at once: one must lose.
    const results = await Promise.allSettled([
      invoices.issue(USER, draft.id),
      invoices.issue(USER, draft.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);

    // Whatever happened, the invoice must not carry two of anything.
    const docs = await prisma.eInvoiceDocument.count({ where: { invoiceId: draft.id } });
    expect(docs).toBeLessThanOrEqual(1);

    const journals = await prisma.journalEntry.count({
      where: { invoiceId: draft.id, sourceType: 'Invoice' },
    });
    expect(journals).toBeLessThanOrEqual(1);

    const retentions = await prisma.retentionEntry.count({ where: { invoiceId: draft.id } });
    expect(retentions).toBeLessThanOrEqual(1);

    expect(await chainDefects()).toEqual([]);
  });
});

describe('numbering across a fiscal-year boundary', () => {
  const numbering = new NumberingService(prisma);
  const currentYear = new Date().getUTCFullYear();
  const createdTypes: string[] = [];

  /** A throwaway documentType unique to this run, tracked for teardown. */
  function freshType(label: string) {
    const type = `ITEST_ROLLOVER_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    createdTypes.push(type);
    return type;
  }

  afterEach(async () => {
    if (createdTypes.length === 0) return;
    await prisma.numberingSequence.deleteMany({
      where: { organizationId, documentType: { in: createdTypes } },
    });
    createdTypes.length = 0;
  });

  it('carries the previous year forward instead of restarting, under parallel default-isolation callers', async () => {
    const type = freshType('parallel');
    await prisma.numberingSequence.create({
      data: {
        organizationId,
        documentType: type,
        prefix: 'ITR',
        padding: 5,
        nextValue: 42,
        fiscalYear: currentYear - 1,
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        prisma.$transaction((tx) => numbering.next(organizationId, type, tx)),
      ),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (rejected.length > 0) {
      console.warn(
        `${rejected.length} of 8 rollover calls were rejected: ` +
          rejected.map((r) => (r.reason as Error)?.message).join(' | '),
      );
    }

    expect(fulfilled.length).toBe(8);
    const codes = fulfilled.map((r) => r.value).sort();
    const expected = Array.from({ length: 8 }, (_, i) => `ITR-${String(42 + i).padStart(5, '0')}`);
    expect(codes).toEqual(expected);

    const currentRow = await prisma.numberingSequence.findUniqueOrThrow({
      where: {
        organizationId_documentType_fiscalYear: {
          organizationId,
          documentType: type,
          fiscalYear: currentYear,
        },
      },
    });
    expect(currentRow.nextValue).toBe(50);

    const previousRow = await prisma.numberingSequence.findUniqueOrThrow({
      where: {
        organizationId_documentType_fiscalYear: {
          organizationId,
          documentType: type,
          fiscalYear: currentYear - 1,
        },
      },
    });
    // History untouched: the carried-forward row is never mutated.
    expect(previousRow.nextValue).toBe(42);
  });

  it('rejects cleanly when no earlier year exists to carry forward, and creates no row', async () => {
    const type = freshType('no-history');

    await expect(
      prisma.$transaction((tx) => numbering.next(organizationId, type, tx)),
    ).rejects.toThrow(InternalServerErrorException);

    const rows = await prisma.numberingSequence.findMany({
      where: { organizationId, documentType: type },
    });
    expect(rows).toEqual([]);
  });

  it('never issues a duplicate or out-of-order number under Serializable callers', async () => {
    const type = freshType('serializable');
    await prisma.numberingSequence.create({
      data: {
        organizationId,
        documentType: type,
        prefix: 'ITS',
        padding: 5,
        nextValue: 200,
        fiscalYear: currentYear - 1,
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        prisma.serializable((tx) => numbering.next(organizationId, type, tx)),
      ),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (rejected.length > 0) {
      console.warn(
        `${rejected.length} of 4 serializable rollover calls were rejected: ` +
          rejected
            .map((r) => {
              const err = r.reason as { constructor?: { name?: string }; code?: unknown; message?: string };
              return `${err?.constructor?.name ?? typeof err}${err?.code ? ` (code ${err.code})` : ''}: ${err?.message}`;
            })
            .join(' | '),
      );
    }

    const codes = fulfilled.map((r) => r.value);
    expect(new Set(codes).size).toBe(codes.length); // no duplicates among the fulfilled

    const sortedValues = codes.map((c) => Number(c.split('-')[1])).sort((a, b) => a - b);
    const expectedValues = Array.from({ length: sortedValues.length }, (_, i) => 200 + i);
    expect(sortedValues).toEqual(expectedValues); // consecutive, starting at the carried value

    const currentRow = await prisma.numberingSequence.findUniqueOrThrow({
      where: {
        organizationId_documentType_fiscalYear: {
          organizationId,
          documentType: type,
          fiscalYear: currentYear,
        },
      },
    });
    expect(currentRow.nextValue).toBe(200 + fulfilled.length);
  });
});
