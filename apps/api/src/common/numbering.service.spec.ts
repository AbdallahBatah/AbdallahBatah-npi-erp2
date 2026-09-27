import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { NumberingService } from './numbering.service';

/** A P2025 as Prisma raises it when an UPDATE's WHERE matches no row. */
function recordNotFound() {
  return new Prisma.PrismaClientKnownRequestError(
    'An operation failed because it depends on one or more records that were required but not found.',
    { code: 'P2025', clientVersion: 'test' },
  );
}

describe('NumberingService.next', () => {
  const svc = new NumberingService(undefined as never);

  it('formats prefix + zero-padded value from the atomic increment result', async () => {
    const tx = {
      numberingSequence: {
        // Post-increment row: nextValue 43 means THIS call was issued 42.
        update: jest.fn().mockResolvedValue({ prefix: 'INV', padding: 5, nextValue: 43 }),
      },
    };
    await expect(svc.next('org1', 'INVOICE', tx as never)).resolves.toBe('INV-00042');
    // Single atomic update on the composite key — no read-then-write window.
    expect(tx.numberingSequence.update).toHaveBeenCalledTimes(1);
    expect(tx.numberingSequence.update.mock.calls[0][0].data).toEqual({
      nextValue: { increment: 1 },
    });
  });

  it('maps a missing sequence row to a clear server error', async () => {
    const tx = {
      numberingSequence: {
        update: jest.fn().mockRejectedValue(new Error('P2025 no record')),
      },
    };
    await expect(svc.next('org1', 'NOPE', tx as never)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  describe('fiscal year rollover', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('opens the new fiscal year on demand and continues numbering instead of restarting', async () => {
      const update = jest
        .fn()
        .mockRejectedValueOnce(recordNotFound())
        .mockResolvedValueOnce({ prefix: 'INV', padding: 5, nextValue: 101 });
      const executeRaw = jest.fn().mockResolvedValue(1);
      const tx = {
        numberingSequence: { update },
        $executeRaw: executeRaw,
      };

      await expect(svc.next('org1', 'INVOICE', tx as never)).resolves.toBe('INV-00100');
      // One attempt to carry the previous year's row forward, then the same
      // atomic update retried exactly once.
      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(2);
      expect(
        update.mock.calls[0][0].where.organizationId_documentType_fiscalYear.fiscalYear,
      ).toBe(2027);
      expect(
        update.mock.calls[1][0].where.organizationId_documentType_fiscalYear.fiscalYear,
      ).toBe(2027);
    });

    it('still maps to a clear server error when no earlier year exists to carry forward', async () => {
      const update = jest.fn().mockRejectedValue(recordNotFound());
      const executeRaw = jest.fn().mockResolvedValue(0);
      const tx = {
        numberingSequence: { update },
        $executeRaw: executeRaw,
      };

      await expect(svc.next('org1', 'NEVER_CONFIGURED', tx as never)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
