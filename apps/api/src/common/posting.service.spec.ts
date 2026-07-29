import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { PostingService } from './posting.service';

describe('PostingService.accounts', () => {
  const withRows = (rows: Array<{ purpose: string; accountId: string }>) => ({
    accountMapping: { findMany: jest.fn().mockResolvedValue(rows) },
  });

  it('returns purpose → accountId for every requested purpose', async () => {
    const prisma = withRows([
      { purpose: 'AR', accountId: 'acc-ar' },
      { purpose: 'REVENUE', accountId: 'acc-rev' },
    ]);
    const svc = new PostingService(prisma as never);

    await expect(svc.accounts('org1', ['AR', 'REVENUE'] as const)).resolves.toEqual({
      AR: 'acc-ar',
      REVENUE: 'acc-rev',
    });
    expect(prisma.accountMapping.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org1',
      purpose: { in: ['AR', 'REVENUE'] },
    });
  });

  it('fails closed when a purpose has no mapping, naming the missing ones', async () => {
    // Half-resolving would post an unbalanced journal — the ledger must never
    // be left half-written because a mapping was forgotten.
    const svc = new PostingService(withRows([{ purpose: 'AR', accountId: 'acc-ar' }]) as never);

    await expect(svc.accounts('org1', ['AR', 'VAT_OUTPUT'] as const)).rejects.toThrow(
      /VAT_OUTPUT/,
    );
    await expect(svc.accounts('org1', ['AR', 'VAT_OUTPUT'] as const)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('resolves a single purpose through the convenience wrapper', async () => {
    const svc = new PostingService(withRows([{ purpose: 'BANK', accountId: 'acc-bank' }]) as never);
    await expect(svc.account('org1', 'BANK')).resolves.toBe('acc-bank');
  });

  it('uses the caller transaction client when one is passed', async () => {
    const prisma = withRows([]);
    const tx = withRows([{ purpose: 'AP', accountId: 'acc-ap' }]);
    const svc = new PostingService(prisma as never);

    await expect(svc.accounts('org1', ['AP'] as const, tx as never)).resolves.toEqual({
      AP: 'acc-ap',
    });
    expect(prisma.accountMapping.findMany).not.toHaveBeenCalled();
  });
});

describe('PostingService.journal', () => {
  const txWith = (period: unknown) => ({
    fiscalPeriod: { findFirst: jest.fn().mockResolvedValue(period) },
    journalEntry: { create: jest.fn().mockResolvedValue({ id: 'je1' }) },
  });
  const svc = new PostingService(undefined as never);
  const base = { organizationId: 'org1', sourceType: 'Invoice', sourceId: 'inv1' };

  it('writes a balanced entry into an open period', async () => {
    const tx = txWith(null);
    await svc.journal(tx as never, {
      ...base,
      lines: [
        { accountId: 'a', debit: 100, credit: 0 },
        { accountId: 'b', debit: 0, credit: 100 },
      ],
    });
    expect(tx.journalEntry.create).toHaveBeenCalledTimes(1);
    expect(tx.journalEntry.create.mock.calls[0][0].data.lines.create[0].currency).toBe('SAR');
  });

  it('refuses an unbalanced entry before writing anything', async () => {
    const tx = txWith(null);
    await expect(
      svc.journal(tx as never, {
        ...base,
        lines: [
          { accountId: 'a', debit: 100, credit: 0 },
          { accountId: 'b', debit: 0, credit: 99.5 },
        ],
      }),
    ).rejects.toThrow(/Journal not balanced/);
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it('refuses a posting into a closed period', async () => {
    const tx = txWith({ status: 'CLOSED', month: 3, fiscalYear: { year: 2026, status: 'OPEN' } });
    await expect(
      svc.journal(tx as never, {
        ...base,
        lines: [
          { accountId: 'a', debit: 1, credit: 0 },
          { accountId: 'b', debit: 0, credit: 1 },
        ],
      }),
    ).rejects.toThrow('Accounting period 2026-03 is closed');
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it('refuses a posting into an open period of a closed year', async () => {
    const tx = txWith({ status: 'OPEN', month: 11, fiscalYear: { year: 2025, status: 'CLOSED' } });
    await expect(
      svc.journal(tx as never, {
        ...base,
        lines: [
          { accountId: 'a', debit: 1, credit: 0 },
          { accountId: 'b', debit: 0, credit: 1 },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('stays permissive when no fiscal calendar covers the date', async () => {
    // An organization that never set up periods must keep posting as before.
    const tx = txWith(null);
    await expect(svc.assertPeriodOpen('org1', new Date(), tx as never)).resolves.toBeUndefined();
  });
});
