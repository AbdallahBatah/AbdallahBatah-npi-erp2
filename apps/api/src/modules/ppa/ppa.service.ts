import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import type { CreatePpaTermDto, SettleDto } from './dto';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const VAT_RATE = 15;

/**
 * W6: recurring revenue. PPA-01/02 terms + tariff escalation; PPA-03 per-kWh
 * settlement computed from the same TelemetryReading rows the monitoring page
 * shows — every invoice is recomputable from stored inputs. The produced
 * SETTLEMENT invoice flows through the existing ZATCA issue pipeline
 * (hash chain, QR, journal) untouched.
 */
@Injectable()
export class PpaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  listTerms(user: AuthUser) {
    return this.prisma.ppaTerm.findMany({
      where: { organizationId: user.organizationId },
      include: {
        contract: { select: { code: true, contractType: true, customer: { select: { nameAr: true, nameEn: true } } } },
        project: { select: { code: true, nameAr: true, nameEn: true } },
        _count: { select: { settlementRuns: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  listRuns(user: AuthUser) {
    return this.prisma.settlementRun.findMany({
      where: { organizationId: user.organizationId },
      include: {
        ppaTerm: { select: { code: true, contract: { select: { code: true } } } },
        invoice: { select: { id: true, code: true, status: true, total: true } },
      },
      orderBy: { computedAt: 'desc' },
    });
  }

  /** PPA-01: attach terms to an ACTIVE PPA/OM contract, or create one inline. */
  async createTerm(user: AuthUser, dto: CreatePpaTermDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, organizationId: user.organizationId },
      include: { contract: { select: { customerId: true } } },
    });
    if (!project) throw new NotFoundException('Project not found');

    let contractId = dto.contractId;
    return this.prisma.$transaction(async (tx) => {
      if (contractId) {
        const contract = await tx.contract.findFirst({
          where: { id: contractId, organizationId: user.organizationId },
          include: { ppaTerm: { select: { id: true } } },
        });
        if (!contract) throw new NotFoundException('Contract not found');
        if (!['PPA', 'OM'].includes(contract.contractType)) {
          throw new BadRequestException('Contract must be of type PPA or OM');
        }
        if (contract.status !== 'ACTIVE') throw new BadRequestException('Contract must be ACTIVE');
        if (contract.ppaTerm) throw new BadRequestException('Contract already has PPA terms');
      } else {
        // Inline PPA contract for the buyer (defaults to the project's EPC customer).
        const customerId = dto.customerId ?? project.contract.customerId;
        const customer = await tx.customer.findFirst({
          where: { id: customerId, organizationId: user.organizationId },
        });
        if (!customer) throw new NotFoundException('Customer not found');
        const code = await this.numbering.next(user.organizationId, 'CONTRACT', tx);
        const contract = await tx.contract.create({
          data: {
            organizationId: user.organizationId,
            code,
            customerId,
            contractType: 'PPA',
            status: 'ACTIVE',
            startDate: dto.startDate ? new Date(dto.startDate) : new Date(),
          },
        });
        contractId = contract.id;
      }

      const code = await this.numbering.next(user.organizationId, 'PPA_TERM', tx);
      const term = await tx.ppaTerm.create({
        data: {
          organizationId: user.organizationId,
          code,
          contractId: contractId!,
          projectId: dto.projectId,
          ratePerKwh: dto.ratePerKwh,
          escalationPctPerYear: dto.escalationPctPerYear ?? 0,
          fixedMonthlyFee: dto.fixedMonthlyFee ?? 0,
          billingCycle: dto.billingCycle ?? 'MONTHLY',
          startDate: dto.startDate ? new Date(dto.startDate) : new Date(),
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        },
        include: { contract: { select: { code: true } } },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PpaTerm',
          entityId: term.id,
          action: 'CREATE',
          after: { code, ratePerKwh: dto.ratePerKwh, contractId },
        },
        tx,
      );
      return term;
    });
  }

  /**
   * PPA-03: settle a period — Σ plant readings × escalated tariff + fixed fee
   * → one SETTLEMENT invoice (draft; issue it through the ZATCA pipeline).
   */
  async settle(user: AuthUser, termId: string, dto: SettleDto) {
    const term = await this.prisma.ppaTerm.findFirst({
      where: { id: termId, organizationId: user.organizationId },
      include: { contract: true, project: { select: { id: true, nameAr: true, nameEn: true } } },
    });
    if (!term) throw new NotFoundException('PPA term not found');
    if (term.status !== 'ACTIVE') throw new BadRequestException(`PPA term is ${term.status}`);

    const start = new Date(dto.periodStart);
    const end = new Date(dto.periodEnd);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid settlement period');
    }

    // No overlapping settlement for the same term (double-billing guard).
    const overlap = await this.prisma.settlementRun.findFirst({
      where: {
        ppaTermId: term.id,
        status: 'INVOICED',
        periodStart: { lt: end },
        periodEnd: { gt: start },
      },
    });
    if (overlap) {
      throw new BadRequestException(`Period overlaps settlement ${overlap.code}`);
    }

    // The only input to settlement: plant readings of the term's project.
    const plant = await this.prisma.asset.findFirst({
      where: { organizationId: user.organizationId, projectId: term.projectId, assetType: 'PLANT' },
    });
    if (!plant) throw new BadRequestException('Project has no PLANT asset');
    const readings = await this.prisma.telemetryReading.findMany({
      where: { assetId: plant.id, readingDate: { gte: start, lt: end } },
    });
    if (readings.length === 0) {
      throw new BadRequestException('No telemetry readings in the period — nothing to settle');
    }
    const energyKwh = round3(readings.reduce((s, r) => s + Number(r.energyKwh), 0));

    // PPA-02: annual escalation compounded from the term start.
    const yearsElapsed = Math.max(
      0,
      Math.floor((start.getTime() - term.startDate.getTime()) / (365.25 * 24 * 3600 * 1000)),
    );
    const escalation = Number(term.escalationPctPerYear);
    const appliedRate = round4(Number(term.ratePerKwh) * Math.pow(1 + escalation / 100, yearsElapsed));

    const variableAmount = round2(energyKwh * appliedRate);
    const fixedAmount = round2(Number(term.fixedMonthlyFee));
    const subtotal = round2(variableAmount + fixedAmount);
    const vatAmount = round2(subtotal * (VAT_RATE / 100));
    const total = round2(subtotal + vatAmount);

    const taxCode = await this.prisma.taxCode.findFirst({
      where: { organizationId: user.organizationId, taxType: 'VAT_STANDARD' },
    });

    const periodLabel = `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`;

    return this.prisma.$transaction(async (tx) => {
      const invoiceCode = await this.numbering.next(user.organizationId, 'INVOICE', tx);
      const lines: Array<{
        descriptionAr: string; descriptionEn: string; qty: number; unitPrice: number;
        taxCodeId?: string; lineSubtotal: number; vatAmount: number;
      }> = [
        {
          descriptionAr: `توريد طاقة ${periodLabel} — ${energyKwh} ك.و.س`,
          descriptionEn: `Energy supplied ${periodLabel} — ${energyKwh} kWh`,
          qty: energyKwh,
          unitPrice: appliedRate,
          taxCodeId: taxCode?.id,
          lineSubtotal: variableAmount,
          vatAmount: round2(variableAmount * (VAT_RATE / 100)),
        },
      ];
      if (fixedAmount > 0) {
        lines.push({
          descriptionAr: `رسم خدمة ثابت — ${periodLabel}`,
          descriptionEn: `Fixed service fee — ${periodLabel}`,
          qty: 1,
          unitPrice: fixedAmount,
          taxCodeId: taxCode?.id,
          lineSubtotal: fixedAmount,
          vatAmount: round2(fixedAmount * (VAT_RATE / 100)),
        });
      }

      const invoice = await tx.invoice.create({
        data: {
          organizationId: user.organizationId,
          code: invoiceCode,
          invoiceType: 'SETTLEMENT',
          customerId: term.contract.customerId,
          contractId: term.contractId,
          currency: term.contract.currency,
          subtotal,
          vatAmount,
          retentionAmount: 0,
          total,
          netPayable: total,
          status: 'DRAFT',
          lines: { create: lines },
        },
      });

      const runCode = await this.numbering.next(user.organizationId, 'SETTLEMENT', tx);
      const run = await tx.settlementRun.create({
        data: {
          organizationId: user.organizationId,
          code: runCode,
          ppaTermId: term.id,
          periodStart: start,
          periodEnd: end,
          energyKwh,
          appliedRate,
          escalationApplied: escalation,
          variableAmount,
          fixedAmount,
          subtotal,
          invoiceId: invoice.id,
        },
      });

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'SettlementRun',
          entityId: run.id,
          action: 'SETTLE',
          after: { code: runCode, energyKwh, appliedRate, subtotal, invoiceCode },
        },
        tx,
      );
      return { run, invoice };
    });
  }
}
