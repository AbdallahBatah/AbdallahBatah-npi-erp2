import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import type { AuthUser } from '../../common/auth-user';
import type { IngestDto, SimulateDto } from './dto';

const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/**
 * TEL-01…04 + FSM-11: the metering-to-money bridge.
 *
 * Rule engine (evaluated at ingestion, per reading):
 *   • energy == 0 while expected > 0        → OFFLINE, CRITICAL
 *   • PR < 0.5                              → UNDERPERFORMANCE, CRITICAL
 *   • PR < 0.8                              → UNDERPERFORMANCE, WARNING
 * CRITICAL alerts auto-raise a corrective work order (origin ALERT); closing
 * that work order resolves the alert. One open alert per asset+type at a time.
 */
@Injectable()
export class TelemetryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /** Expected daily kWh for a plant: design yield / 365, else capacity × 4.5h. */
  private async expectedDailyKwh(projectId: string | null): Promise<number | null> {
    if (!projectId) return null;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        contract: {
          select: {
            proposalRevision: { select: { designVersion: { select: { expectedAnnualKwh: true } } } },
          },
        },
      },
    });
    const annual = project?.contract?.proposalRevision?.designVersion?.expectedAnnualKwh;
    if (annual && Number(annual) > 0) return round3(Number(annual) / 365);
    if (project?.capacityKwp && Number(project.capacityKwp) > 0) {
      return round3(Number(project.capacityKwp) * 4.5);
    }
    return null;
  }

  // ── TEL-01: ingestion + rule evaluation ───────────────────────────────────

  async ingest(user: AuthUser, dto: IngestDto) {
    if (!dto.readings.length) throw new BadRequestException('No readings supplied');
    const results: Array<{ readingId: string; alertCode?: string }> = [];

    for (const r of dto.readings) {
      const asset = await this.prisma.asset.findFirst({
        where: { id: r.assetId, organizationId: user.organizationId },
      });
      if (!asset) throw new NotFoundException(`Asset ${r.assetId} not found`);

      const day = new Date(r.readingDate);
      if (isNaN(day.getTime())) throw new BadRequestException(`Bad date: ${r.readingDate}`);
      const readingDate = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));

      const expected =
        r.expectedKwh ?? (await this.expectedDailyKwh(asset.projectId)) ?? undefined;
      const pr =
        expected && expected > 0 ? round3(r.energyKwh / expected) : undefined;

      const reading = await this.prisma.telemetryReading.upsert({
        where: { assetId_readingDate: { assetId: asset.id, readingDate } },
        update: {
          energyKwh: r.energyKwh,
          expectedKwh: expected,
          performanceRatio: pr,
          source: r.source ?? 'SIMULATED',
        },
        create: {
          organizationId: user.organizationId,
          assetId: asset.id,
          readingDate,
          energyKwh: r.energyKwh,
          expectedKwh: expected,
          performanceRatio: pr,
          source: r.source ?? 'SIMULATED',
        },
      });

      // ── TEL-03/04: rules ──
      let alertCode: string | undefined;
      if (expected && expected > 0) {
        if (r.energyKwh === 0) {
          alertCode = await this.raiseAlert(user, asset.id, reading.id, {
            alertType: 'OFFLINE',
            severity: 'CRITICAL',
            message: `No production on ${readingDate.toISOString().slice(0, 10)} (expected ${expected} kWh)`,
            ruleRef: 'energy==0',
          });
        } else if (pr !== undefined && pr < 0.5) {
          alertCode = await this.raiseAlert(user, asset.id, reading.id, {
            alertType: 'UNDERPERFORMANCE',
            severity: 'CRITICAL',
            message: `PR ${pr} on ${readingDate.toISOString().slice(0, 10)} (${r.energyKwh}/${expected} kWh)`,
            ruleRef: 'PR<0.5',
          });
        } else if (pr !== undefined && pr < 0.8) {
          alertCode = await this.raiseAlert(user, asset.id, reading.id, {
            alertType: 'UNDERPERFORMANCE',
            severity: 'WARNING',
            message: `PR ${pr} on ${readingDate.toISOString().slice(0, 10)} (${r.energyKwh}/${expected} kWh)`,
            ruleRef: 'PR<0.8',
          });
        }
      }
      results.push({ readingId: reading.id, alertCode });
    }
    return { ingested: results.length, alerts: results.filter((x) => x.alertCode).map((x) => x.alertCode) };
  }

  /** Create the alert unless one is already open for the same asset+type. FSM-11: CRITICAL auto-raises a WO. */
  private async raiseAlert(
    user: AuthUser,
    assetId: string,
    readingId: string,
    input: { alertType: 'UNDERPERFORMANCE' | 'OFFLINE' | 'COMM_LOSS' | 'OVERTEMP'; severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string; ruleRef: string },
  ): Promise<string | undefined> {
    const existing = await this.prisma.performanceAlert.findFirst({
      where: {
        organizationId: user.organizationId,
        assetId,
        alertType: input.alertType,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'WORK_ORDERED'] },
      },
    });
    if (existing) return undefined; // suppression: one live alert per asset+type

    return this.prisma.$transaction(async (tx) => {
      const code = await this.numbering.next(user.organizationId, 'ALERT', tx);
      const asset = await tx.asset.findUnique({
        where: { id: assetId },
        select: { projectId: true, nameAr: true, nameEn: true },
      });
      const alert = await tx.performanceAlert.create({
        data: {
          organizationId: user.organizationId,
          code,
          assetId,
          readingId,
          alertType: input.alertType,
          severity: input.severity,
          message: input.message,
          ruleRef: input.ruleRef,
        },
      });

      // FSM-11: critical alerts don't wait for a human — the work order is born here.
      if (input.severity === 'CRITICAL') {
        const woCode = await this.numbering.next(user.organizationId, 'WORK_ORDER', tx);
        const wo = await tx.workOrder.create({
          data: {
            organizationId: user.organizationId,
            code: woCode,
            titleAr: `إنذار ${code}: ${input.alertType === 'OFFLINE' ? 'توقف إنتاج' : 'أداء منخفض'} — ${asset?.nameAr ?? ''}`,
            titleEn: `Alert ${code}: ${input.alertType} — ${asset?.nameEn ?? ''}`,
            description: input.message,
            woType: 'CORRECTIVE',
            origin: 'ALERT',
            priority: 'CRITICAL',
            assetId,
            projectId: asset?.projectId,
            slaDueAt: new Date(Date.now() + 48 * 3600 * 1000), // 48h response
          },
        });
        await tx.performanceAlert.update({
          where: { id: alert.id },
          data: { status: 'WORK_ORDERED', workOrderId: wo.id },
        });
        // Inside the tx: an alert that rolls back must not ping anyone.
        await this.notifications.notify(
          {
            organizationId: user.organizationId,
            permission: 'fsm.workorder.read',
            type: 'ALERT_WORKORDER',
            titleAr: `إنذار حرج ${code} — أُنشئ أمر العمل ${woCode} تلقائياً`,
            titleEn: `Critical alert ${code} — work order ${woCode} auto-created`,
            bodyAr: asset?.nameAr ?? undefined,
            bodyEn: asset?.nameEn ?? undefined,
            linkPath: `/workorders/${wo.id}`,
          },
          tx,
        );
      }

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PerformanceAlert',
          entityId: alert.id,
          action: 'RAISE',
          after: { code, ...input },
        },
        tx,
      );
      return code;
    });
  }

  // ── Simulated connector (until the integration service ships) ────────────

  async simulate(user: AuthUser, dto: SimulateDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, organizationId: user.organizationId },
    });
    if (!project) throw new NotFoundException('Project not found');
    const plant = await this.prisma.asset.findFirst({
      where: { organizationId: user.organizationId, projectId: dto.projectId, assetType: 'PLANT' },
    });
    if (!plant) {
      throw new BadRequestException('Project has no PLANT asset yet — install a serial unit first');
    }
    const expected = (await this.expectedDailyKwh(dto.projectId)) ?? 1000;

    const readings = [];
    const today = new Date();
    for (let i = dto.days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      d.setUTCDate(d.getUTCDate() - i);
      // Healthy noise band 88–104% of expected; the designated bad day collapses to 30%.
      const noise = 0.88 + (((i * 7919) % 100) / 100) * 0.16;
      const isBad = dto.badDayOffset !== undefined && i === dto.badDayOffset;
      const energy = round3(expected * (isBad ? 0.3 : noise));
      readings.push({
        assetId: plant.id,
        readingDate: d.toISOString(),
        energyKwh: energy,
        expectedKwh: expected,
        source: 'SIMULATED',
      });
    }
    return this.ingest(user, { readings });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  readings(user: AuthUser, assetId?: string, days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    return this.prisma.telemetryReading.findMany({
      where: {
        organizationId: user.organizationId,
        ...(assetId ? { assetId } : {}),
        readingDate: { gte: since },
      },
      include: { asset: { select: { code: true, nameAr: true, nameEn: true, assetType: true } } },
      orderBy: { readingDate: 'asc' },
    });
  }

  alerts(user: AuthUser) {
    return this.prisma.performanceAlert.findMany({
      where: { organizationId: user.organizationId },
      include: {
        asset: { select: { code: true, nameAr: true, nameEn: true } },
        workOrder: { select: { id: true, code: true, status: true } },
      },
      orderBy: { detectedAt: 'desc' },
    });
  }

  async acknowledge(user: AuthUser, id: string) {
    const alert = await this.prisma.performanceAlert.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!alert) throw new NotFoundException('Alert not found');
    if (alert.status !== 'OPEN') throw new BadRequestException(`Alert is ${alert.status}`);
    const updated = await this.prisma.performanceAlert.update({
      where: { id },
      data: { status: 'ACKNOWLEDGED', acknowledgedById: user.userId, acknowledgedAt: new Date() },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'PerformanceAlert',
      entityId: id,
      action: 'ACKNOWLEDGE',
      before: { status: alert.status },
      after: { status: 'ACKNOWLEDGED' },
    });
    return updated;
  }

  /** FSM-11 manual path: raise a work order from a WARNING/INFO alert. */
  async raiseWorkOrder(user: AuthUser, id: string) {
    const alert = await this.prisma.performanceAlert.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { asset: { select: { projectId: true, nameAr: true, nameEn: true } } },
    });
    if (!alert) throw new NotFoundException('Alert not found');
    if (alert.workOrderId) throw new BadRequestException('Alert already has a work order');
    if (alert.status === 'RESOLVED') throw new BadRequestException('Alert is resolved');

    return this.prisma.$transaction(async (tx) => {
      const woCode = await this.numbering.next(user.organizationId, 'WORK_ORDER', tx);
      const wo = await tx.workOrder.create({
        data: {
          organizationId: user.organizationId,
          code: woCode,
          titleAr: `إنذار ${alert.code}: متابعة — ${alert.asset.nameAr}`,
          titleEn: `Alert ${alert.code}: follow-up — ${alert.asset.nameEn}`,
          description: alert.message,
          woType: 'CORRECTIVE',
          origin: 'ALERT',
          priority: alert.severity === 'WARNING' ? 'HIGH' : 'MEDIUM',
          assetId: alert.assetId,
          projectId: alert.asset.projectId,
        },
      });
      const updated = await tx.performanceAlert.update({
        where: { id: alert.id },
        data: { status: 'WORK_ORDERED', workOrderId: wo.id },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'PerformanceAlert',
          entityId: alert.id,
          action: 'RAISE_WO',
          after: { workOrderCode: woCode },
        },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: user.organizationId,
          permission: 'fsm.workorder.read',
          excludeUserId: user.userId,
          type: 'ALERT_WORKORDER',
          titleAr: `أمر العمل ${woCode} أُنشئ من الإنذار ${alert.code}`,
          titleEn: `Work order ${woCode} raised from alert ${alert.code}`,
          bodyAr: alert.asset.nameAr,
          bodyEn: alert.asset.nameEn,
          linkPath: `/workorders/${wo.id}`,
        },
        tx,
      );
      return { alert: updated, workOrder: wo };
    });
  }

  // ── TEL-02 dashboard + AST-02 asset history ───────────────────────────────

  async dashboard(user: AuthUser) {
    const org = user.organizationId;
    const since14 = new Date(Date.now() - 14 * 24 * 3600 * 1000);
    const [series, openAlerts, plants] = await Promise.all([
      this.prisma.telemetryReading.findMany({
        where: { organizationId: org, readingDate: { gte: since14 }, asset: { assetType: 'PLANT' } },
        include: { asset: { select: { code: true, nameAr: true, nameEn: true } } },
        orderBy: { readingDate: 'asc' },
      }),
      this.prisma.performanceAlert.count({
        where: { organizationId: org, status: { in: ['OPEN', 'ACKNOWLEDGED', 'WORK_ORDERED'] } },
      }),
      this.prisma.asset.count({ where: { organizationId: org, assetType: 'PLANT' } }),
    ]);

    const totalActual = series.reduce((s, r) => s + Number(r.energyKwh), 0);
    const totalExpected = series.reduce((s, r) => s + Number(r.expectedKwh ?? 0), 0);
    const last = series[series.length - 1];
    return {
      plants,
      openAlerts,
      days: 14,
      totalActualKwh: round3(totalActual),
      totalExpectedKwh: round3(totalExpected),
      portfolioPr: totalExpected > 0 ? round3(totalActual / totalExpected) : null,
      lastReading: last
        ? { date: last.readingDate, energyKwh: Number(last.energyKwh), pr: last.performanceRatio ? Number(last.performanceRatio) : null }
        : null,
      series: series.map((r) => ({
        date: r.readingDate,
        asset: r.asset.code,
        energyKwh: Number(r.energyKwh),
        expectedKwh: r.expectedKwh ? Number(r.expectedKwh) : null,
        pr: r.performanceRatio ? Number(r.performanceRatio) : null,
      })),
    };
  }

  /** AST-02: per-asset operating history — production, alerts, work orders. */
  async assetHistory(user: AuthUser, assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, organizationId: user.organizationId },
      include: {
        serialUnit: { select: { serialNo: true, batchNo: true, goodsReceipt: { select: { code: true } } } },
        project: { select: { code: true } },
      },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    const [readings, alerts, workOrders] = await Promise.all([
      this.prisma.telemetryReading.findMany({
        where: { assetId },
        orderBy: { readingDate: 'desc' },
        take: 30,
      }),
      this.prisma.performanceAlert.findMany({
        where: { assetId },
        orderBy: { detectedAt: 'desc' },
        include: { workOrder: { select: { code: true, status: true } } },
      }),
      this.prisma.workOrder.findMany({
        where: { assetId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, code: true, woType: true, origin: true, status: true, createdAt: true, closedAt: true },
      }),
    ]);
    return { asset, readings, alerts, workOrders };
  }
}
