import { Injectable } from '@nestjs/common';
import type { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';

export interface LastCost {
  unitCost: Prisma.Decimal;
  /** Where it came from: an accepted receipt, an approved order, or the catalogue. */
  costSource: 'GRN' | 'PO' | 'CATALOGUE';
  /** When it was incurred (receipt / approval date); null for a catalogue cost. */
  costDate: Date | null;
}

/**
 * CRM Phase 1 · Step 4 (spec 4.3): «تكلفة البند تُجلب من آخر سعر شراء مسجّل». The
 * last purchase of an item is, in this order of trust:
 *
 *   1. the last ACCEPTED goods receipt — the price actually delivered and taken in
 *      stock — at its purchase-order line's unit price (receipt date),
 *   2. else the last APPROVED purchase order's line price (approval date),
 *   3. else the catalogue cost (`Item.unitCost`), which carries no date.
 *
 * Only purchases in the proposal's currency count: a USD price is not a SAR cost.
 * One query per source for the whole item list, never one per item. Items that
 * belong to another organization are simply absent from the answer.
 *
 * The result is ordered newest-first in the database and the first row per item
 * is taken here, so an item with a long purchase history reads all of its rows;
 * acceptable for the catalogue sizes this ERP has (a `DISTINCT ON` is the upgrade
 * if that ever stops being true).
 */
@Injectable()
export class ItemCostService {
  constructor(private readonly prisma: PrismaService) {}

  async lastPurchaseCosts(
    organizationId: string,
    itemIds: string[],
    currency: string,
  ): Promise<Map<string, LastCost>> {
    const wanted = [...new Set(itemIds)];
    const result = new Map<string, LastCost>();
    if (wanted.length === 0) return result;

    // The tenant filter and the catalogue fallback in one query.
    const items = await this.prisma.item.findMany({
      where: { organizationId, id: { in: wanted } },
      select: { id: true, unitCost: true },
    });
    if (items.length === 0) return result;
    const ownIds = items.map((i) => i.id);

    // 1. last accepted receipt, in this currency
    const receipts = await this.prisma.goodsReceiptLine.findMany({
      where: {
        goodsReceipt: { organizationId, status: 'ACCEPTED' },
        purchaseOrderLine: { itemId: { in: ownIds }, purchaseOrder: { currency } },
      },
      select: {
        goodsReceipt: { select: { receivedAt: true } },
        purchaseOrderLine: { select: { itemId: true, unitPrice: true } },
      },
      orderBy: { goodsReceipt: { receivedAt: 'desc' } },
    });
    for (const r of receipts) {
      const id = r.purchaseOrderLine.itemId;
      if (result.has(id)) continue;
      result.set(id, { unitCost: r.purchaseOrderLine.unitPrice, costSource: 'GRN', costDate: r.goodsReceipt.receivedAt });
    }

    // 2. else last approved order, in this currency — only for what no receipt covered
    const missing = ownIds.filter((id) => !result.has(id));
    if (missing.length > 0) {
      const orders = await this.prisma.purchaseOrderLine.findMany({
        where: {
          itemId: { in: missing },
          purchaseOrder: { organizationId, currency, approvedAt: { not: null } },
        },
        select: { itemId: true, unitPrice: true, purchaseOrder: { select: { approvedAt: true } } },
        orderBy: { purchaseOrder: { approvedAt: 'desc' } },
      });
      for (const o of orders) {
        if (result.has(o.itemId)) continue;
        result.set(o.itemId, { unitCost: o.unitPrice, costSource: 'PO', costDate: o.purchaseOrder.approvedAt });
      }
    }

    // 3. else the catalogue cost (no date, so no age)
    for (const item of items) {
      if (!result.has(item.id)) {
        result.set(item.id, { unitCost: item.unitCost, costSource: 'CATALOGUE', costDate: null });
      }
    }
    return result;
  }
}
