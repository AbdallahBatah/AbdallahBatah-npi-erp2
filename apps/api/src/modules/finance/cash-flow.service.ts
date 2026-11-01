import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../../common/auth-user';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const DAY = 864e5;

/**
 * Package 7 · P7-3 (ADR-07) — what the company is owed and when, and what it
 * owes: receivables aged against their due dates, and a six-month forecast of
 * money in (open invoices by due month, uninvoiced milestones by due date) and
 * out (approved vendor bills, approved payment requests). Overdue amounts land
 * in the current month — late money is still expected money.
 */
@Injectable()
export class CashFlowService {
  constructor(private readonly prisma: PrismaService) {}

  async report(user: AuthUser, months = 6) {
    const org = user.organizationId;
    const now = new Date();
    const horizon = Array.from({ length: months }, (_, i) =>
      monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))),
    );
    const bucketOf = (d: Date | null) => {
      const k = monthKey(d && d > now ? d : now);
      return horizon.includes(k) ? k : null;
    };

    const [invoices, milestones, bills, requests] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { organizationId: org, status: { in: ['ISSUED', 'CLEARED'] }, invoiceType: { not: 'CREDIT_NOTE' } },
        select: {
          id: true, code: true, dueDate: true, issueDate: true, netPayable: true,
          customer: { select: { nameAr: true, nameEn: true } },
          payments: { select: { amount: true } },
        },
      }),
      this.prisma.contractMilestone.findMany({
        where: { contract: { organizationId: org, status: 'ACTIVE' }, invoiceId: null, status: { in: ['PENDING', 'VERIFIED'] } },
        select: { id: true, amount: true, dueDate: true, status: true, contract: { select: { code: true } } },
      }),
      this.prisma.vendorBill.findMany({
        where: { organizationId: org, status: { in: ['APPROVED', 'SCHEDULED'] } },
        select: { id: true, code: true, total: true, createdAt: true, paymentAllocations: { select: { amount: true } } },
      }),
      this.prisma.vendorPaymentRequest.findMany({
        where: { organizationId: org, status: 'APPROVED', kind: 'ADVANCE' },
        select: { id: true, code: true, amount: true, createdAt: true },
      }),
    ]);

    const aging = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    const inflow = new Map(horizon.map((k) => [k, 0]));
    const outflow = new Map(horizon.map((k) => [k, 0]));
    const overdue: Array<{ code: string; customer: unknown; outstanding: number; daysLate: number }> = [];

    for (const inv of invoices) {
      const paid = inv.payments.reduce((s, r) => s + Number(r.amount), 0);
      const open = round2(Number(inv.netPayable) - paid);
      if (open <= 0.005) continue;
      const due = inv.dueDate ?? new Date(inv.issueDate.getTime() + 30 * DAY);
      const late = Math.floor((now.getTime() - due.getTime()) / DAY);
      if (late <= 0) aging.notDue += open;
      else if (late <= 30) aging.d1_30 += open;
      else if (late <= 60) aging.d31_60 += open;
      else if (late <= 90) aging.d61_90 += open;
      else aging.d90plus += open;
      if (late > 0) overdue.push({ code: inv.code, customer: inv.customer, outstanding: open, daysLate: late });
      const k = bucketOf(due);
      if (k) inflow.set(k, inflow.get(k)! + open);
    }
    for (const m of milestones) {
      if (!m.dueDate && m.status !== 'VERIFIED') continue; // no date, not yet earned: not forecastable
      const k = bucketOf(m.dueDate);
      if (k) inflow.set(k, inflow.get(k)! + Number(m.amount));
    }
    for (const b of bills) {
      const open = Number(b.total) - b.paymentAllocations.reduce((s, a) => s + Number(a.amount), 0);
      if (open <= 0.005) continue;
      const k = bucketOf(new Date(b.createdAt.getTime() + 30 * DAY));
      if (k) outflow.set(k, outflow.get(k)! + open);
    }
    for (const r of requests) {
      const k = bucketOf(now);
      if (k) outflow.set(k, outflow.get(k)! + Number(r.amount));
    }

    let running = 0;
    const forecast = horizon.map((k) => {
      const inn = round2(inflow.get(k)!);
      const out = round2(outflow.get(k)!);
      running = round2(running + inn - out);
      return { month: k, inflow: inn, outflow: out, net: round2(inn - out), cumulative: running };
    });
    return {
      asOf: now,
      aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, round2(v)])),
      overdue: overdue.sort((a, b) => b.daysLate - a.daysLate),
      forecast,
    };
  }
}
