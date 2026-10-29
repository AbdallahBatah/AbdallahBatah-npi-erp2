/**
 * Package 3 · P3-7 (ADR-03 §4-6) — the printable quote. It is read by the
 * customer, so nothing on the cost side may reach it; only an approved budget
 * is a quote; a lump-sum budget prints scope and one price.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { ProposalPrintService } from './proposal-print.service';
import type { AuthUser } from '../../common/auth-user';

const D = (v: string | number) => new Prisma.Decimal(v);
const PM = { userId: 'u1', organizationId: 'org1', permissions: ['commercial.proposal.read'] } as unknown as AuthUser;

const revision = (over: Record<string, unknown> = {}) => ({
  revisionNo: 2,
  status: 'APPROVED',
  approvedAt: new Date('2026-10-28T10:00:00Z'),
  createdAt: new Date('2026-10-27T10:00:00Z'),
  validUntil: new Date('2026-11-27T00:00:00Z'),
  pricingMode: 'LUMP_SUM',
  totalAmount: D('1000000.00'),
  designVersion: { capacityKwp: D('643.5'), expectedAnnualKwh: D('1100000') },
  bomLines: [
    {
      id: 'b2',
      qty: D('648.45'),
      uom: null,
      description: null,
      unitPrice: D('0'),
      lineTotal: D('0'),
      item: null,
      workItem: { code: 'WI-02', nameAr: 'تنفيذ أعمال الكهرباء', nameEn: 'Electrical works', uom: 'kW', sortOrder: 2 },
    },
    {
      id: 'b1',
      qty: D('990'),
      uom: null,
      description: 'ألواح 655 واط',
      unitPrice: D('0'),
      lineTotal: D('0'),
      item: { nameAr: 'لوح شمسي', nameEn: 'PV module', uom: 'panel' },
      workItem: { code: 'WI-01', nameAr: 'ألواح شمسية', nameEn: 'Solar panels', uom: 'panel', sortOrder: 1 },
    },
  ],
  ...over,
});

function setup(rev: unknown = revision(), found = true) {
  const proposal = found
    ? {
        id: 'p1',
        code: 'PRP-00007',
        currency: 'SAR',
        organization: { legalNameAr: 'شركة الطاقة والصناعة', legalNameEn: 'Energy & Industry Co.' },
        opportunity: {
          name: 'مزرعة الآبار',
          customer: { nameAr: 'مزارع الدوسري', nameEn: 'Al-Dosari Farms', vatNumber: null, crNumber: null, mobile: null, phone: null },
          sourceLead: { siteLocation: 'الخرج' },
        },
        revisions: rev ? [rev] : [],
      }
    : null;
  const prisma = { proposal: { findFirst: jest.fn().mockResolvedValue(proposal) } };
  const tax = { standardVat: jest.fn().mockResolvedValue({ id: 'tc', rate: 15 }) };
  return { svc: new ProposalPrintService(prisma as never, tax as never), prisma, tax };
}

describe('ProposalPrintService.quote', () => {
  it('a lump-sum budget prints scope in the company order, one price, and 15 % VAT', async () => {
    const { svc } = setup();
    const q = await svc.quote(PM, 'p1');
    expect(q.lines.map((l) => l.nameAr)).toEqual(['ألواح 655 واط', 'تنفيذ أعمال الكهرباء']);
    expect(q.lines.every((l) => l.unitPrice === null && l.lineTotal === null)).toBe(true);
    expect(q.lines[1]).toMatchObject({ qty: '648.45', uom: 'kW' });
    expect(q.totals).toEqual({ net: '1000000.00', vatRate: 15, vat: '150000.00', gross: '1150000.00' });
    expect(q.siteLocation).toBe('الخرج');
  });

  it('never carries a cost-side key, whatever the revision holds', async () => {
    const { svc } = setup(
      revision({ subtotal: D('800000'), marginAmount: D('200000'), contingencyAmount: D('5'), riskNotes: 'سري' }),
    );
    const text = JSON.stringify(await svc.quote(PM, 'p1'));
    for (const k of ['subtotal', 'marginAmount', 'contingency', 'riskNotes', 'unitCost', 'سري']) {
      expect(text).not.toContain(k);
    }
  });

  it('a per-line revision prints its line prices', async () => {
    const { svc } = setup(
      revision({
        pricingMode: 'PER_LINE',
        bomLines: [
          {
            id: 'b1',
            qty: D('2'),
            uom: null,
            description: null,
            unitPrice: D('130'),
            lineTotal: D('260'),
            item: { nameAr: 'عاكس', nameEn: 'Inverter', uom: 'unit' },
            workItem: null,
          },
        ],
        totalAmount: D('260'),
      }),
    );
    const q = await svc.quote(PM, 'p1');
    expect(q.lines[0]).toMatchObject({ nameAr: 'عاكس', unitPrice: '130.00', lineTotal: '260.00' });
  });

  it('a budget not yet approved is not a quote (409)', async () => {
    const { svc } = setup(revision({ status: 'PENDING_APPROVAL' }));
    await expect(svc.quote(PM, 'p1', 2)).rejects.toBeInstanceOf(ConflictException);
  });

  it('without a revision number it looks only among approved / sent / accepted ones', async () => {
    const { svc, prisma } = setup(null);
    await expect(svc.quote(PM, 'p1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.proposal.findFirst.mock.calls[0][0].include.revisions.where).toEqual({
      status: { in: ['APPROVED', 'SENT', 'ACCEPTED'] },
    });
  });

  it('a proposal of another organization is not found (404)', async () => {
    const { svc, prisma } = setup(undefined, false);
    await expect(svc.quote(PM, 'p-other')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.proposal.findFirst.mock.calls[0][0].where).toEqual({ id: 'p-other', organizationId: 'org1' });
  });
});
