import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMISSIONS, mobileSearchFragment } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

export interface SearchHit {
  type: string;
  id: string;
  labelAr: string;
  labelEn: string;
  sublabel?: string | null;
  href: string;
}

const TAKE = 5;
const ci = { contains: '', mode: 'insensitive' as const };

/**
 * Cross-entity omnisearch for the top nav bar. Each entity is queried only if
 * the caller holds its read permission — never trust the client, the same
 * ENTITY_READ_PERMISSION pattern as attachments.service. Results are capped at
 * 5 per type; this is a "find it fast" jump list, not a reporting tool.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(user: AuthUser, rawQuery: string): Promise<Record<string, SearchHit[]>> {
    const q = rawQuery.trim();
    const out: Record<string, SearchHit[]> = {};
    if (q.length < 2) return out;
    const orgId = user.organizationId;
    const has = (p: string) => user.permissions.includes(p);
    const contains = (v: string) => ({ ...ci, contains: v });
    const mobileFrag = mobileSearchFragment(q);

    const tasks: Array<Promise<void>> = [];

    if (has(PERMISSIONS.CUSTOMER_READ)) {
      tasks.push(
        this.prisma.customer
          .findMany({
            where: {
              organizationId: orgId,
              // A merged-away duplicate is not a customer anyone should land on.
              mergedIntoId: null,
              OR: [
                { nameAr: contains(q) },
                { nameEn: contains(q) },
                { code: contains(q) },
                { phone: contains(q) },
                ...(mobileFrag ? [{ mobile: { contains: mobileFrag } }] : []),
                { email: contains(q) },
              ],
            },
            select: { id: true, nameAr: true, nameEn: true, code: true },
            take: TAKE,
          })
          .then((rows) => {
            out.customers = rows.map((r) => ({
              type: 'customers',
              id: r.id,
              labelAr: r.nameAr,
              labelEn: r.nameEn,
              sublabel: r.code,
              href: `/customers/${r.id}`,
            }));
          }),
      );
    }

    if (has(PERMISSIONS.LEAD_READ)) {
      tasks.push(
        this.prisma.lead
          .findMany({
            where: {
              organizationId: orgId,
              OR: [
                { contactName: contains(q) },
                { companyName: contains(q) },
                { code: contains(q) },
                { phone: contains(q) },
                { email: contains(q) },
              ],
            },
            select: { id: true, contactName: true, companyName: true, code: true },
            take: TAKE,
          })
          .then((rows) => {
            out.leads = rows.map((r) => ({
              type: 'leads',
              id: r.id,
              labelAr: r.contactName,
              labelEn: r.contactName,
              sublabel: r.companyName ?? r.code,
              href: `/leads?q=${encodeURIComponent(r.code)}`,
            }));
          }),
      );
    }

    if (has(PERMISSIONS.OPPORTUNITY_READ)) {
      tasks.push(
        this.prisma.opportunity
          .findMany({
            where: {
              organizationId: orgId,
              OR: [{ name: contains(q) }, { code: contains(q) }, { tenderReference: contains(q) }],
            },
            select: { id: true, code: true, name: true, tenderReference: true },
            take: TAKE,
          })
          .then((rows) => {
            out.opportunities = rows.map((r) => ({
              type: 'opportunities',
              id: r.id,
              labelAr: r.name,
              labelEn: r.name,
              sublabel: r.tenderReference ? `${r.code} · ${r.tenderReference}` : r.code,
              href: `/opportunities/${r.id}`,
            }));
          }),
      );
    }

    if (has(PERMISSIONS.CONTRACT_READ)) {
      tasks.push(
        this.prisma.contract
          .findMany({
            where: {
              organizationId: orgId,
              OR: [{ code: contains(q) }, { customer: { nameAr: contains(q) } }, { customer: { nameEn: contains(q) } }],
            },
            select: { id: true, code: true, customer: { select: { nameAr: true, nameEn: true } } },
            take: TAKE,
          })
          .then((rows) => {
            out.contracts = rows.map((r) => ({
              type: 'contracts',
              id: r.id,
              labelAr: r.code,
              labelEn: r.code,
              sublabel: r.customer.nameAr,
              href: `/contracts/${r.id}`,
            }));
          }),
      );
    }

    if (has(PERMISSIONS.INVOICE_READ)) {
      tasks.push(
        this.prisma.invoice
          .findMany({
            where: { organizationId: orgId, code: contains(q) },
            select: { id: true, code: true, customer: { select: { nameAr: true, nameEn: true } } },
            take: TAKE,
          })
          .then((rows) => {
            out.invoices = rows.map((r) => ({
              type: 'invoices',
              id: r.id,
              labelAr: r.code,
              labelEn: r.code,
              sublabel: r.customer.nameAr,
              href: `/invoices/${r.id}`,
            }));
          }),
      );
    }

    if (has(PERMISSIONS.PROJECT_READ)) {
      tasks.push(
        this.prisma.project
          .findMany({
            where: {
              organizationId: orgId,
              OR: [{ code: contains(q) }, { nameAr: contains(q) }, { nameEn: contains(q) }],
            },
            select: { id: true, code: true, nameAr: true, nameEn: true },
            take: TAKE,
          })
          .then((rows) => {
            out.projects = rows.map((r) => ({
              type: 'projects',
              id: r.id,
              labelAr: r.nameAr,
              labelEn: r.nameEn,
              sublabel: r.code,
              href: `/projects/${r.id}`,
            }));
          }),
      );
    }

    if (has(PERMISSIONS.WORKORDER_READ)) {
      tasks.push(
        this.prisma.workOrder
          .findMany({
            where: {
              organizationId: orgId,
              OR: [{ code: contains(q) }, { titleAr: contains(q) }, { titleEn: contains(q) }],
            },
            select: { id: true, code: true, titleAr: true, titleEn: true },
            take: TAKE,
          })
          .then((rows) => {
            out.workOrders = rows.map((r) => ({
              type: 'workOrders',
              id: r.id,
              labelAr: r.titleAr,
              labelEn: r.titleEn,
              sublabel: r.code,
              href: `/workorders/${r.id}`,
            }));
          }),
      );
    }

    if (has(PERMISSIONS.ASSET_READ)) {
      tasks.push(
        this.prisma.serialUnit
          .findMany({
            where: { organizationId: orgId, OR: [{ serialNo: contains(q) }, { batchNo: contains(q) }] },
            select: { id: true, serialNo: true, item: { select: { nameAr: true, nameEn: true } } },
            take: TAKE,
          })
          .then((rows) => {
            out.serialUnits = rows.map((r) => ({
              type: 'serialUnits',
              id: r.id,
              labelAr: r.serialNo,
              labelEn: r.serialNo,
              sublabel: r.item.nameAr,
              href: `/assets?q=${encodeURIComponent(r.serialNo)}`,
            }));
          }),
      );
    }

    await Promise.all(tasks);
    return out;
  }
}
