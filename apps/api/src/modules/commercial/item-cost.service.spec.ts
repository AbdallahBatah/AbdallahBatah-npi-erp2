/**
 * CRM Phase 1 · Step 4 (contract §5, §8) — the cost of an item is its LAST PURCHASE:
 * an accepted goods receipt first, an approved purchase order second, the
 * catalogue cost (no date) last. One batched query per source, never one per item.
 *
 * The filters that a mock cannot execute (currency, tenant, ACCEPTED) are pinned
 * by asserting the `where` the service sends; the real database behaviour is
 * proved in test/proposal-lifecycle.int-spec.ts.
 */
import { Prisma } from '@npi/db';
import { ItemCostService } from './item-cost.service';

const D = (v: string | number) => new Prisma.Decimal(v);

function setup(over: { items?: unknown[]; grn?: unknown[]; po?: unknown[] } = {}) {
  const prisma = {
    item: {
      findMany: jest.fn().mockResolvedValue(
        over.items ?? [
          { id: 'i1', unitCost: D('10.00') },
          { id: 'i2', unitCost: D('20.00') },
        ],
      ),
    },
    goodsReceiptLine: { findMany: jest.fn().mockResolvedValue(over.grn ?? []) },
    purchaseOrderLine: { findMany: jest.fn().mockResolvedValue(over.po ?? []) },
  };
  return { svc: new ItemCostService(prisma as never), prisma };
}

const grn = (itemId: string, unitPrice: string, receivedAt: string) => ({
  purchaseOrderLine: { itemId, unitPrice: D(unitPrice) },
  goodsReceipt: { receivedAt: new Date(receivedAt) },
});
const po = (itemId: string, unitPrice: string, approvedAt: string) => ({
  itemId,
  unitPrice: D(unitPrice),
  purchaseOrder: { approvedAt: new Date(approvedAt) },
});

describe('ItemCostService.lastPurchaseCosts', () => {
  it('prefers the last accepted receipt over a purchase order over the catalogue', async () => {
    const { svc } = setup({
      items: [
        { id: 'i1', unitCost: D('10.00') },
        { id: 'i2', unitCost: D('20.00') },
        { id: 'i3', unitCost: D('30.00') },
      ],
      // newest first, as the query orders them
      grn: [grn('i1', '11.50', '2026-09-20'), grn('i1', '9.00', '2026-08-01')],
      po: [po('i2', '21.00', '2026-09-10')],
    });
    const out = await svc.lastPurchaseCosts('org1', ['i1', 'i2', 'i3'], 'SAR');

    expect(out.get('i1')).toMatchObject({ costSource: 'GRN', costDate: new Date('2026-09-20') });
    expect(out.get('i1')!.unitCost.toFixed(2)).toBe('11.50'); // the newest receipt, not the older one
    expect(out.get('i2')).toMatchObject({ costSource: 'PO', costDate: new Date('2026-09-10') });
    expect(out.get('i2')!.unitCost.toFixed(2)).toBe('21.00');
    expect(out.get('i3')).toMatchObject({ costSource: 'CATALOGUE', costDate: null });
    expect(out.get('i3')!.unitCost.toFixed(2)).toBe('30.00');
  });

  it('a catalogue cost carries no date, so its age is unknown', async () => {
    const { svc } = setup();
    const out = await svc.lastPurchaseCosts('org1', ['i1'], 'SAR');
    expect(out.get('i1')).toMatchObject({ costSource: 'CATALOGUE', costDate: null });
  });

  it('asks only for this organization, ACCEPTED receipts and approved orders in the proposal currency', async () => {
    const { svc, prisma } = setup();
    await svc.lastPurchaseCosts('org1', ['i1', 'i2'], 'USD');

    expect(prisma.item.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org1', id: { in: ['i1', 'i2'] } }) }),
    );
    const grnWhere = prisma.goodsReceiptLine.findMany.mock.calls[0][0].where;
    expect(grnWhere.goodsReceipt).toMatchObject({ organizationId: 'org1', status: 'ACCEPTED' });
    expect(grnWhere.purchaseOrderLine.purchaseOrder).toMatchObject({ currency: 'USD' });
    const poWhere = prisma.purchaseOrderLine.findMany.mock.calls[0][0].where;
    expect(poWhere.purchaseOrder).toMatchObject({ organizationId: 'org1', currency: 'USD', approvedAt: { not: null } });
  });

  it('leaves out items of another organization without a word', async () => {
    // The items query is org-scoped, so a foreign id simply is not returned.
    const { svc } = setup({ items: [{ id: 'i1', unitCost: D('10.00') }] });
    const out = await svc.lastPurchaseCosts('org1', ['i1', 'foreign'], 'SAR');
    expect([...out.keys()]).toEqual(['i1']);
  });

  it('is batched: one query per source, and the order query only for what the receipts missed', async () => {
    const { svc, prisma } = setup({ grn: [grn('i1', '11.00', '2026-09-20')] });
    await svc.lastPurchaseCosts('org1', ['i1', 'i2'], 'SAR');
    expect(prisma.item.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.goodsReceiptLine.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.purchaseOrderLine.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.purchaseOrderLine.findMany.mock.calls[0][0].where.itemId).toEqual({ in: ['i2'] });
  });

  it('does not query purchase orders when the receipts cover everything, nor anything for an empty list', async () => {
    const full = setup({
      items: [{ id: 'i1', unitCost: D('10') }],
      grn: [grn('i1', '11.00', '2026-09-20')],
    });
    await full.svc.lastPurchaseCosts('org1', ['i1'], 'SAR');
    expect(full.prisma.purchaseOrderLine.findMany).not.toHaveBeenCalled();

    const empty = setup();
    await expect(empty.svc.lastPurchaseCosts('org1', [], 'SAR')).resolves.toEqual(new Map());
    expect(empty.prisma.item.findMany).not.toHaveBeenCalled();
  });
});
