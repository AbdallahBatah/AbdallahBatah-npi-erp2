import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { PostingService } from '../../common/posting.service';
import { TaxService } from '../../common/tax.service';
import { ZatcaService } from './zatca.service';
import type { AuthUser } from '../../common/auth-user';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly tax: TaxService,
    private readonly zatca: ZatcaService,
  ) {}

  private standardVatRate(organizationId: string): Promise<{ id: string; rate: number }> {
    return this.tax.standardVat(organizationId);
  }

  list(user: AuthUser) {
    return this.prisma.invoice.findMany({
      where: { organizationId: user.organizationId },
      include: {
        customer: { select: { id: true, code: true, nameAr: true, nameEn: true } },
        contract: { select: { id: true, code: true } },
        eInvoice: { select: { uuid: true, authorityStatus: true, submissionMode: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(user: AuthUser, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId: user.organizationId },
      include: {
        customer: true,
        contract: { select: { id: true, code: true, retentionPct: true } },
        lines: { include: { taxCode: true } },
        eInvoice: true,
        retentionEntry: true,
        payments: { orderBy: { receivedAt: 'asc' } },
        journalEntries: {
          include: { lines: { include: { account: true } } },
          orderBy: { postingDate: 'asc' },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    // Render the ZATCA QR TLV to a scannable PNG data URL for the UI.
    let qrDataUrl: string | null = null;
    if (invoice.eInvoice) {
      // Lazy import keeps qrcode out of the hot path when there is no e-invoice.
      const QRCode = await import('qrcode');
      qrDataUrl = await QRCode.toDataURL(invoice.eInvoice.qrTlv, { margin: 1, width: 220 });
    }
    return { ...invoice, qrDataUrl };
  }

  /**
   * FIN-04: generate a draft tax invoice from a VERIFIED milestone.
   * Applies 15% VAT (FIN-03) and withholds contract retention (FIN-13).
   */
  async generateFromMilestone(user: AuthUser, contractId: string, milestoneId: string) {
    const milestone = await this.prisma.contractMilestone.findFirst({
      where: {
        id: milestoneId,
        contractId,
        contract: { organizationId: user.organizationId },
      },
      include: { contract: true },
    });
    if (!milestone) throw new NotFoundException('Milestone not found');
    if (milestone.status !== 'VERIFIED') {
      throw new BadRequestException('Milestone must be VERIFIED before invoicing');
    }
    if (milestone.invoiceId) {
      throw new BadRequestException('Milestone is already invoiced');
    }

    const { id: taxCodeId, rate } = await this.standardVatRate(user.organizationId);
    const subtotal = round2(Number(milestone.amount));
    const vatAmount = round2(subtotal * (rate / 100));
    const retentionPct = Number(milestone.contract.retentionPct);
    const retentionAmount = round2(subtotal * (retentionPct / 100));
    const total = round2(subtotal + vatAmount);
    const netPayable = round2(total - retentionAmount);

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'INVOICE', tx);
      const invoice = await tx.invoice.create({
        data: {
          organizationId: user.organizationId,
          code,
          invoiceType: 'MILESTONE',
          customerId: milestone.contract.customerId,
          contractId: milestone.contractId,
          currency: milestone.contract.currency,
          subtotal,
          vatAmount,
          retentionAmount,
          total,
          netPayable,
          status: 'DRAFT',
          lines: {
            create: [
              {
                descriptionAr: milestone.descriptionAr,
                descriptionEn: milestone.descriptionEn,
                qty: 1,
                unitPrice: subtotal,
                taxCodeId: taxCodeId || undefined,
                lineSubtotal: subtotal,
                vatAmount,
              },
            ],
          },
        },
      });

      await tx.contractMilestone.update({
        where: { id: milestone.id },
        data: { status: 'INVOICED', invoiceId: invoice.id },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Invoice',
          entityId: invoice.id,
          action: 'CREATE',
          after: { code, subtotal, vatAmount, retentionAmount, total, netPayable },
        },
        tx,
      );

      return invoice;
    });
  }

  /**
   * FIN-02 + FIN-01: issue the invoice — produce the ZATCA e-invoice (hash
   * chain, QR, stamp), post the balanced double-entry journal, and open a
   * retention ledger entry.
   */
  async issue(user: AuthUser, invoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId: user.organizationId },
      include: { lines: true, customer: true, organization: true, eInvoice: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status !== 'DRAFT') {
      throw new BadRequestException('Only draft invoices can be issued');
    }

    const subtotal = Number(invoice.subtotal);
    const vatTotal = Number(invoice.vatAmount);
    const grandTotal = Number(invoice.total);
    const { rate } = await this.standardVatRate(user.organizationId);

    // Resolve posting accounts by purpose (see PostingService).
    const acc = await this.posting.accounts(user.organizationId, [
      'AR',
      'RETENTION_RECEIVABLE',
      'VAT_OUTPUT',
      'REVENUE',
    ] as const);

    const retentionAmount = Number(invoice.retentionAmount);
    const netPayable = Number(invoice.netPayable);

    const journalLines: Array<{ accountId: string; debit: number; credit: number }> = [
      { accountId: acc.AR, debit: netPayable, credit: 0 }, // AR (due now)
    ];
    if (retentionAmount > 0) {
      journalLines.push({ accountId: acc.RETENTION_RECEIVABLE, debit: retentionAmount, credit: 0 });
    }
    journalLines.push({ accountId: acc.REVENUE, debit: 0, credit: subtotal });
    journalLines.push({ accountId: acc.VAT_OUTPUT, debit: 0, credit: vatTotal });

    await this.prisma.$transaction(async (tx) => {
      // Chain to the previous e-invoice hash (PIH) *inside* the transaction so
      // two concurrent issues cannot both chain onto the same predecessor.
      // The serializable isolation level makes the read-then-append atomic.
      const prev = await tx.eInvoiceDocument.findFirst({
        where: { invoice: { organizationId: user.organizationId } },
        orderBy: { submittedAt: 'desc' },
        select: { invoiceHash: true },
      });

      const zatca = this.zatca.generate(user.organizationId, {
        invoiceCode: invoice.code,
        issuedAt: invoice.issueDate,
        currency: invoice.currency,
        lines: invoice.lines.map((l) => ({
          descriptionEn: l.descriptionEn,
          qty: Number(l.qty),
          unitPrice: Number(l.unitPrice),
          vatRate: rate,
        })),
        subtotal,
        vatTotal,
        grandTotal,
        parties: {
          sellerNameAr: invoice.organization.legalNameAr,
          sellerNameEn: invoice.organization.legalNameEn,
          sellerVat: invoice.organization.vatNumber ?? '',
          buyerNameAr: invoice.customer.nameAr,
          buyerNameEn: invoice.customer.nameEn,
          buyerVat: invoice.customer.vatNumber,
        },
        previousInvoiceHash: prev?.invoiceHash ?? null,
      });

      await tx.eInvoiceDocument.create({
        data: {
          invoiceId: invoice.id,
          uuid: zatca.uuid,
          invoiceHash: zatca.invoiceHash,
          previousInvoiceHash: zatca.previousInvoiceHash,
          qrTlv: zatca.qrTlv,
          cryptographicStamp: zatca.cryptographicStamp,
          publicKey: zatca.publicKey,
          xmlPayload: zatca.xml,
          submissionMode: zatca.submissionMode,
          authorityStatus: zatca.authorityStatus,
          authorityResponseRef: zatca.authorityResponseRef,
          isSimulated: zatca.isSimulated,
        },
      });

      await this.posting.journal(tx, {
        organizationId: user.organizationId,
        sourceType: 'Invoice',
        sourceId: invoice.id,
        invoiceId: invoice.id,
        memo: `Milestone invoice ${invoice.code}`,
        lines: journalLines.map((l) => ({ ...l, currency: invoice.currency })),
      });

      if (retentionAmount > 0 && invoice.contractId) {
        await tx.retentionEntry.create({
          data: {
            organizationId: user.organizationId,
            contractId: invoice.contractId,
            invoiceId: invoice.id,
            withheldAmount: retentionAmount,
            status: 'WITHHELD',
          },
        });
      }

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'CLEARED' },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Invoice',
          entityId: invoice.id,
          action: 'ISSUE_CLEAR',
          after: { uuid: zatca.uuid, invoiceHash: zatca.invoiceHash, authorityStatus: zatca.authorityStatus },
        },
        tx,
      );
    }, { isolationLevel: 'Serializable' });

    return this.get(user, invoice.id);
  }

  // ── Payments & retention release (W7) ─────────────────────────────────────

  /** Customer payment: Dr Bank (1000) / Cr AR (1100); invoice → PAID when settled. */
  async addPayment(
    user: AuthUser,
    invoiceId: string,
    dto: { amount: number; method?: 'BANK_TRANSFER' | 'CHEQUE' | 'CASH'; reference?: string },
  ) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId: user.organizationId },
      include: { payments: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (!['ISSUED', 'CLEARED'].includes(invoice.status)) {
      throw new BadRequestException(`Cannot receive payment on a ${invoice.status} invoice`);
    }
    if (!dto.amount || dto.amount <= 0) throw new BadRequestException('Amount must be positive');

    const paidSoFar = round2(invoice.payments.reduce((s, p) => s + Number(p.amount), 0));
    const outstanding = round2(Number(invoice.netPayable) - paidSoFar);
    if (dto.amount > outstanding + 0.009) {
      throw new BadRequestException(`Payment exceeds outstanding balance ${outstanding}`);
    }

    const acc = await this.posting.accounts(user.organizationId, ['BANK', 'AR'] as const);

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'PAYMENT', tx);
      const receipt = await tx.paymentReceipt.create({
        data: {
          organizationId: user.organizationId,
          code,
          invoiceId: invoice.id,
          amount: dto.amount,
          method: dto.method ?? 'BANK_TRANSFER',
          reference: dto.reference,
        },
      });
      await this.posting.journal(tx, {
        organizationId: user.organizationId,
        sourceType: 'PaymentReceipt',
        sourceId: receipt.id,
        invoiceId: invoice.id,
        memo: `Payment ${code} for ${invoice.code}`,
        lines: [
          { accountId: acc.BANK, debit: dto.amount, credit: 0, currency: invoice.currency },
          { accountId: acc.AR, debit: 0, credit: dto.amount, currency: invoice.currency },
        ],
      });
      const fullyPaid = paidSoFar + dto.amount >= Number(invoice.netPayable) - 0.009;
      if (fullyPaid) {
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'PAID' } });
      }
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PaymentReceipt',
          entityId: receipt.id,
          action: 'RECEIVE',
          after: { code, amount: dto.amount, fullyPaid },
        },
        tx,
      );
      return receipt;
    });
  }

  /**
   * Retention release: the withheld amount becomes due — Dr AR (1100) /
   * Cr Retention Receivable (1200) — and re-opens the invoice for payment.
   */
  async releaseRetention(user: AuthUser, retentionEntryId: string) {
    const entry = await this.prisma.retentionEntry.findFirst({
      where: { id: retentionEntryId, organizationId: user.organizationId },
      include: { invoice: true },
    });
    if (!entry) throw new NotFoundException('Retention entry not found');
    if (entry.status !== 'WITHHELD') throw new BadRequestException(`Retention is ${entry.status}`);

    const amount = Number(entry.withheldAmount);
    const acc = await this.posting.accounts(user.organizationId, [
      'AR',
      'RETENTION_RECEIVABLE',
    ] as const);

    return this.prisma.$transaction(async (tx) => {
      await this.posting.journal(tx, {
        organizationId: user.organizationId,
        sourceType: 'RetentionRelease',
        sourceId: entry.id,
        invoiceId: entry.invoiceId,
        memo: `Retention release for ${entry.invoice.code}`,
        lines: [
          { accountId: acc.AR, debit: amount, credit: 0, currency: entry.invoice.currency },
          {
            accountId: acc.RETENTION_RECEIVABLE,
            debit: 0,
            credit: amount,
            currency: entry.invoice.currency,
          },
        ],
      });
      const updated = await tx.retentionEntry.update({
        where: { id: entry.id },
        data: { status: 'RELEASED' },
      });
      // The released amount is now collectible on the invoice.
      await tx.invoice.update({
        where: { id: entry.invoiceId },
        data: {
          netPayable: round2(Number(entry.invoice.netPayable) + amount),
          ...(entry.invoice.status === 'PAID' ? { status: 'CLEARED' as const } : {}),
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'RetentionEntry',
          entityId: entry.id,
          action: 'RELEASE',
          after: { amount, invoiceCode: entry.invoice.code },
        },
        tx,
      );
      return updated;
    });
  }

  // ── Ledgers ───────────────────────────────────────────────────────────────

  journal(user: AuthUser) {
    return this.prisma.journalEntry.findMany({
      where: { organizationId: user.organizationId },
      include: {
        lines: { include: { account: { select: { code: true, nameAr: true, nameEn: true } } } },
        invoice: { select: { code: true } },
      },
      orderBy: { postingDate: 'desc' },
    });
  }

  retention(user: AuthUser) {
    return this.prisma.retentionEntry.findMany({
      where: { organizationId: user.organizationId },
      include: {
        contract: { select: { code: true } },
        invoice: { select: { code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async summary(user: AuthUser) {
    const org = user.organizationId;
    const [issued, arDue, vatOutput, retentionHeld] = await Promise.all([
      this.prisma.invoice.count({ where: { organizationId: org, status: { in: ['ISSUED', 'CLEARED', 'PAID'] } } }),
      this.prisma.invoice.aggregate({
        where: { organizationId: org, status: { in: ['ISSUED', 'CLEARED'] } },
        _sum: { netPayable: true },
      }),
      this.prisma.invoice.aggregate({
        where: { organizationId: org, status: { in: ['ISSUED', 'CLEARED', 'PAID'] } },
        _sum: { vatAmount: true },
      }),
      this.prisma.retentionEntry.aggregate({
        where: { organizationId: org, status: 'WITHHELD' },
        _sum: { withheldAmount: true },
      }),
    ]);
    return {
      issuedInvoices: issued,
      accountsReceivable: arDue._sum.netPayable ?? 0,
      vatOutput: vatOutput._sum.vatAmount ?? 0,
      retentionHeld: retentionHeld._sum.withheldAmount ?? 0,
    };
  }
}
