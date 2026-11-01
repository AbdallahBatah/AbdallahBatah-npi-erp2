import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OPEN_INVOICE_STATUSES, REPORTED_INVOICE_STATUSES, signedTotal } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { PostingService } from '../../common/posting.service';
import { TaxService } from '../../common/tax.service';
import { NotificationService } from '../../common/notification.service';
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
    private readonly notifications: NotificationService,
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
        // Seller identity for the printable fiscal document.
        organization: {
          select: {
            legalNameAr: true,
            legalNameEn: true,
            vatNumber: true,
            crNumber: true,
            addressAr: true,
            addressEn: true,
            phone: true,
            email: true,
            website: true,
            logoDataUrl: true,
          },
        },
        contract: { select: { id: true, code: true, retentionPct: true } },
        lines: { include: { taxCode: true } },
        eInvoice: true,
        retentionEntry: true,
        payments: { orderBy: { receivedAt: 'asc' } },
        journalEntries: {
          include: { lines: { include: { account: true } } },
          orderBy: { postingDate: 'asc' },
        },
        creditNotes: {
          select: { id: true, code: true, total: true, creditReason: true, issueDate: true },
          orderBy: { issueDate: 'asc' },
        },
        creditedInvoice: { select: { id: true, code: true } },
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
    const creditedTotal = round2(
      invoice.creditNotes.reduce((s, c) => s + Number(c.total), 0),
    );
    const paid = round2(invoice.payments.reduce((s, p) => s + Number(p.amount), 0));
    return {
      ...invoice,
      qrDataUrl,
      creditedTotal,
      // What the customer still owes: due now, less received, less the part of
      // the credits that reduced AR (the rest reduced retention receivable).
      // Negative means we owe the customer a refund.
      outstanding: round2(
        Number(invoice.netPayable) - paid - this.creditedAr(invoice, creditedTotal),
      ),
    };
  }

  /**
   * The AR share of credit notes issued against an invoice. Credits are split
   * between AR and retention receivable in the invoice's own proportion, so
   * only the AR share reduces what is collectible now.
   */
  private creditedAr(
    invoice: { netPayable: unknown; total: unknown },
    creditedTotal: number,
  ): number {
    const total = Number(invoice.total);
    if (total <= 0 || creditedTotal <= 0) return 0;
    return round2((creditedTotal * Number(invoice.netPayable)) / total);
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

    // P7-3: due date = raised + the organization's payment terms (read here
    // rather than through OrgSettingsService to keep this service's constructor).
    // `?.`: unit tests build this service on a partial Prisma double.
    const terms = await this.prisma.orgSetting?.findUnique({
      where: { organizationId_key: { organizationId: user.organizationId, key: 'finance.invoice.paymentTermsDays' } },
    });
    const raw = terms?.valueJson;
    const termsDays = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 30;
    const dueDate = new Date(Date.now() + termsDays * 864e5);

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'INVOICE', tx);
      const invoice = await tx.invoice.create({
        data: {
          organizationId: user.organizationId,
          code,
          dueDate,
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

    await this.prisma.serializable(async (tx) => {
      // Chain to the previous e-invoice hash (PIH) *inside* the transaction so
      // two concurrent issues cannot both chain onto the same predecessor.
      // The serializable isolation level makes the read-then-append atomic,
      // and the loser of the race is retried rather than surfaced as an error.
      const prev = await tx.eInvoiceDocument.findFirst({
        where: { organizationId: user.organizationId },
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
          organizationId: user.organizationId,
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
    }, { label: `issue ${invoice.code}` });

    // Post-commit: a rolled-back issue must never announce itself.
    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: 'finance.invoice.read',
      excludeUserId: user.userId,
      type: 'INVOICE_ISSUED',
      titleAr: `صدرت الفاتورة ${invoice.code}`,
      titleEn: `Invoice ${invoice.code} issued`,
      bodyAr: `${invoice.customer.nameAr} — الإجمالي ${grandTotal.toLocaleString('en-US')} ${invoice.currency}`,
      bodyEn: `${invoice.customer.nameEn} — total ${grandTotal.toLocaleString('en-US')} ${invoice.currency}`,
      linkPath: `/invoices/${invoice.id}`,
    });

    return this.get(user, invoice.id);
  }

  // ── Credit notes (ZATCA InvoiceTypeCode 381) ──────────────────────────────

  /**
   * Correct a reported invoice by issuing a credit note against it.
   *
   * A cleared e-invoice is a statutory record — it is never edited or deleted.
   * The credit note is its own document: it carries its own UUID, joins the
   * same PIH hash chain, references the original through BillingReference, and
   * posts the mirror-image journal (Dr Revenue + Dr VAT output / Cr AR).
   *
   * Omit `amount` to credit the invoice in full, which also cancels it.
   */
  async createCreditNote(
    user: AuthUser,
    invoiceId: string,
    dto: { reason: string; amount?: number },
  ) {
    const source = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId: user.organizationId },
      include: {
        customer: true,
        organization: true,
        lines: true,
        creditNotes: { select: { total: true } },
      },
    });
    if (!source) throw new NotFoundException('Invoice not found');
    if (source.invoiceType === 'CREDIT_NOTE') {
      throw new BadRequestException('A credit note cannot itself be credited');
    }
    if (!['ISSUED', 'CLEARED', 'PAID'].includes(source.status)) {
      throw new BadRequestException(
        `Only a reported invoice can be credited — this one is ${source.status}`,
      );
    }

    const { rate } = await this.standardVatRate(user.organizationId);
    const alreadyCredited = round2(source.creditNotes.reduce((s, c) => s + Number(c.total), 0));
    const sourceTotal = Number(source.total);
    const remaining = round2(sourceTotal - alreadyCredited);
    if (remaining <= 0.009) throw new BadRequestException('Invoice is already fully credited');

    const isFull = dto.amount === undefined || dto.amount === null;
    if (!isFull && (dto.amount! <= 0 || dto.amount! > remaining + 0.009)) {
      throw new BadRequestException(`Credit amount exceeds the remaining ${remaining}`);
    }
    const grossCredit = round2(isFull ? remaining : dto.amount!);
    const subtotal = round2(grossCredit / (1 + rate / 100));
    const vatAmount = round2(grossCredit - subtotal);

    // Only an untouched invoice can be mirrored line for line. Once part of it
    // has been credited, "credit the rest" is an amount, not a copy — mirroring
    // there would credit the original total a second time.
    const mirrorsOriginal = isFull && alreadyCredited < 0.009;
    const lines = mirrorsOriginal
      ? source.lines.map((l) => ({
          descriptionAr: l.descriptionAr,
          descriptionEn: l.descriptionEn,
          qty: Number(l.qty),
          unitPrice: Number(l.unitPrice),
          taxCodeId: l.taxCodeId,
          lineSubtotal: Number(l.lineSubtotal),
          vatAmount: Number(l.vatAmount),
        }))
      : [
          {
            descriptionAr: `إشعار دائن جزئي على ${source.code}`,
            descriptionEn: `Partial credit against ${source.code}`,
            qty: 1,
            unitPrice: subtotal,
            taxCodeId: source.lines[0]?.taxCodeId ?? null,
            lineSubtotal: subtotal,
            vatAmount,
          },
        ];
    // A mirrored credit reproduces the original lines exactly, so its totals
    // are the original's — not the recomputed split above.
    const noteSubtotal = mirrorsOriginal ? Number(source.subtotal) : subtotal;
    const noteVat = mirrorsOriginal ? Number(source.vatAmount) : vatAmount;
    const noteTotal = round2(noteSubtotal + noteVat);

    const acc = await this.posting.accounts(user.organizationId, [
      'AR',
      'RETENTION_RECEIVABLE',
      'REVENUE',
      'VAT_OUTPUT',
    ] as const);

    // The original split its receivable between AR and retention receivable.
    // Credit both back in the same proportion — crediting the whole amount to
    // AR would understate it and strand the retention balance forever.
    const creditRetention =
      Number(source.retentionAmount) > 0 && sourceTotal > 0
        ? round2((noteTotal * Number(source.retentionAmount)) / sourceTotal)
        : 0;
    const creditAr = round2(noteTotal - creditRetention);

    await this.prisma.serializable(
      async (tx) => {
        const code = await this.numbering.next(user.organizationId, 'CREDIT_NOTE', tx);
        const note = await tx.invoice.create({
          data: {
            organizationId: user.organizationId,
            code,
            invoiceType: 'CREDIT_NOTE',
            customerId: source.customerId,
            contractId: source.contractId,
            currency: source.currency,
            subtotal: noteSubtotal,
            vatAmount: noteVat,
            retentionAmount: 0,
            total: noteTotal,
            netPayable: noteTotal,
            status: 'CLEARED',
            creditedInvoiceId: source.id,
            creditReason: dto.reason,
            lines: { create: lines },
          },
        });

        // Same hash chain as any other reported document.
        const prev = await tx.eInvoiceDocument.findFirst({
          where: { organizationId: user.organizationId },
          orderBy: { submittedAt: 'desc' },
          select: { invoiceHash: true },
        });
        const zatca = this.zatca.generate(user.organizationId, {
          invoiceCode: code,
          issuedAt: new Date(),
          currency: source.currency,
          documentType: 'CREDIT_NOTE',
          billingReference: {
            invoiceCode: source.code,
            issueDate: source.issueDate,
            reason: dto.reason,
          },
          lines: lines.map((l) => ({
            descriptionEn: l.descriptionEn,
            qty: l.qty,
            unitPrice: l.unitPrice,
            vatRate: rate,
          })),
          subtotal: noteSubtotal,
          vatTotal: noteVat,
          grandTotal: noteTotal,
          parties: {
            sellerNameAr: source.organization.legalNameAr,
            sellerNameEn: source.organization.legalNameEn,
            sellerVat: source.organization.vatNumber ?? '',
            buyerNameAr: source.customer.nameAr,
            buyerNameEn: source.customer.nameEn,
            buyerVat: source.customer.vatNumber,
          },
          previousInvoiceHash: prev?.invoiceHash ?? null,
        });

        await tx.eInvoiceDocument.create({
          data: {
            invoiceId: note.id,
            organizationId: user.organizationId,
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

        // Mirror image of the original sale.
        await this.posting.journal(tx, {
          organizationId: user.organizationId,
          sourceType: 'CreditNote',
          sourceId: note.id,
          invoiceId: note.id,
          memo: `Credit note ${code} against ${source.code} — ${dto.reason}`,
          lines: [
            { accountId: acc.REVENUE, debit: noteSubtotal, credit: 0, currency: source.currency },
            { accountId: acc.VAT_OUTPUT, debit: noteVat, credit: 0, currency: source.currency },
            ...(creditAr > 0
              ? [{ accountId: acc.AR, debit: 0, credit: creditAr, currency: source.currency }]
              : []),
            ...(creditRetention > 0
              ? [
                  {
                    accountId: acc.RETENTION_RECEIVABLE,
                    debit: 0,
                    credit: creditRetention,
                    currency: source.currency,
                  },
                ]
              : []),
          ],
        });

        // The retention half of the credit was just booked to the ledger, so
        // the retention entry has to record it too. Without this the entry goes
        // on claiming money the ledger has already given back: the balance
        // sheet overstates retention held, and releasing it re-bills the
        // customer for an amount already credited to them.
        if (creditRetention > 0) {
          await tx.retentionEntry.updateMany({
            where: { invoiceId: source.id, organizationId: user.organizationId },
            data: { creditedAmount: { increment: creditRetention } },
          });
        }

        // Fully credited: the original no longer represents a receivable.
        if (alreadyCredited + noteTotal >= sourceTotal - 0.009) {
          await tx.invoice.update({ where: { id: source.id }, data: { status: 'CANCELLED' } });
        }

        await this.audit.record(
          {
            organizationId: user.organizationId,
            actorId: user.userId,
            entityType: 'Invoice',
            entityId: note.id,
            action: 'CREDIT_NOTE',
            after: { code, against: source.code, total: noteTotal, reason: dto.reason, isFull },
          },
          tx,
        );
      },
      { label: `credit note against ${source.code}` },
    );

    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: 'finance.invoice.read',
      excludeUserId: user.userId,
      type: 'CREDIT_NOTE',
      titleAr: `إشعار دائن على الفاتورة ${source.code}`,
      titleEn: `Credit note issued against ${source.code}`,
      bodyAr: `السبب: ${dto.reason}`,
      bodyEn: `Reason: ${dto.reason}`,
      linkPath: `/invoices/${source.id}`,
    });

    return this.get(user, source.id);
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
      include: { payments: true, creditNotes: { select: { total: true } } },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (!['ISSUED', 'CLEARED'].includes(invoice.status)) {
      throw new BadRequestException(`Cannot receive payment on a ${invoice.status} invoice`);
    }
    if (!dto.amount || dto.amount <= 0) throw new BadRequestException('Amount must be positive');

    const paidSoFar = round2(invoice.payments.reduce((s, p) => s + Number(p.amount), 0));
    // Credited amounts are no longer collectible.
    const credited = this.creditedAr(
      invoice,
      round2(invoice.creditNotes.reduce((s, c) => s + Number(c.total), 0)),
    );
    const outstanding = round2(Number(invoice.netPayable) - paidSoFar - credited);
    if (dto.amount > outstanding + 0.009) {
      throw new BadRequestException(`Payment exceeds outstanding balance ${outstanding}`);
    }

    const acc = await this.posting.accounts(user.organizationId, ['BANK', 'AR'] as const);

    const receipt = await this.prisma.$transaction(async (tx) => {
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
      const fullyPaid = paidSoFar + credited + dto.amount >= Number(invoice.netPayable) - 0.009;
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

    await this.notifications.notifyBestEffort({
      organizationId: user.organizationId,
      permission: 'finance.invoice.read',
      excludeUserId: user.userId,
      type: 'PAYMENT_RECEIVED',
      titleAr: `دفعة محصّلة على الفاتورة ${invoice.code}`,
      titleEn: `Payment received for ${invoice.code}`,
      bodyAr: `المبلغ ${dto.amount.toLocaleString('en-US')} ${invoice.currency}`,
      bodyEn: `Amount ${dto.amount.toLocaleString('en-US')} ${invoice.currency}`,
      linkPath: `/invoices/${invoice.id}`,
    });

    return receipt;
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
    // A credited-away invoice has had its retention reversed with it; releasing
    // it would recreate a receivable for an invoice that no longer exists.
    if (entry.invoice.status === 'CANCELLED') {
      throw new BadRequestException('Cannot release retention on a cancelled invoice');
    }

    // Release what is still withheld, not what was originally withheld. A
    // credit note against the invoice has already returned part of the
    // retention to the customer and taken it off the ledger; releasing the
    // gross figure would re-bill them for it and leave the retention account
    // holding a permanent credit balance.
    const amount = round2(Number(entry.withheldAmount) - Number(entry.creditedAmount));
    if (amount <= 0.009) {
      throw new BadRequestException(
        'Retention has been fully credited back to the customer — nothing to release',
      );
    }

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

  /**
   * Headline finance figures.
   *
   * Two rules this deliberately does *not* delegate to a plain `aggregate`:
   * credit notes carry positive amounts and must be subtracted, and receivables
   * are what is still collectible — so cash already received and the AR share of
   * any credit note come off. That is the same arithmetic `get()` does for a
   * single invoice, applied to the open set instead of duplicated by hand.
   *
   * Note the two figures net credit notes by different routes, because they
   * answer different questions. Output VAT is a sum over *documents*, so the
   * note is a row with a negative sign. Receivables are a sum over *debts*, so
   * the note is already inside the balance of the invoice it corrects and must
   * not also appear as a row of its own.
   */
  async summary(user: AuthUser) {
    const org = user.organizationId;
    const [issued, openInvoices, reported, retentionHeld] = await Promise.all([
      // Documents that represent a sale. A credit note is a correction to one.
      this.prisma.invoice.count({
        where: {
          organizationId: org,
          status: { in: [...REPORTED_INVOICE_STATUSES] },
          invoiceType: { not: 'CREDIT_NOTE' },
        },
      }),
      // Still-collectible invoices, with what has been received and credited.
      //
      // Credit notes are excluded as *rows* on purpose: a note already reduces
      // AR through the `creditNotes` relation of the invoice it corrects, which
      // is where its retention/AR split is known. Counting the note row as a
      // negative as well would subtract the same credit twice.
      this.prisma.invoice.findMany({
        where: {
          organizationId: org,
          status: { in: [...OPEN_INVOICE_STATUSES] },
          invoiceType: { not: 'CREDIT_NOTE' },
        },
        select: {
          total: true,
          netPayable: true,
          payments: { select: { amount: true } },
          creditNotes: { select: { total: true } },
        },
      }),
      // Grouped rather than fetched: this set is every invoice the org has ever
      // reported and only one column is wanted from it. Grouping by the one
      // field the sign depends on keeps the sum in the database and still lets
      // `signedTotal` apply the sign — four rows instead of the whole history.
      this.prisma.invoice.groupBy({
        by: ['invoiceType'],
        where: { organizationId: org, status: { in: [...REPORTED_INVOICE_STATUSES] } },
        _sum: { vatAmount: true },
      }),
      // Net of what credit notes have already returned — the gross figure
      // would overstate the balance sheet by every partial credit ever raised.
      this.prisma.retentionEntry.aggregate({
        where: { organizationId: org, status: 'WITHHELD' },
        _sum: { withheldAmount: true, creditedAmount: true },
      }),
    ]);

    const accountsReceivable = round2(
      openInvoices.reduce((sum, inv) => {
        const paid = round2(inv.payments.reduce((s, p) => s + Number(p.amount), 0));
        const credited = this.creditedAr(
          inv,
          round2(inv.creditNotes.reduce((s, c) => s + Number(c.total), 0)),
        );
        return sum + Number(inv.netPayable) - paid - credited;
      }, 0),
    );

    return {
      issuedInvoices: issued,
      accountsReceivable,
      vatOutput: signedTotal(reported, (g) => g._sum.vatAmount),
      retentionHeld: round2(
        Number(retentionHeld._sum.withheldAmount ?? 0) -
          Number(retentionHeld._sum.creditedAmount ?? 0),
      ),
    };
  }
}
