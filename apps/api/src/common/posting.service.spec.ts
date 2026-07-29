import { InternalServerErrorException } from '@nestjs/common';
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
