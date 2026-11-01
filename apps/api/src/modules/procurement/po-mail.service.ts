import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { ProcurementService } from './procurement.service';
import { sendMail, smtpFromEnv } from '../../common/mail/smtp';
import type { AuthUser } from '../../common/auth-user';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (v: unknown) => Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '—');
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Package 4 deferred item — «إرسال أمر الشراء إلى إيميل المورد» (owner work
 * cycle step 13). Builds the order as a bilingual HTML message (company,
 * vendor, lines, VAT, total, delivery place and date) and sends it through the
 * company mailbox configured in SMTP_* env vars. Optionally performs the
 * existing «send to vendor» step on an APPROVED order, so receiving can start.
 */
@Injectable()
export class PoMailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly procurement: ProcurementService,
  ) {}

  async email(user: AuthUser, poId: string, dto: { to?: string[]; markSent?: boolean }) {
    const cfg = smtpFromEnv();
    if (!cfg) {
      throw new ConflictException('Company mail is not configured (SMTP_HOST / SMTP_FROM) — ask the administrator');
    }
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, organizationId: user.organizationId },
      include: {
        organization: true,
        vendor: true,
        project: { select: { code: true, nameAr: true, nameEn: true } },
        deliveryLocation: { select: { code: true, nameAr: true, nameEn: true } },
        lines: { include: { item: { select: { sku: true, nameAr: true, nameEn: true, uom: true } } } },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (!['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      throw new ConflictException('Only an approved order is sent to the vendor');
    }
    const to = (dto.to?.length ? dto.to : [po.vendor.email ?? '']).map((s) => s.trim()).filter(Boolean);
    if (to.length === 0) throw new BadRequestException('The vendor has no e-mail — enter one');
    const bad = to.find((a) => !EMAIL_RE.test(a));
    if (bad) throw new BadRequestException(`Not an e-mail address: ${bad}`);

    const org = po.organization;
    const rows = po.lines
      .map(
        (l, i) => `<tr>
          <td>${i + 1}</td><td>${esc(l.item.sku)}</td>
          <td>${esc(l.item.nameAr)}<br><small>${esc(l.item.nameEn)}</small></td>
          <td style="text-align:right">${Number(l.qty)} ${esc(l.item.uom)}</td>
          <td style="text-align:right">${money(l.unitPrice)}</td>
          <td style="text-align:right">${money(l.lineTotal)}</td></tr>`,
      )
      .join('');
    const html = `<!doctype html><html><body style="font-family:Arial,Tahoma,sans-serif;color:#0f172a">
      <h2 style="margin:0">${esc(org.legalNameAr)} — ${esc(org.legalNameEn)}</h2>
      <p style="margin:4px 0;color:#475569">${esc(org.addressAr ?? '')} ${org.vatNumber ? `· VAT ${esc(org.vatNumber)}` : ''} ${org.crNumber ? `· CR ${esc(org.crNumber)}` : ''}</p>
      <h3>أمر شراء / Purchase order ${esc(po.code)}</h3>
      <table cellpadding="4" style="border-collapse:collapse;font-size:14px">
        <tr><td><b>المورد / Vendor</b></td><td>${esc(po.vendor.nameAr)} — ${esc(po.vendor.nameEn)}</td></tr>
        <tr><td><b>التاريخ / Date</b></td><td>${day(po.approvedAt ?? po.createdAt)}</td></tr>
        ${po.project ? `<tr><td><b>المشروع / Project</b></td><td>${esc(po.project.code)} — ${esc(po.project.nameAr)}</td></tr>` : ''}
        <tr><td><b>مكان التسليم / Deliver to</b></td><td>${po.deliveryLocation ? `${esc(po.deliveryLocation.code)} — ${esc(po.deliveryLocation.nameAr)}` : '—'}</td></tr>
        <tr><td><b>موعد التسليم / Delivery date</b></td><td>${day(po.expectedDelivery)}</td></tr>
      </table>
      <table border="1" cellpadding="6" style="border-collapse:collapse;margin-top:12px;font-size:13px;border-color:#cbd5e1">
        <thead style="background:#f1f5f9"><tr><th>#</th><th>SKU</th><th>الصنف / Item</th><th>الكمية / Qty</th><th>السعر / Unit price</th><th>الإجمالي / Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="5" style="text-align:right">المجموع قبل الضريبة / Subtotal</td><td style="text-align:right">${money(po.subtotal)}</td></tr>
          <tr><td colspan="5" style="text-align:right">ضريبة القيمة المضافة / VAT</td><td style="text-align:right">${money(po.vatAmount)}</td></tr>
          <tr><td colspan="5" style="text-align:right"><b>الإجمالي / Total (${esc(po.currency)})</b></td><td style="text-align:right"><b>${money(po.total)}</b></td></tr>
        </tfoot>
      </table>
      <p style="color:#475569;font-size:12px">يُرجى تأكيد الاستلام والالتزام بموعد ومكان التسليم. / Please confirm receipt and the delivery date and place.</p>
    </body></html>`;

    let accepted: string;
    try {
      accepted = await sendMail(cfg, { to, subject: `أمر شراء ${po.code} — Purchase order ${po.code}`, html });
    } catch (e) {
      throw new ConflictException(`The mail server refused the message: ${(e as Error).message}`);
    }
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'PurchaseOrder',
      entityId: po.id,
      action: 'EMAIL',
      after: { to, accepted },
    });
    if (dto.markSent && po.status === 'APPROVED') {
      await this.procurement.sendPo(user, po.id);
    }
    return { sent: true, to, markedSent: !!dto.markSent && po.status === 'APPROVED' };
  }
}
