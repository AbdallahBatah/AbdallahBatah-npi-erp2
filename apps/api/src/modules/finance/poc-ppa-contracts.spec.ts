import { NotFoundException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import type { AuthUser } from '../../common/auth-user';
import type { JournalInput } from '../../common/posting.service';

/**
 * P1-1b: the IFRS-15 percentage-of-completion report is for milestone contracts.
 *
 * A PPA (energy-sale) contract is created ACTIVE with `totalValue` 0 and no
 * milestones, and its revenue is recognised as billed, by the SETTLEMENT invoice.
 * Left in the report, its recognised revenue is 0 against the settlement revenue
 * billed, so it shows up as a contract liability, and `recognize()` (which finds
 * its row through `poc()`) would post Dr Revenue / Cr Contract Liability for all
 * of it.
 *
 * The Prisma double below genuinely evaluates `where` (and `include.where`), as in
 * credit-note-reporting.spec.ts: a filter the service never writes is a filter
 * that never runs, so the defect reproduces instead of being assumed.
 */

type Row = Record<string, unknown>;

// Only the operators these queries use. Anything else throws: a filter the double
// cannot evaluate must not silently pass.
function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const actual = row[key];
    if (cond !== null && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('in' in c) {
        if (!(c.in as unknown[]).includes(actual)) return false;
      } else if ('not' in c) {
        if (actual === c.not) return false;
      } else {
        throw new Error(`Prisma double: unsupported filter on "${key}"`);
      }
    } else if (actual !== cond) {
      return false;
    }
  }
  return true;
}

// `include.<to-many>.where` narrows the related rows, as Prisma does.
function applyInclude(row: Row, include?: Row): Row {
  if (!include) return row;
  const out = { ...row };
  for (const [rel, spec] of Object.entries(include)) {
    const s = spec as Record<string, unknown> | undefined;
    if (s && typeof s === 'object' && s.where && Array.isArray(out[rel])) {
      out[rel] = (out[rel] as Row[]).filter((r) => matches(r, s.where as Row));
    }
  }
  return out;
}

function table(rows: Row[]) {
  return {
    findMany: async ({ where, include }: { where?: Row; include?: Row } = {}) =>
      rows.filter((r) => matches(r, where)).map((r) => applyInclude(r, include)),
  };
}

const USER = { userId: 'u1', organizationId: 'org1' } as unknown as AuthUser;
const D = (s: string) => new Date(s);
const CUSTOMER = { nameAr: 'عميل تجريبي', nameEn: 'Test customer' };

// An EPC contract of 100,000: the first milestone (40,000) is certified and 25,000
// has been billed, so 15,000 of earned revenue is still unbilled (a contract asset).
const EPC_CONTRACT = {
  id: 'ctr-epc',
  organizationId: 'org1',
  code: 'CTR-0001',
  contractType: 'EPC',
  status: 'ACTIVE',
  totalValue: 100000,
  createdAt: D('2026-01-01'),
  customer: CUSTOMER,
  milestones: [
    { amount: 40000, status: 'VERIFIED' },
    { amount: 60000, status: 'PENDING' },
  ],
  invoices: [{ invoiceType: 'MILESTONE', status: 'ISSUED', subtotal: 25000 }],
  project: null,
};

// A PPA contract as PpaService creates it: ACTIVE, totalValue left at its default
// of 0, no milestones. Its one issued SETTLEMENT invoice is the energy sale itself.
const PPA_CONTRACT = {
  id: 'ctr-ppa',
  organizationId: 'org1',
  code: 'CTR-0002',
  contractType: 'PPA',
  status: 'ACTIVE',
  totalValue: 0,
  createdAt: D('2026-02-01'),
  customer: CUSTOMER,
  milestones: [],
  invoices: [{ invoiceType: 'SETTLEMENT', status: 'CLEARED', subtotal: 12000 }],
  project: null,
};

/**
 * A ReportsService over doubles that feed every call `poc()` and `recognize()`
 * make: the contract query, the (empty) ledger, the account mapping, the
 * transaction, the journal write and the audit write.
 */
function serviceFor(contracts: Row[]) {
  const journals: JournalInput[] = [];
  const audits: unknown[] = [];

  const prisma = {
    contract: table(contracts),
    // Nothing recognised yet and no project costs: an empty ledger.
    journalLine: table([]),
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  };
  const posting = {
    // Same contract as PostingService.accounts: purpose -> account id.
    accounts: async (_organizationId: string, purposes: readonly string[]) =>
      Object.fromEntries(purposes.map((p) => [p, `acc-${p}`])),
    journal: async (_tx: unknown, input: JournalInput) => {
      journals.push(input);
      return { id: `je-${journals.length}` };
    },
  };
  const audit = {
    record: async (entry: unknown) => {
      audits.push(entry);
    },
  };

  const service = new ReportsService(prisma as never, audit as never, posting as never);
  return { service, journals, audits };
}

describe('P1-1b: the POC report is for milestone contracts, PPA contracts stay out', () => {
  it('does not list an ACTIVE PPA contract', async () => {
    const { service } = serviceFor([EPC_CONTRACT, PPA_CONTRACT]);

    const rows = await service.poc(USER);

    // Unfiltered, this contract is a row with value 0, recognised 0, billed 12,000
    // and position CONTRACT_LIABILITY.
    expect(rows.map((r) => r.contractId)).not.toContain(PPA_CONTRACT.id);
  });

  it('still reports a milestone contract exactly as before', async () => {
    const { service } = serviceFor([EPC_CONTRACT, PPA_CONTRACT]);

    const rows = await service.poc(USER);

    expect(rows.find((r) => r.contractId === EPC_CONTRACT.id)).toMatchObject({
      code: 'CTR-0001',
      contractValue: 100000,
      progressPct: 40,
      recognizedRevenue: 40000,
      billedRevenue: 25000,
      postedAdjustment: 0,
      targetAdjustment: 15000,
      unpostedDelta: 15000,
      position: 'CONTRACT_ASSET',
    });
  });

  it('answers "not found" when asked to recognize a PPA contract', async () => {
    const { service } = serviceFor([EPC_CONTRACT, PPA_CONTRACT]);

    const attempt = service.recognize(USER, PPA_CONTRACT.id);

    await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
    await expect(attempt).rejects.toThrow('Contract not found or not active');
  });

  it('posts no journal and writes no audit row for a PPA contract', async () => {
    const { service, journals, audits } = serviceFor([EPC_CONTRACT, PPA_CONTRACT]);

    await service.recognize(USER, PPA_CONTRACT.id).catch(() => undefined);

    // Unfiltered, this is Dr Revenue 12,000 / Cr Contract Liability 12,000.
    expect(journals).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('control: the same fixture still lets recognize() post for the EPC contract', async () => {
    // Proves the journal double records what the service posts, so the empty
    // journal list above is evidence and not an artefact of the double.
    const { service, journals } = serviceFor([EPC_CONTRACT, PPA_CONTRACT]);

    await service.recognize(USER, EPC_CONTRACT.id);

    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({
      sourceType: 'RevenueRecognition',
      sourceId: EPC_CONTRACT.id,
    });
    expect(journals[0].lines).toEqual([
      { accountId: 'acc-REVENUE', debit: 0, credit: 15000 },
      { accountId: 'acc-CONTRACT_ASSET', debit: 15000, credit: 0 },
    ]);
  });
});
