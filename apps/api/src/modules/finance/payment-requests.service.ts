import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@npi/db';
import { PERMISSIONS } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { ApprovalService } from '../../common/approval.service';
import { NotificationService } from '../../common/notification.service';
import { PostingService } from '../../common/posting.service';
import { PayablesService } from './payables.service';
import type { AuthUser } from '../../common/auth-user';
import type { CreatePaymentRequestDto, PayRequestDto } from './field-money.dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Package 6 · P6-1 (ADR-06) — «طلب صرف دفعة للموردين». The engineer raises it
 * (an advance, or a payment against an approved bill); the projects GM and
 * the general manager sign it (VENDOR_PAYMENT_REQUEST); the accountant pays:
 * an advance posts Dr advances to suppliers / Cr bank, a bill payment goes
 * through the ordinary payables run. Applying an advance to the vendor's
 * later bill is left to the accountant's journal for now (ADR-06 §4).
 */
@Injectable()
export class PaymentRequestsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
    private readonly posting: PostingService,
    private readonly payables: PayablesService,
  ) {}

  onModuleInit(): void {
    this.approvals.register(
      'VENDOR_PAYMENT_REQUEST',
      (user, id) => this.decide(user, id, 'APPROVED'),
      (user, id, note) => this.decide(user, id, 'REJECTED', note),
    );
  }

  async list(user: AuthUser, status?: string) {
    const mineOnly = !this.canSeeAll(user);
    const rows = await this.prisma.vendorPaymentRequest.findMany({
      where: {
        organizationId: user.organizationId,
        status: (status as never) || undefined,
        ...(mineOnly ? { requestedById: user.userId } : {}),
      },
      include: {
        vendor: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        project: { select: { id: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return rows;
  }

  async get(user: AuthUser, id: string) {
    const r = await this.prisma.vendorPaymentRequest.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        vendor: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        project: { select: { id: true, code: true, nameAr: true, nameEn: true } },
      },
    });
    if (!r) throw new NotFoundException('Payment request not found');
    if (!this.canSeeAll(user) && r.requestedById !== user.userId) throw new NotFoundException('Payment request not found');
    const [chain, bill] = await Promise.all([
      this.approvals.forDocument(user, 'VENDOR_PAYMENT_REQUEST', r.id),
      r.vendorBillId
        ? this.prisma.vendorBill.findFirst({ where: { id: r.vendorBillId }, select: { id: true, code: true, total: true, status: true } })
        : Promise.resolve(null),
    ]);
    return { ...r, bill, approval: chain };
  }

  async create(user: AuthUser, dto: CreatePaymentRequestDto) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: dto.vendorId, organizationId: user.organizationId },
      select: { id: true, nameEn: true },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (dto.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: dto.projectId, organizationId: user.organizationId } });
      if (!p) throw new NotFoundException('Project not found');
    }
    if (dto.kind === 'AGAINST_BILL') {
      if (!dto.vendorBillId) throw new BadRequestException('Name the bill this payment is against');
      const open = (await this.payables.outstanding(user, dto.vendorId)).find(
        (r) => r.kind === 'BILL' && r.id === dto.vendorBillId,
      );
      if (!open) throw new BadRequestException('That bill is not an approved, unpaid bill of this vendor');
      const already = await this.prisma.vendorPaymentRequest.aggregate({
        where: { vendorBillId: dto.vendorBillId, status: { in: ['PENDING', 'APPROVED'] } },
        _sum: { amount: true },
      });
      const room = round2(open.outstanding - Number(already._sum.amount ?? 0));
      if (dto.amount > room + 0.005) {
        throw new BadRequestException(`Only ${room} of ${open.code} is left to request`);
      }
    }

    const req = await this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'VENDOR_PAYMENT_REQUEST', tx);
      const row = await tx.vendorPaymentRequest.create({
        data: {
          organizationId: user.organizationId,
          code,
          vendorId: vendor.id,
          projectId: dto.projectId ?? null,
          kind: dto.kind,
          vendorBillId: dto.kind === 'AGAINST_BILL' ? dto.vendorBillId! : null,
          purchaseOrderId: dto.purchaseOrderId ?? null,
          amount: dto.amount,
          reason: dto.reason.trim(),
          requestedById: user.userId,
        },
      });
      await this.record(tx, user, row.id, 'REQUEST', null, { code, kind: dto.kind, amount: dto.amount });
      return row;
    });

    const verdict = await this.approvals.gate(user, {
      documentType: 'VENDOR_PAYMENT_REQUEST',
      documentId: req.id,
      documentCode: req.code,
      amount: dto.amount,
      departmentId: null,
    });
    if (verdict.cleared) {
      await this.prisma.vendorPaymentRequest.delete({ where: { id: req.id } });
      throw new ConflictException(
        'No approval rule routes vendor payment requests — the administrator must set the VENDOR_PAYMENT_REQUEST rule',
      );
    }
    return { ...req, approval: verdict.request };
  }

  /** The accountant pays an approved request. */
  async pay(user: AuthUser, id: string, dto: PayRequestDto) {
    const r = await this.prisma.vendorPaymentRequest.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { vendor: { select: { nameEn: true } } },
    });
    if (!r) throw new NotFoundException('Payment request not found');
    if (r.status !== 'APPROVED') throw new ConflictException('Only an approved request is paid');
    if (r.requestedById === user.userId) throw new ForbiddenException('The requester does not pay their own request');

    let vendorPaymentId: string;
    if (r.kind === 'AGAINST_BILL') {
      const payment = await this.payables.pay(user, {
        vendorId: r.vendorId,
        allocations: [{ kind: 'BILL', documentId: r.vendorBillId!, amount: Number(r.amount) }],
        method: dto.method,
        reference: dto.reference,
        memo: `Payment request ${r.code}`,
      } as never);
      vendorPaymentId = payment.id;
      await this.prisma.vendorPaymentRequest.update({
        where: { id: r.id },
        data: { status: 'PAID', paidAt: new Date(), paidById: user.userId, paymentRef: dto.reference ?? null, vendorPaymentId },
      });
    } else {
      const acc = await this.posting.accounts(user.organizationId, ['VENDOR_ADVANCE', 'BANK'] as const);
      vendorPaymentId = await this.prisma.$transaction(async (tx) => {
        const code = await this.numbering.next(user.organizationId, 'VENDOR_PAYMENT', tx);
        const payment = await tx.vendorPayment.create({
          data: {
            organizationId: user.organizationId,
            code,
            vendorId: r.vendorId,
            amount: r.amount,
            method: dto.method ?? 'BANK_TRANSFER',
            reference: dto.reference,
            memo: `Advance — payment request ${r.code}`,
          },
        });
        await this.posting.journal(tx, {
          organizationId: user.organizationId,
          sourceType: 'VendorPaymentRequest',
          sourceId: r.id,
          projectId: r.projectId,
          memo: `Advance to ${r.vendor.nameEn} — ${r.code}`,
          lines: [
            { accountId: acc.VENDOR_ADVANCE, debit: Number(r.amount), credit: 0 },
            { accountId: acc.BANK, debit: 0, credit: Number(r.amount) },
          ],
        });
        await tx.vendorPaymentRequest.update({
          where: { id: r.id },
          data: { status: 'PAID', paidAt: new Date(), paidById: user.userId, paymentRef: dto.reference ?? null, vendorPaymentId: payment.id },
        });
        await this.record(tx, user, r.id, 'PAY', { status: 'APPROVED' }, { status: 'PAID', payment: code });
        return payment.id;
      });
    }
    await this.notifications.notifyUserBestEffort({
      organizationId: user.organizationId,
      userId: r.requestedById,
      type: 'PAYMENT_REQUEST_PAID',
      titleAr: `صُرفت الدفعة ${r.code}`,
      titleEn: `Payment request ${r.code} paid`,
      linkPath: `/projects/payment-requests/${r.id}`,
    });
    return this.get(user, r.id);
  }

  private async decide(user: AuthUser, id: string, status: 'APPROVED' | 'REJECTED', note?: string) {
    const r = await this.prisma.vendorPaymentRequest.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!r || r.status !== 'PENDING') return null;
    await this.prisma.$transaction(async (tx) => {
      await tx.vendorPaymentRequest.update({
        where: { id: r.id },
        data: { status, decidedAt: new Date(), decisionNote: note?.trim() || null },
      });
      await this.record(tx, user, r.id, status === 'APPROVED' ? 'APPROVE' : 'REJECT', { status: 'PENDING' }, { status, note });
    });
    if (status === 'APPROVED') {
      await this.notifications.notifyBestEffort({
        organizationId: user.organizationId,
        permission: PERMISSIONS.PAYMENT_WRITE,
        type: 'PAYMENT_REQUEST_APPROVED',
        titleAr: `طلب صرف معتمد بانتظار السداد: ${r.code} (${Number(r.amount).toLocaleString('en-US')} ريال)`,
        titleEn: `Approved payment request awaiting payment: ${r.code} (SAR ${Number(r.amount).toLocaleString('en-US')})`,
        linkPath: '/payables',
      });
    }
    await this.notifications.notifyUserBestEffort({
      organizationId: user.organizationId,
      userId: r.requestedById,
      type: status === 'APPROVED' ? 'PAYMENT_REQUEST_APPROVED' : 'PAYMENT_REQUEST_REJECTED',
      titleAr: status === 'APPROVED' ? `اعتُمد طلب الصرف ${r.code}` : `رُفض طلب الصرف ${r.code}`,
      titleEn: status === 'APPROVED' ? `Payment request ${r.code} approved` : `Payment request ${r.code} rejected`,
      bodyAr: note,
      bodyEn: note,
      linkPath: `/projects/payment-requests/${r.id}`,
    });
    return { status };
  }

  /** Signers and the accountant see every request; the engineer sees his own. */
  private canSeeAll(user: AuthUser) {
    return [PERMISSIONS.PAYMENT_READ, PERMISSIONS.PROCUREMENT_APPROVE].some((k) => user.permissions.includes(k));
  }

  private record(tx: Prisma.TransactionClient, user: AuthUser, id: string, action: string, before: unknown, after: unknown) {
    return this.audit.record(
      { organizationId: user.organizationId, actorId: user.userId, entityType: 'VendorPaymentRequest', entityId: id, action, before, after },
      tx,
    );
  }
}
