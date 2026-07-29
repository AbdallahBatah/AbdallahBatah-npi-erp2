import { InternalServerErrorException } from '@nestjs/common';
import { TaxService } from './tax.service';

describe('TaxService.standardVat', () => {
  it('reads the rate from the TaxCode table, not a compiled-in constant', async () => {
    const prisma = {
      taxCode: {
        // A 5% era (or a customer on a different rate) must need only a data edit.
        findFirst: jest.fn().mockResolvedValue({ id: 'tc1', rate: '5.000' }),
      },
    };
    const svc = new TaxService(prisma as never);

    await expect(svc.standardVat('org1')).resolves.toEqual({ id: 'tc1', rate: 5 });
    expect(prisma.taxCode.findFirst.mock.calls[0][0].where).toEqual({
      organizationId: 'org1',
      taxType: 'VAT_STANDARD',
    });
  });

  it('fails closed when no standard code is configured', async () => {
    // Defaulting to 0% would silently understate a statutory liability.
    const svc = new TaxService({ taxCode: { findFirst: jest.fn().mockResolvedValue(null) } } as never);
    await expect(svc.standardVat('org1')).rejects.toThrow(InternalServerErrorException);
  });
});
