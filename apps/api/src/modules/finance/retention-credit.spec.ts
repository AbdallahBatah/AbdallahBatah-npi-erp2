import { BadRequestException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import type { AuthUser } from '../../common/auth-user';

const USER = { userId: 'u1', organizationId: 'org1' } as unknown as AuthUser;

/**
 * A retention entry as `releaseRetention` reads it, with an invoice attached.
 * `withheldAmount` is what was originally kept back; `creditedAmount` is the
 * share a credit note has since returned to the customer.
 */
function entry(withheld: number, credited: number) {
  return {
    id: 'ret1',
    invoiceId: 'inv1',
    withheldAmount: withheld,
    creditedAmount: credited,
    status: 'WITHHELD',
    invoice: { id: 'inv1', code: 'INV-00001', currency: 'SAR', netPayable: 550_000, status: 'CLEARED' },
  };
}

function serviceFor(retention: ReturnType<typeof entry>) {
  const journals: Array<{ lines: Array<{ accountId: string; debit: number; credit: number }> }> = [];
  const invoiceUpdates: Array<Record<string, unknown>> = [];

  const prisma = {
    retentionEntry: { findFirst: async () => retention },
    // The retry wrapper is not what is under test here.
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        retentionEntry: { update: async () => ({ ...retention, status: 'RELEASED' }) },
        invoice: { update: async ({ data }: { data: Record<string, unknown> }) => invoiceUpdates.push(data) },
      }),
  };
  const posting = {
    accounts: async () => ({ AR: 'acc-ar', RETENTION_RECEIVABLE: 'acc-ret' }),
    journal: async (_tx: unknown, input: { lines: Array<{ accountId: string; debit: number; credit: number }> }) =>
      journals.push(input),
  };
  const audit = { record: async () => undefined };

  const service = new InvoicesService(
    prisma as never,
    {} as never,
    audit as never,
    posting as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, journals, invoiceUpdates };
}

describe('D-02: a credited retention must not be released twice', () => {
  it('releases only what is still withheld', async () => {
    // 25,000 withheld, 2,500 already returned by a partial credit note.
    const { service, journals, invoiceUpdates } = serviceFor(entry(25_000, 2_500));

    await service.releaseRetention(USER, 'ret1');

    expect(journals).toHaveLength(1);
    const [ar, ret] = journals[0].lines;
    expect(ar.debit).toBe(22_500);
    expect(ret.credit).toBe(22_500);
    // The ledger holds 22,500; debiting 25,000 would leave the retention
    // account with a permanent credit balance and over-bill the customer.
    expect(invoiceUpdates[0].netPayable).toBe(572_500);
  });

  it('releases the full amount when nothing was credited', async () => {
    const { service, journals } = serviceFor(entry(25_000, 0));
    await service.releaseRetention(USER, 'ret1');
    expect(journals[0].lines[0].debit).toBe(25_000);
  });

  it('refuses to release retention that has been credited away entirely', async () => {
    const { service, journals } = serviceFor(entry(25_000, 25_000));
    await expect(service.releaseRetention(USER, 'ret1')).rejects.toBeInstanceOf(BadRequestException);
    // Nothing posted: a zero-value release would still have written a journal.
    expect(journals).toHaveLength(0);
  });
});
