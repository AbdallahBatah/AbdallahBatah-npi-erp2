import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The pick lists behind GET /reference/lookups/* (ADR-02 §3-3): names only,
 * for a form's dropdown, scoped to the caller's organization. Each `select` is
 * the whole contract — a field added to a model does not reach these lists
 * until it is added here (reference-lookups.spec.ts pins every select).
 *
 * `unitCost` is not redacted here: the global CostRedactionInterceptor nulls
 * it for a caller without finance.costs.view, as on every other response.
 */
@Injectable()
export class ReferenceLookupsService {
  constructor(private readonly prisma: PrismaService) {}

  items(organizationId: string) {
    return this.prisma.item.findMany({
      where: { organizationId },
      select: {
        id: true,
        sku: true,
        nameAr: true,
        nameEn: true,
        uom: true,
        isSerialised: true,
        unitCost: true,
      },
      orderBy: { sku: 'asc' },
    });
  }

  projects(organizationId: string) {
    return this.prisma.project.findMany({
      where: { organizationId },
      select: { id: true, code: true, nameAr: true, nameEn: true },
      orderBy: { code: 'asc' },
    });
  }

  /** A merged customer survives only as a pointer to the record it went into:
   *  offering it would file new work under a name that no longer exists. */
  customers(organizationId: string) {
    return this.prisma.customer.findMany({
      where: { organizationId, mergedIntoId: null },
      select: { id: true, code: true, nameAr: true, nameEn: true },
      orderBy: { code: 'asc' },
    });
  }

  vendors(organizationId: string) {
    return this.prisma.vendor.findMany({
      where: { organizationId },
      select: { id: true, code: true, nameAr: true, nameEn: true },
      orderBy: { code: 'asc' },
    });
  }

  locations(organizationId: string) {
    return this.prisma.location.findMany({
      where: { organizationId },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        locationType: true,
        projectId: true,
      },
      orderBy: { code: 'asc' },
    });
  }

  /** Package 3 · P3-3: the active work items, in the company's budget order.
   *  `defaultUnitCost` is nulled by the CostRedactionInterceptor for a caller
   *  without finance.costs.view. */
  workItems(organizationId: string) {
    return this.prisma.workItem.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        kind: true,
        uom: true,
        defaultUnitCost: true,
        itemId: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  /** Package 4 · P4-1: active users, names only (no e-mail, no role, no permission). */
  users(organizationId: string) {
    return this.prisma.user.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, nameAr: true, nameEn: true },
      orderBy: { nameAr: 'asc' },
    });
  }

  /** Package 3 · P3-5: the active standard budgets, each with its lines in order. */
  budgetTemplates(organizationId: string) {
    return this.prisma.budgetTemplate.findMany({
      where: { organizationId, isActive: true },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        panelCount: true,
        capacityKwp: true,
        lines: {
          select: { workItemId: true, qty: true, description: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { code: 'asc' },
    });
  }
}
