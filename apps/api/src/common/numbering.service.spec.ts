import { InternalServerErrorException } from '@nestjs/common';
import { NumberingService } from './numbering.service';

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
});
