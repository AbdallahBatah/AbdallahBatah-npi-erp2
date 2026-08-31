import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { PostingService } from '../../common/posting.service';
import { BILL_STATUSES_WITH_AP_BALANCE, WF_ACTIONS, WF_EVENTS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import type { Prisma } from '@npi/db';
import type { PayVendorDto } from './dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Money compares are never exact — settle within half a halala. */
const EPS = 0.009;

export type PayableKind = 'BILL' | 'CLAIM';

export interface PayableRow {
  kind: PayableKind;
  id: string;
  code: string;
  vendor: { id: string; code: string; nameAr: string; nameEn: string };
  documentDate: Date;
  /** Gross amount owed, including retention once it has been released. */
  due: number;
  paid: number;
  outstanding: number;
  /** Retention still withheld — not payable until released. */
  retentionWithheld: number;
  retentionReleased: boolean;
}

/**
 * The payables side of the cash cycle.
 *
 * Vendor bills and approved subcontractor claims credited AP and nothing ever
 * debited it, so payables grew without bound and the bank account only ever
 * received money. This settles them:
 *   payment          Dr AP / Cr Bank
 *   retention release Dr Retention Payable / Cr AP  (then paid as normal)
 */
@Injectable()
export class PayablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
  ) {}

  // ── Open items ────────────────────────────────────────────────────────────

  /**
   * Everything the organization still owes, oldest first. A bill is due in
   * full; a claim is due net of retention until that retention is released.
   */
  async outstanding(user: AuthUser, vendorId?: string): Promise<PayableRow[]> {
    const [bills, claims] = await Promise.all([
      this.prisma.vendorBill.findMany({
        where: {
          organizationId: user.organizationId,
          // M4: asked, not hardcoded. A bill carries an AP balance from the
          // moment its liability is accepted (APPROVED) — plus POSTED, which
          // is what that meant for rows written before M4.
          status: { in: [...BILL_STATUSES_WITH_AP_BALANCE] as never[] },
          ...(vendorId ? { vendorId } : {}),
        },
        include: {
          vendor: { select: { id: true, code: true, nameAr: true, nameEn: true } },
          paymentAllocations: { select: { amount: true } },
        },
      }),
      this.prisma.progressClaim.findMany({
        where: {
          organizationId: user.organizationId,
          status: { in: ['APPROVED', 'PAID'] },
          ...(vendorId ? { agreement: { vendorId } } : {}),
        },
        include: {
          agreement: {
            select: {
              vendor: { select: { id: true, code: true, nameAr: true, nameEn: true } },
            },
          },
          paymentAllocations: { select: { amount: true } },
        },
      }),
    ]);

    const rows: PayableRow[] = [
      ...bills.map((b) => {
        const due = Number(b.total);
        const paid = round2(b.paymentAllocations.reduce((s, a) => s + Number(a.amount), 0));
        return {
          kind: 'BILL' as const,
          id: b.id,
          code: b.code,
          vendor: b.vendor,
          documentDate: b.billDate,
          due,
          paid,
          outstanding: round2(due - paid),
          retentionWithheld: 0,
          retentionReleased: false,
        };
      }),
      ...claims.map((c) => {
        const retention = Number(c.retentionWithheld);
        const released = c.retentionReleasedAt !== null;
        const due = round2(Number(c.netPayable) + (released ? retention : 0));
        const paid = round2(c.paymentAllocations.reduce((s, a) => s + Number(a.amount), 0));
        return {
          kind: 'CLAIM' as const,
          id: c.id,
          code: c.code,
          vendor: c.agreement.vendor,
          documentDate: c.approvedAt ?? c.createdAt,
          due,
          paid,
          outstanding: round2(due - paid),
          retentionWithheld: released ? 0 : retention,
          retentionReleased: released,
        };
      }),
    ];

    return rows.sort((a, b) => a.documentDate.getTime() - b.documentDate.getTime());
  }

  listPayments(user: AuthUser, vendorId?: string) {
    return this.prisma.vendorPayment.findMany({
      where: { organizationId: user.organizationId, ...(vendorId ? { vendorId } : {}) },
      include: {
        vendor: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        allocations: {
          include: {
            vendorBill: { select: { id: true, code: true } },
            progressClaim: { select: { id: true, code: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Pay ───────────────────────────────────────────────────────────────────

  /**
   * Settle one or more of a vendor's open documents in a single payment:
   * Dr AP (total) / Cr Bank (total). Every allocation is validated against the
   * document's *current* outstanding balance before anything is written, so a
   * partially-valid batch never posts.
   */
  async pay(user: AuthUser, dto: PayVendorDto) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, organizationId: user.organizationId },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (!dto.allocations?.length) {
      throw new BadRequestException('Payment needs at least one allocation');
    }

    const open = await this.outstanding(user, dto.vendorId);
    const byKey = new Map(open.map((r) => [`${r.kind}:${r.id}`, r]));

    let total = 0;
    for (const alloc of dto.allocations) {
      const row = byKey.get(`${alloc.kind}:${alloc.documentId}`);
      if (!row) {
        throw new BadRequestException(
          `Document ${alloc.documentId} is not an open payable for this vendor`,
        );
      }
      if (alloc.amount <= 0) throw new BadRequestException('Allocation amount must be positive');
      if (alloc.amount > row.outstanding + EPS) {
        throw new BadRequestException(
          `Allocation for ${row.code} exceeds its outstanding balance ${row.outstanding}`,
        );
      }
      total = round2(total + alloc.amount);
    }

    const acc = await this.posting.accounts(user.organizationId, ['AP', 'BANK'] as const);

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'VENDOR_PAYMENT', tx);
      const payment = await tx.vendorPayment.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: dto.vendorId,
          amount: total,
          method: dto.method ?? 'BANK_TRANSFER',
          reference: dto.reference,
          memo: dto.memo,
          allocations: {
            create: dto.allocations.map((a) => ({
              vendorBillId: a.kind === 'BILL' ? a.documentId : null,
              progressClaimId: a.kind === 'CLAIM' ? a.documentId : null,
              amount: a.amount,
            })),
          },
        },
        include: { allocations: true },
      });

      await this.posting.journal(tx, {
        organizationId: user.organizationId,
        sourceType: 'VendorPayment',
        sourceId: payment.id,
        memo: `Vendor payment ${code} — ${vendor.nameEn}`,
        lines: [
          { accountId: acc.AP, debit: total, credit: 0 },
          { accountId: acc.BANK, debit: 0, credit: total },
        ],
      });

      // Flip each fully-settled document to PAID.
      for (const alloc of dto.allocations) {
        const row = byKey.get(`${alloc.kind}:${alloc.documentId}`)!;
        const settled = row.paid + alloc.amount >= row.due - EPS;
        if (!settled) continue;
        if (alloc.kind === 'BILL') {
          // M4: the bill's own flow records the move. Written here inside the
          // payment transaction rather than through the engine's own one,
          // because a payment that commits while its document stays unpaid is
          // the worse failure — and the flow's history is appended alongside
          // it, so the trail stays complete either way.
          await tx.vendorBill.update({ where: { id: alloc.documentId }, data: { status: 'PAID' } });
          await this.closeBillFlow(tx, user, alloc.documentId);
        } else {
          await tx.progressClaim.update({
            where: { id: alloc.documentId },
            data: { status: 'PAID' },
          });
        }
      }

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'VendorPayment',
          entityId: payment.id,
          action: 'PAY',
          after: { code, vendorId: dto.vendorId, total, allocations: dto.allocations },
        },
        tx,
      );

      return payment;
    });
  }

  // ── Subcontractor retention release ───────────────────────────────────────

  /**
   * Release the retention withheld from a subcontractor claim: the liability
   * moves from retention payable into ordinary AP — Dr Retention Payable /
   * Cr AP — and the amount becomes payable through the normal payment run.
   * A claim already marked PAID reopens, exactly as the customer-side release
   * reopens a settled invoice.
   */
  async releaseClaimRetention(user: AuthUser, claimId: string) {
    const claim = await this.prisma.progressClaim.findFirst({
      where: { id: claimId, organizationId: user.organizationId },
      include: { agreement: { select: { projectId: true, vendor: { select: { nameEn: true } } } } },
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.status !== 'APPROVED' && claim.status !== 'PAID') {
      throw new BadRequestException(`Cannot release retention on a ${claim.status} claim`);
    }
    if (claim.retentionReleasedAt) throw new BadRequestException('Retention is already released');

    const amount = Number(claim.retentionWithheld);
    if (amount <= 0) throw new BadRequestException('This claim withheld no retention');

    const acc = await this.posting.accounts(user.organizationId, [
      'RETENTION_PAYABLE',
      'AP',
    ] as const);

    return this.prisma.$transaction(async (tx) => {
      await this.posting.journal(tx, {
        organizationId: user.organizationId,
        sourceType: 'SubcontractRetentionRelease',
        sourceId: claim.id,
        projectId: claim.agreement.projectId,
        memo: `Subcontractor retention release for ${claim.code} — ${claim.agreement.vendor.nameEn}`,
        lines: [
          { accountId: acc.RETENTION_PAYABLE, debit: amount, credit: 0 },
          { accountId: acc.AP, debit: 0, credit: amount },
        ],
      });

      const updated = await tx.progressClaim.update({
        where: { id: claim.id },
        // The released amount is now collectible by the subcontractor, so a
        // claim that was fully paid owes money again.
        data: { retentionReleasedAt: new Date(), status: 'APPROVED' },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'ProgressClaim',
          entityId: claim.id,
          action: 'RELEASE_RETENTION',
          after: { amount },
        },
        tx,
      );

      return updated;
    });
  }
  /**
   * Append the vendor bill's PAY move to its own workflow trail.
   *
   * The engine is not called here on purpose, and the reason is worth stating:
   * `engine.transition()` opens its own transaction, and this move must commit
   * or roll back with the payment that caused it. A payment recorded against a
   * bill left SCHEDULED is a worse outcome than a trail written by hand — so
   * the history row and the instance update happen inline, in the payment's
   * transaction, with the same shape the engine writes.
   *
   * If the bill predates M4 and has no instance, there is nothing to append:
   * its status is still correct, and inventing a flow for it would be a lie
   * about a document that never travelled through one.
   */
  private async closeBillFlow(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    vendorBillId: string,
  ): Promise<void> {
    const instance = await tx.wfInstance.findFirst({
      where: {
        organizationId: user.organizationId,
        documentType: 'VendorBill',
        documentId: vendorBillId,
        closedAt: null,
      },
      select: { id: true, currentState: true },
    });
    if (!instance) return;

    await tx.wfInstance.update({
      where: { id: instance.id },
      data: { currentState: 'PAID', assigneeRoleId: null, closedAt: new Date() },
    });
    await tx.wfHistory.create({
      data: {
        instanceId: instance.id,
        fromState: instance.currentState,
        toState: 'PAID',
        actionCode: WF_ACTIONS.PAY,
        actorId: user.userId,
        comment: null,
      },
    });
    await tx.domainEvent.create({
      data: {
        organizationId: user.organizationId,
        eventCode: WF_EVENTS.INVOICE_PAID,
        payloadJson: {
          documentType: 'VendorBill',
          documentId: vendorBillId,
          fromState: instance.currentState,
          toState: 'PAID',
          actorId: user.userId,
        },
      },
    });
  }
}
