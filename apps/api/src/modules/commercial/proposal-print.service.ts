import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxService } from '../../common/tax.service';
import type { AuthUser } from '../../common/auth-user';

/** Only an approved budget is a quote the customer may see (owner work cycle steps 6–7). */
const PRINTABLE: ReadonlySet<string> = new Set(['APPROVED', 'SENT', 'ACCEPTED']);

const round2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * Package 3 · P3-7 (ADR-03 §4-6, owner work cycle step 7: «إصدار عرض السعر
 * الرسمي من النظام») — the printable quote. The browser prints it (as for the
 * tax invoice); the server-side PDF comes with ADR-01's engine in package 2.
 *
 * Built from the selling side only: no line cost, no margin, no contingency,
 * no risk notes ever leave this method — whoever reads it, the customer will.
 * A lump-sum budget prints its scope (work items, quantities) and one price; a
 * per-line revision prints its line prices.
 */
@Injectable()
export class ProposalPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxService,
  ) {}

  async quote(user: AuthUser, proposalId: string, revisionNo?: number) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id: proposalId, organizationId: user.organizationId },
      include: {
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
        opportunity: {
          select: {
            name: true,
            customer: {
              select: { nameAr: true, nameEn: true, vatNumber: true, crNumber: true, mobile: true, phone: true },
            },
            sourceLead: { select: { siteLocation: true } },
          },
        },
        revisions: {
          where: revisionNo !== undefined ? { revisionNo } : { status: { in: [...PRINTABLE] } },
          orderBy: { revisionNo: 'desc' },
          take: 1,
          include: {
            designVersion: { select: { capacityKwp: true, expectedAnnualKwh: true } },
            bomLines: {
              orderBy: { id: 'asc' },
              select: {
                id: true,
                qty: true,
                uom: true,
                description: true,
                unitPrice: true,
                lineTotal: true,
                item: { select: { nameAr: true, nameEn: true, uom: true } },
                workItem: { select: { code: true, nameAr: true, nameEn: true, uom: true, sortOrder: true } },
              },
            },
          },
        },
      },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    const rev = proposal.revisions[0];
    if (!rev) throw new ConflictException('No approved revision to print yet');
    if (!PRINTABLE.has(rev.status)) {
      throw new ConflictException('Only an approved revision is printed as a quote');
    }

    const lump = rev.pricingMode === 'LUMP_SUM';
    const { rate } = await this.tax.standardVat(user.organizationId);
    const net = new Prisma.Decimal(rev.totalAmount);
    const vat = round2(net.mul(rate).div(100));

    // The company's budget order: work items by their list order, then the rest.
    const lines = [...rev.bomLines]
      .sort((a, b) => (a.workItem?.sortOrder ?? 1e9) - (b.workItem?.sortOrder ?? 1e9))
      .map((l) => ({
        id: l.id,
        nameAr: l.description || l.workItem?.nameAr || l.item?.nameAr || '',
        nameEn: l.workItem?.nameEn || l.item?.nameEn || '',
        qty: new Prisma.Decimal(l.qty).toString(),
        uom: l.uom || l.workItem?.uom || l.item?.uom || null,
        unitPrice: lump ? null : new Prisma.Decimal(l.unitPrice).toFixed(2),
        lineTotal: lump ? null : new Prisma.Decimal(l.lineTotal).toFixed(2),
      }));

    return {
      code: proposal.code,
      currency: proposal.currency,
      organization: proposal.organization,
      customer: proposal.opportunity.customer,
      projectName: proposal.opportunity.name,
      siteLocation: proposal.opportunity.sourceLead?.siteLocation ?? null,
      revisionNo: rev.revisionNo,
      status: rev.status,
      issuedAt: rev.approvedAt ?? rev.createdAt,
      validUntil: rev.validUntil,
      pricingMode: rev.pricingMode,
      capacityKwp: rev.designVersion?.capacityKwp?.toString() ?? null,
      expectedAnnualKwh: rev.designVersion?.expectedAnnualKwh?.toString() ?? null,
      lines,
      totals: {
        net: net.toFixed(2),
        vatRate: rate,
        vat: vat.toFixed(2),
        gross: net.add(vat).toFixed(2),
      },
    };
  }
}
