import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import type {
  CreateBillDto,
  CreateClaimDto,
  CreatePoDto,
  CreateSubcontractDto,
  CreateVendorDto,
  ReceiveDto,
  TransferDto,
} from './dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const VAT_RATE = 15;

@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  // ── Vendors (SCM master data) ─────────────────────────────────────────────

  listVendors(user: AuthUser) {
    return this.prisma.vendor.findMany({
      where: { organizationId: user.organizationId },
      include: { _count: { select: { purchaseOrders: true } } },
      orderBy: { code: 'asc' },
    });
  }

  async createVendor(user: AuthUser, dto: CreateVendorDto) {
    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'VENDOR', tx);
      const vendor = await tx.vendor.create({
        data: {
          organizationId: user.organizationId,
          code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn,
          vendorType: dto.vendorType ?? 'SUPPLIER',
          vatNumber: dto.vatNumber,
          crNumber: dto.crNumber,
          phone: dto.phone,
          email: dto.email,
          isManufacturer: dto.isManufacturer ?? false,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Vendor',
          entityId: vendor.id,
          action: 'CREATE',
          after: { code, nameEn: dto.nameEn },
        },
        tx,
      );
      return vendor;
    });
  }

  // ── Purchase orders (SCM-01/02) ───────────────────────────────────────────

  listPos(user: AuthUser) {
    return this.prisma.purchaseOrder.findMany({
      where: { organizationId: user.organizationId },
      include: {
        vendor: { select: { code: true, nameAr: true, nameEn: true } },
        project: { select: { id: true, code: true } },
        _count: { select: { goodsReceipts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPo(user: AuthUser, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        vendor: true,
        project: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        lines: {
          include: {
            item: { select: { sku: true, nameAr: true, nameEn: true, isSerialised: true, uom: true } },
            wbsElement: { select: { code: true, nameAr: true, nameEn: true } },
          },
        },
        goodsReceipts: {
          include: { lines: true, serialUnits: { select: { id: true } }, vendorBills: { select: { id: true, code: true, status: true } } },
          orderBy: { receivedAt: 'desc' },
        },
        vendorBills: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  /** Create a draft PO. Committed cost appears once it is approved. */
  async createPo(user: AuthUser, dto: CreatePoDto) {
    if (!dto.lines.length) throw new BadRequestException('PO needs at least one line');

    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, organizationId: user.organizationId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');

    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: dto.projectId, organizationId: user.organizationId },
      });
      if (!project) throw new NotFoundException('Project not found');
    }

    const items = await this.prisma.item.findMany({
      where: { organizationId: user.organizationId, id: { in: dto.lines.map((l) => l.itemId) } },
      select: { id: true },
    });
    if (items.length !== new Set(dto.lines.map((l) => l.itemId)).size) {
      throw new BadRequestException('One or more items not found');
    }

    const lines = dto.lines.map((l) => ({
      itemId: l.itemId,
      wbsElementId: l.wbsElementId,
      qty: l.qty,
      unitPrice: l.unitPrice,
      lineTotal: round2(l.qty * l.unitPrice),
    }));
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const vatAmount = round2(subtotal * (VAT_RATE / 100));

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'PURCHASE_ORDER', tx);
      const po = await tx.purchaseOrder.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: dto.vendorId,
          projectId: dto.projectId,
          currency: dto.currency ?? 'SAR',
          subtotal,
          vatAmount,
          total: round2(subtotal + vatAmount),
          lines: { create: lines },
        },
        include: { lines: true },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PurchaseOrder',
          entityId: po.id,
          action: 'CREATE',
          after: { code, subtotal, vatAmount, projectId: dto.projectId },
        },
        tx,
      );
      return po;
    });
  }

  async approvePo(user: AuthUser, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status !== 'DRAFT') throw new BadRequestException('Only draft POs can be approved');

    const updated = await this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedById: user.userId },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'PurchaseOrder',
      entityId: id,
      action: 'APPROVE',
      after: { status: 'APPROVED' },
    });
    return updated;
  }

  // ── Goods receipt (SCM-01) + serial registration (SCM-05) + actuals (PRJ-03)

  async receive(user: AuthUser, poId: string, dto: ReceiveDto) {
    if (!dto.lines.length) throw new BadRequestException('Receipt needs at least one line');

    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, organizationId: user.organizationId },
      include: { lines: { include: { item: true } }, vendor: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      throw new BadRequestException('PO must be approved before receiving');
    }

    // Validate every receipt line against its PO line.
    const byId = new Map(po.lines.map((l) => [l.id, l]));
    for (const rl of dto.lines) {
      const pol = byId.get(rl.poLineId);
      if (!pol) throw new BadRequestException(`PO line ${rl.poLineId} not found on this PO`);
      const remaining = Number(pol.qty) - Number(pol.receivedQty);
      if (rl.qty > remaining + 1e-9) {
        throw new BadRequestException(
          `Line ${pol.item.sku}: receiving ${rl.qty} exceeds remaining ${remaining}`,
        );
      }
      if (pol.item.isSerialised) {
        const serials = rl.serials ?? [];
        if (serials.length !== rl.qty) {
          throw new BadRequestException(
            `Line ${pol.item.sku} is serialised: ${rl.qty} serial numbers required, got ${serials.length}`,
          );
        }
        if (new Set(serials).size !== serials.length) {
          throw new BadRequestException(`Line ${pol.item.sku}: duplicate serial numbers in receipt`);
        }
      }
    }

    // SCM-04: goods land in a location (default: first warehouse).
    const location = dto.locationId
      ? await this.prisma.location.findFirst({
          where: { id: dto.locationId, organizationId: user.organizationId },
        })
      : await this.prisma.location.findFirst({
          where: { organizationId: user.organizationId, locationType: 'WAREHOUSE' },
          orderBy: { code: 'asc' },
        });
    if (!location) throw new BadRequestException('No stock location found — re-run the seed');

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'GOODS_RECEIPT', tx);
      const grn = await tx.goodsReceipt.create({
        data: {
          organizationId: user.organizationId,
          code,
          purchaseOrderId: po.id,
          receivedById: user.userId,
          notes: dto.notes,
          lines: {
            create: dto.lines.map((rl) => ({ purchaseOrderLineId: rl.poLineId, qty: rl.qty })),
          },
        },
      });

      let materialCost = 0;
      for (const rl of dto.lines) {
        const pol = byId.get(rl.poLineId)!;
        await tx.purchaseOrderLine.update({
          where: { id: pol.id },
          data: { receivedQty: { increment: rl.qty } },
        });

        // SCM-05: serialised stock is born here, as entities not fields.
        if (pol.item.isSerialised) {
          await tx.serialUnit.createMany({
            data: (rl.serials ?? []).map((serialNo) => ({
              organizationId: user.organizationId,
              itemId: pol.itemId,
              serialNo,
              batchNo: rl.batchNo,
              manufacturerVendorId: po.vendor.isManufacturer ? po.vendorId : null,
              goodsReceiptId: grn.id,
              projectId: po.projectId,
              currentState: 'IN_STOCK' as const,
              locationId: location.id,
            })),
          });
        } else {
          // Bulk stock: level up at the receiving location.
          await tx.stockLevel.upsert({
            where: {
              organizationId_itemId_locationId: {
                organizationId: user.organizationId,
                itemId: pol.itemId,
                locationId: location.id,
              },
            },
            update: { qty: { increment: rl.qty } },
            create: {
              organizationId: user.organizationId,
              itemId: pol.itemId,
              locationId: location.id,
              qty: rl.qty,
            },
          });
        }
        // Append-only movement trail (one row per receipt line).
        await tx.stockMovement.create({
          data: {
            organizationId: user.organizationId,
            itemId: pol.itemId,
            toLocationId: location.id,
            qty: rl.qty,
            movementType: 'RECEIPT',
            sourceType: 'GoodsReceipt',
            sourceId: grn.id,
          },
        });

        // PRJ-03: append-only actual cost, per WBS bucket of the PO line.
        const amount = round2(rl.qty * Number(pol.unitPrice));
        materialCost += amount;
        if (po.projectId) {
          await tx.projectCostEntry.create({
            data: {
              organizationId: user.organizationId,
              projectId: po.projectId,
              wbsElementId: pol.wbsElementId,
              costType: 'MATERIAL',
              sourceType: 'GoodsReceipt',
              sourceId: grn.id,
              amount,
              memo: `${grn.code} · ${pol.item.sku} × ${rl.qty} @ ${Number(pol.unitPrice)}`,
            },
          });
        }
      }

      // Fully received when every line's receivedQty reaches its qty.
      const fresh = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
      const fullyReceived = fresh.every((l) => Number(l.receivedQty) >= Number(l.qty) - 1e-9);
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'GoodsReceipt',
          entityId: grn.id,
          action: 'RECEIVE',
          after: { code, poCode: po.code, materialCost: round2(materialCost), fullyReceived },
        },
        tx,
      );

      return tx.goodsReceipt.findUnique({
        where: { id: grn.id },
        include: { lines: true, serialUnits: true },
      });
    });
  }

  // ── Vendor bill (SCM↔FIN): AP journal + deductible input VAT ─────────────

  /**
   * Bill the received value of a GRN: Dr Project WIP (1300) + Dr VAT Input
   * (1400) / Cr Accounts Payable (2000). This is what turns the VAT-return
   * input side from zero into real numbers.
   */
  async createBill(user: AuthUser, dto: CreateBillDto) {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id: dto.goodsReceiptId, organizationId: user.organizationId },
      include: {
        purchaseOrder: { include: { vendor: true } },
        lines: { include: { purchaseOrderLine: true } },
        vendorBills: { select: { id: true } },
      },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    if (grn.vendorBills.length > 0) {
      throw new BadRequestException('Goods receipt is already billed');
    }

    const subtotal = round2(
      grn.lines.reduce((s, l) => s + Number(l.qty) * Number(l.purchaseOrderLine.unitPrice), 0),
    );
    const vatAmount = round2(subtotal * (VAT_RATE / 100));
    const total = round2(subtotal + vatAmount);

    const accounts = await this.prisma.account.findMany({
      where: { organizationId: user.organizationId, code: { in: ['1300', '1400', '2000'] } },
    });
    const acc = (code: string) => {
      const a = accounts.find((x) => x.code === code);
      if (!a) throw new BadRequestException(`Missing GL account ${code} — re-run the seed`);
      return a.id;
    };

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'VENDOR_BILL', tx);
      const bill = await tx.vendorBill.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: grn.purchaseOrder.vendorId,
          purchaseOrderId: grn.purchaseOrderId,
          goodsReceiptId: grn.id,
          subtotal,
          vatAmount,
          total,
          status: 'POSTED',
          vendorRef: dto.vendorRef,
        },
      });

      await tx.journalEntry.create({
        data: {
          organizationId: user.organizationId,
          sourceType: 'VendorBill',
          sourceId: bill.id,
          memo: `Vendor bill ${code} — ${grn.purchaseOrder.vendor.nameEn} (${grn.code})`,
          lines: {
            create: [
              { accountId: acc('1300'), debit: subtotal, credit: 0, currency: grn.purchaseOrder.currency },
              { accountId: acc('1400'), debit: vatAmount, credit: 0, currency: grn.purchaseOrder.currency },
              { accountId: acc('2000'), debit: 0, credit: total, currency: grn.purchaseOrder.currency },
            ],
          },
        },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'VendorBill',
          entityId: bill.id,
          action: 'POST',
          after: { code, subtotal, vatAmount, total },
        },
        tx,
      );
      return bill;
    });
  }

  // ── Serial units (AST-01 minimal registry) ────────────────────────────────

  async listSerialUnits(
    user: AuthUser,
    q?: { search?: string; state?: string; take?: number; skip?: number },
  ) {
    const where = {
      organizationId: user.organizationId,
      ...(q?.state ? { currentState: q.state as any } : {}),
      ...(q?.search
        ? {
            OR: [
              { serialNo: { contains: q.search, mode: 'insensitive' as const } },
              { item: { sku: { contains: q.search, mode: 'insensitive' as const } } },
              { item: { nameAr: { contains: q.search, mode: 'insensitive' as const } } },
              { item: { nameEn: { contains: q.search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const query = {
      where,
      include: {
        item: { select: { sku: true, nameAr: true, nameEn: true } },
        project: { select: { code: true } },
        goodsReceipt: { select: { code: true } },
        manufacturerVendor: { select: { nameAr: true, nameEn: true } },
        location: { select: { id: true, code: true, nameAr: true, nameEn: true } },
      },
      orderBy: { createdAt: 'desc' as const },
    };
    // With `take`, return a paginated envelope; otherwise the legacy array.
    if (q?.take !== undefined) {
      const [rows, total] = await Promise.all([
        this.prisma.serialUnit.findMany({ ...query, take: q.take, skip: q.skip ?? 0 }),
        this.prisma.serialUnit.count({ where }),
      ]);
      return { rows, total };
    }
    return this.prisma.serialUnit.findMany(query);
  }

  // ── Subcontracts & progress claims (PRJ-07) ───────────────────────────────

  listSubcontracts(user: AuthUser) {
    return this.prisma.subcontractAgreement.findMany({
      where: { organizationId: user.organizationId },
      include: {
        vendor: { select: { code: true, nameAr: true, nameEn: true } },
        project: { select: { id: true, code: true } },
        claims: { orderBy: { sequence: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSubcontract(user: AuthUser, dto: CreateSubcontractDto) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, organizationId: user.organizationId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, organizationId: user.organizationId },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (dto.wbsElementId) {
      const wbs = await this.prisma.wbsElement.findFirst({
        where: { id: dto.wbsElementId, projectId: dto.projectId },
      });
      if (!wbs) throw new BadRequestException('WBS element does not belong to this project');
    }

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'SUBCONTRACT', tx);
      const sub = await tx.subcontractAgreement.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: dto.vendorId,
          projectId: dto.projectId,
          wbsElementId: dto.wbsElementId,
          scopeAr: dto.scopeAr,
          scopeEn: dto.scopeEn,
          amount: dto.amount,
          retentionPct: dto.retentionPct ?? 0,
          status: 'ACTIVE',
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'SubcontractAgreement',
          entityId: sub.id,
          action: 'CREATE',
          after: { code, amount: dto.amount, vendorId: dto.vendorId },
        },
        tx,
      );
      return sub;
    });
  }

  /** المستخلص: submit a progress claim against the agreement's remaining value. */
  async createClaim(user: AuthUser, agreementId: string, dto: CreateClaimDto) {
    const agreement = await this.prisma.subcontractAgreement.findFirst({
      where: { id: agreementId, organizationId: user.organizationId },
      include: { claims: { where: { status: { in: ['SUBMITTED', 'APPROVED', 'PAID'] } } } },
    });
    if (!agreement) throw new NotFoundException('Subcontract not found');
    if (agreement.status !== 'ACTIVE') {
      throw new BadRequestException('Subcontract must be ACTIVE to claim against');
    }
    const claimedSoFar = agreement.claims.reduce((s, c) => s + Number(c.claimedAmount), 0);
    if (claimedSoFar + dto.claimedAmount > Number(agreement.amount) + 1e-9) {
      throw new BadRequestException(
        `Claim exceeds agreement: claimed ${claimedSoFar} + ${dto.claimedAmount} > ${Number(agreement.amount)}`,
      );
    }

    const vatAmount = round2(dto.claimedAmount * (VAT_RATE / 100));
    const retention = round2(dto.claimedAmount * (Number(agreement.retentionPct) / 100));
    const netPayable = round2(dto.claimedAmount + vatAmount - retention);
    const sequence = agreement.claims.length + 1;

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'CLAIM', tx);
      const claim = await tx.progressClaim.create({
        data: {
          organizationId: user.organizationId,
          code,
          agreementId,
          sequence,
          descriptionAr: dto.descriptionAr,
          descriptionEn: dto.descriptionEn,
          claimedAmount: dto.claimedAmount,
          vatAmount,
          retentionWithheld: retention,
          netPayable,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProgressClaim',
          entityId: claim.id,
          action: 'CREATE',
          after: { code, claimedAmount: dto.claimedAmount, retention },
        },
        tx,
      );
      return claim;
    });
  }

  /**
   * Approval posts the back-to-back accounting: SUBCONTRACT actual cost on the
   * project, and the AP journal — Dr WIP + Dr VAT input / Cr AP (net) + Cr
   * subcontractor retention payable (2050).
   */
  async approveClaim(user: AuthUser, claimId: string) {
    const claim = await this.prisma.progressClaim.findFirst({
      where: { id: claimId, organizationId: user.organizationId },
      include: { agreement: { include: { vendor: true } } },
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.status !== 'SUBMITTED') {
      throw new BadRequestException('Only submitted claims can be approved');
    }

    const claimed = Number(claim.claimedAmount);
    const vat = Number(claim.vatAmount);
    const retention = Number(claim.retentionWithheld);
    const net = Number(claim.netPayable);

    const accounts = await this.prisma.account.findMany({
      where: { organizationId: user.organizationId, code: { in: ['1300', '1400', '2000', '2050'] } },
    });
    const acc = (code: string) => {
      const a = accounts.find((x) => x.code === code);
      if (!a) throw new BadRequestException(`Missing GL account ${code} — re-run the seed`);
      return a.id;
    };

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.progressClaim.update({
        where: { id: claim.id },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedById: user.userId },
      });

      await tx.projectCostEntry.create({
        data: {
          organizationId: user.organizationId,
          projectId: claim.agreement.projectId,
          wbsElementId: claim.agreement.wbsElementId,
          costType: 'SUBCONTRACT',
          sourceType: 'ProgressClaim',
          sourceId: claim.id,
          amount: claimed,
          memo: `${claim.code} · ${claim.agreement.code} (${claim.agreement.vendor.nameEn})`,
        },
      });

      const lines = [
        { accountId: acc('1300'), debit: claimed, credit: 0 },
        { accountId: acc('1400'), debit: vat, credit: 0 },
        { accountId: acc('2000'), debit: 0, credit: net },
      ];
      if (retention > 0) lines.push({ accountId: acc('2050'), debit: 0, credit: retention });
      await tx.journalEntry.create({
        data: {
          organizationId: user.organizationId,
          sourceType: 'ProgressClaim',
          sourceId: claim.id,
          memo: `Progress claim ${claim.code} — ${claim.agreement.vendor.nameEn}`,
          lines: { create: lines.map((l) => ({ ...l, currency: 'SAR' })) },
        },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProgressClaim',
          entityId: claim.id,
          action: 'APPROVE',
          after: { claimed, vat, retention, net },
        },
        tx,
      );
      return updated;
    });
  }

  // ── Locations, stock levels & transfers (SCM-04) ──────────────────────────

  listLocations(user: AuthUser) {
    return this.prisma.location.findMany({
      where: { organizationId: user.organizationId },
      include: {
        project: { select: { code: true } },
        _count: { select: { serialUnits: true } },
      },
      orderBy: { code: 'asc' },
    });
  }

  listStock(user: AuthUser) {
    return this.prisma.stockLevel.findMany({
      where: { organizationId: user.organizationId, qty: { gt: 0 } },
      include: {
        item: { select: { sku: true, nameAr: true, nameEn: true, uom: true } },
        location: { select: { code: true, nameAr: true, nameEn: true, locationType: true } },
      },
      orderBy: [{ location: { code: 'asc' } }, { item: { sku: 'asc' } }],
    });
  }

  /** Move a serial unit or a bulk quantity between locations. */
  async transfer(user: AuthUser, dto: TransferDto) {
    const to = await this.prisma.location.findFirst({
      where: { id: dto.toLocationId, organizationId: user.organizationId },
    });
    if (!to) throw new NotFoundException('Destination location not found');

    if (dto.serialUnitId) {
      const unit = await this.prisma.serialUnit.findFirst({
        where: { id: dto.serialUnitId, organizationId: user.organizationId },
      });
      if (!unit) throw new NotFoundException('Serial unit not found');
      if (unit.currentState !== 'IN_STOCK') {
        throw new BadRequestException(`Serial is ${unit.currentState} — only IN_STOCK stock moves`);
      }
      if (unit.locationId === to.id) throw new BadRequestException('Serial is already at that location');

      return this.prisma.$transaction(async (tx) => {
        const moved = await tx.serialUnit.update({
          where: { id: unit.id },
          data: { locationId: to.id },
        });
        await tx.stockMovement.create({
          data: {
            organizationId: user.organizationId,
            itemId: unit.itemId,
            serialUnitId: unit.id,
            fromLocationId: unit.locationId,
            toLocationId: to.id,
            qty: 1,
            movementType: 'TRANSFER',
          },
        });
        return moved;
      });
    }

    // Bulk transfer.
    if (!dto.itemId || !dto.qty || !dto.fromLocationId) {
      throw new BadRequestException('Bulk transfer needs itemId, qty and fromLocationId');
    }
    if (dto.fromLocationId === to.id) throw new BadRequestException('Source equals destination');
    const level = await this.prisma.stockLevel.findFirst({
      where: {
        organizationId: user.organizationId,
        itemId: dto.itemId,
        locationId: dto.fromLocationId,
      },
    });
    if (!level || Number(level.qty) < dto.qty - 1e-9) {
      throw new BadRequestException(
        `Insufficient stock at source: have ${Number(level?.qty ?? 0)}, moving ${dto.qty}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.stockLevel.update({
        where: { id: level.id },
        data: { qty: { decrement: dto.qty } },
      });
      await tx.stockLevel.upsert({
        where: {
          organizationId_itemId_locationId: {
            organizationId: user.organizationId,
            itemId: dto.itemId!,
            locationId: to.id,
          },
        },
        update: { qty: { increment: dto.qty } },
        create: {
          organizationId: user.organizationId,
          itemId: dto.itemId!,
          locationId: to.id,
          qty: dto.qty!,
        },
      });
      return tx.stockMovement.create({
        data: {
          organizationId: user.organizationId,
          itemId: dto.itemId!,
          fromLocationId: dto.fromLocationId,
          toLocationId: to.id,
          qty: dto.qty!,
          movementType: 'TRANSFER',
        },
      });
    });
  }

  /**
   * AST-01: installation flips the serial from stock into an operating asset.
   * The asset register row is created here — under the project's PLANT root
   * (created on first install) — so work orders and warranties can hang off it.
   */
  async installSerialUnit(user: AuthUser, id: string) {
    const unit = await this.prisma.serialUnit.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { item: true, asset: { select: { id: true } } },
    });
    if (!unit) throw new NotFoundException('Serial unit not found');
    if (unit.currentState !== 'IN_STOCK') {
      throw new BadRequestException(`Serial is ${unit.currentState}, only IN_STOCK can be installed`);
    }

    const assetTypeByCategory: Record<string, 'MODULE' | 'INVERTER' | 'EQUIPMENT'> = {
      MODULE: 'MODULE',
      INVERTER: 'INVERTER',
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const installed = await tx.serialUnit.update({
        where: { id },
        data: { currentState: 'INSTALLED', installedAt: new Date() },
      });

      if (!unit.asset) {
        // PLANT root per project (or org-level for stockless installs).
        let plant = await tx.asset.findFirst({
          where: {
            organizationId: user.organizationId,
            assetType: 'PLANT',
            projectId: unit.projectId ?? null,
          },
        });
        if (!plant) {
          const plantCode = await this.numbering.next(user.organizationId, 'ASSET', tx);
          const project = unit.projectId
            ? await tx.project.findUnique({ where: { id: unit.projectId }, select: { nameAr: true, nameEn: true } })
            : null;
          plant = await tx.asset.create({
            data: {
              organizationId: user.organizationId,
              code: plantCode,
              assetType: 'PLANT',
              projectId: unit.projectId,
              nameAr: project ? `محطة — ${project.nameAr}` : 'محطة عامة',
              nameEn: project ? `Plant — ${project.nameEn}` : 'General plant',
            },
          });
        }

        const code = await this.numbering.next(user.organizationId, 'ASSET', tx);
        await tx.asset.create({
          data: {
            organizationId: user.organizationId,
            code,
            parentAssetId: plant.id,
            projectId: unit.projectId,
            assetType: assetTypeByCategory[unit.item.itemCategory] ?? 'EQUIPMENT',
            nameAr: `${unit.item.nameAr} — ${unit.serialNo}`,
            nameEn: `${unit.item.nameEn} — ${unit.serialNo}`,
            serialUnitId: unit.id,
            installDate: new Date(),
          },
        });
      }

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'SerialUnit',
          entityId: id,
          action: 'INSTALL',
          before: { currentState: 'IN_STOCK' },
          after: { currentState: 'INSTALLED', assetCreated: !unit.asset },
        },
        tx,
      );
      return installed;
    });
    return updated;
  }
}
