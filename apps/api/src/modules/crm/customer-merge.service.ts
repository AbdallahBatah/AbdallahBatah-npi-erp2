import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@npi/db';
import {
  WF_EVENTS,
  comparableName,
  diceProfiles,
  nameProfile,
  type NameProfile,
} from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { OutboxService } from '../../common/workflow/outbox.service';
import {
  ORG_SETTING_DEFAULTS,
  ORG_SETTING_KEYS,
  OrgSettingsService,
} from '../../common/org-settings.service';
import type { AuthUser } from '../../common/auth-user';
import { CustomersService } from './customers.service';
import { MergeCustomersDto } from './dto';

const SCAN_LIMIT = 5000;
const MIN_BACKUP_REF = 8;

export type DuplicateReason =
  | { kind: 'CR' | 'VAT' | 'MOBILE'; value: string }
  | { kind: 'NAME'; score: number };

export interface DuplicateMember {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  crNumber: string | null;
  vatNumber: string | null;
  mobile: string | null;
  createdAt: Date;
  counts: {
    leads: number;
    opportunities: number;
    contracts: number;
    invoices: number;
    contacts: number;
    /** CRM Step 5: communication-log entries and follow-up tasks travel with the customer. */
    activities: number;
    followUpTasks: number;
  };
  totalDocuments: number;
}

export interface DuplicateGroup {
  id: string;
  reasons: DuplicateReason[];
  members: DuplicateMember[];
  suggestedSurvivorId: string;
}

/**
 * Finds and merges duplicate customers.
 *
 * The list is VIEW-ONLY. `merge` does nothing unless the organization has
 * switched `crm.customer.mergeEnabled` on, which ships OFF: the owner approves
 * the list first. A merge moves every document of the duplicate to the
 * surviving customer and marks the duplicate (it is never deleted, so its
 * CUS-xxxxx code stays reserved). There is no un-merge — the way back is the
 * database backup the administrator names before confirming.
 */
@Injectable()
export class CustomerMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly settings: OrgSettingsService,
    private readonly customers: CustomersService,
  ) {}

  async mergeEnabled(organizationId: string): Promise<boolean> {
    return this.settings.get<boolean>(
      organizationId,
      ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED,
      ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED],
    );
  }

  // ── the suggested list (read only) ────────────────────────────────────────

  /**
   * Groups of customers that look like one: they share a CR, VAT or mobile
   * number exactly, or their names are at least `threshold` alike. A customer
   * linked to another by either rule lands in the same group (connected
   * components), so a three-way duplicate is one group, not three pairs.
   */
  async duplicates(user: AuthUser) {
    const org = user.organizationId;
    const [mergeEnabled, threshold] = await Promise.all([
      this.mergeEnabled(org),
      this.customers.threshold(org),
    ]);

    const rows = await this.prisma.customer.findMany({
      where: { organizationId: org, mergedIntoId: null },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        nameNormalized: true,
        crNumber: true,
        vatNumber: true,
        mobile: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: SCAN_LIMIT + 1,
    });
    const truncated = rows.length > SCAN_LIMIT;
    const customers = truncated ? rows.slice(0, SCAN_LIMIT) : rows;

    // Union-find over customer indexes.
    const parent = customers.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a: number, b: number) => {
      parent[find(a)] = find(b);
    };
    const reasonEntries: Array<[number, DuplicateReason]> = [];
    const addReason = (i: number, r: DuplicateReason) => reasonEntries.push([i, r]);

    // (a) exact keys
    const keyed: Array<[DuplicateReason['kind'], (c: (typeof customers)[number]) => string | null]> = [
      ['CR', (c) => c.crNumber?.trim() || null],
      ['VAT', (c) => c.vatNumber?.trim() || null],
      ['MOBILE', (c) => c.mobile?.trim() || null],
    ];
    for (const [kind, pick] of keyed) {
      const byValue = new Map<string, number[]>();
      customers.forEach((c, i) => {
        const v = pick(c);
        if (v) byValue.set(v, [...(byValue.get(v) ?? []), i]);
      });
      for (const [value, idx] of byValue) {
        if (idx.length < 2) continue;
        for (const i of idx) {
          union(i, idx[0]);
          addReason(i, { kind: kind as 'CR' | 'VAT' | 'MOBILE', value });
        }
      }
    }

    // (b) similar names — whole normalised strings, never substrings.
    const profiles: NameProfile[] = customers.map((c) =>
      nameProfile(comparableName(c.nameNormalized ?? c.nameAr)),
    );
    for (let i = 0; i < customers.length; i += 1) {
      const a = profiles[i];
      if (a.size === 0) continue;
      for (let j = i + 1; j < customers.length; j += 1) {
        const b = profiles[j];
        if (b.size === 0) continue;
        // Dice can never exceed 2·min/(a+b): skip pairs whose lengths rule it out.
        if ((2 * Math.min(a.size, b.size)) / (a.size + b.size) < threshold) continue;
        const score = diceProfiles(a, b);
        if (score >= threshold) {
          union(i, j);
          const rounded = Math.round(score * 1000) / 1000;
          addReason(i, { kind: 'NAME', score: rounded });
          addReason(j, { kind: 'NAME', score: rounded });
        }
      }
    }

    const components = new Map<number, number[]>();
    customers.forEach((_, i) => {
      const root = find(i);
      components.set(root, [...(components.get(root) ?? []), i]);
    });
    const multi = [...components.values()].filter((idx) => idx.length > 1);

    // One reason per (kind, value) per group; for names, the best score seen.
    const reasonsByRoot = new Map<number, Map<string, DuplicateReason>>();
    for (const [i, r] of reasonEntries) {
      const root = find(i);
      const bucket = reasonsByRoot.get(root) ?? new Map<string, DuplicateReason>();
      const key = r.kind === 'NAME' ? 'NAME' : `${r.kind}:${r.value}`;
      const prev = bucket.get(key);
      if (!prev || (prev.kind === 'NAME' && r.kind === 'NAME' && r.score > prev.score)) bucket.set(key, r);
      reasonsByRoot.set(root, bucket);
    }
    if (multi.length === 0) {
      return { mergeEnabled, threshold, truncated, groups: [] as DuplicateGroup[] };
    }

    // Document counts for every member of every group, in seven grouped queries.
    const memberIds = multi.flat().map((i) => customers[i].id);
    const where = { organizationId: org, customerId: { in: memberIds } };
    const [leads, opps, contracts, invoices, contacts, activities, followUpTasks] = await Promise.all([
      this.prisma.lead.groupBy({ by: ['customerId'], where, _count: { _all: true } }),
      this.prisma.opportunity.groupBy({ by: ['customerId'], where, _count: { _all: true } }),
      this.prisma.contract.groupBy({ by: ['customerId'], where, _count: { _all: true } }),
      this.prisma.invoice.groupBy({ by: ['customerId'], where, _count: { _all: true } }),
      this.prisma.customerContact.groupBy({ by: ['customerId'], where, _count: { _all: true } }),
      this.prisma.activity.groupBy({ by: ['customerId'], where, _count: { _all: true } }),
      this.prisma.followUpTask.groupBy({ by: ['customerId'], where, _count: { _all: true } }),
    ]);
    const tally = (rowsIn: Array<{ customerId: string | null; _count: { _all: number } }>) =>
      new Map(rowsIn.map((r) => [r.customerId, r._count._all]));
    const tl = tally(leads);
    const to = tally(opps);
    const tc = tally(contracts);
    const ti = tally(invoices);
    const tk = tally(contacts);
    const ta = tally(activities);
    const tt = tally(followUpTasks);

    const groups: DuplicateGroup[] = multi.map((idx, n) => {
      const members: DuplicateMember[] = idx.map((i) => {
        const c = customers[i];
        const counts = {
          leads: tl.get(c.id) ?? 0,
          opportunities: to.get(c.id) ?? 0,
          contracts: tc.get(c.id) ?? 0,
          invoices: ti.get(c.id) ?? 0,
          contacts: tk.get(c.id) ?? 0,
          activities: ta.get(c.id) ?? 0,
          followUpTasks: tt.get(c.id) ?? 0,
        };
        return {
          id: c.id,
          code: c.code,
          nameAr: c.nameAr,
          nameEn: c.nameEn,
          crNumber: c.crNumber,
          vatNumber: c.vatNumber,
          mobile: c.mobile,
          createdAt: c.createdAt,
          counts,
          totalDocuments:
            counts.leads +
            counts.opportunities +
            counts.contracts +
            counts.invoices +
            counts.contacts +
            counts.activities +
            counts.followUpTasks,
        };
      });
      // The record that already carries the most documents survives; on a tie
      // the oldest (members are in creation order already).
      const suggested = members.reduce((best, m) => (m.totalDocuments > best.totalDocuments ? m : best), members[0]);
      const reasons = [...(reasonsByRoot.get(find(idx[0]))?.values() ?? [])];
      return { id: `g${n + 1}`, reasons, members, suggestedSurvivorId: suggested.id };
    });
    groups.sort((a, b) => b.members.length - a.members.length);
    groups.forEach((g, n) => (g.id = `g${n + 1}`));

    return { mergeEnabled, threshold, truncated, groups };
  }

  // ── the merge ─────────────────────────────────────────────────────────────

  /**
   * Merge each of `mergedIds` into `survivorId`, one transaction per merged
   * customer. Refuses outright (403) while the merge switch is off.
   */
  async merge(user: AuthUser, dto: MergeCustomersDto) {
    const org = user.organizationId;
    if (!(await this.mergeEnabled(org))) {
      throw new ForbiddenException('Customer merge is disabled');
    }

    const backupRef = (dto.backupRef ?? '').trim();
    if (backupRef.length < MIN_BACKUP_REF) {
      throw new BadRequestException(
        `backupRef must be the file name of the backup taken before merging (at least ${MIN_BACKUP_REF} characters)`,
      );
    }
    const mergedIds = [...new Set(dto.mergedIds ?? [])];
    if (mergedIds.length === 0) throw new BadRequestException('mergedIds must not be empty');
    if (mergedIds.includes(dto.survivorId)) {
      throw new BadRequestException('The surviving customer cannot also be merged into itself');
    }

    // Validate EVERYTHING before the first write, so a bad id in position 3
    // cannot leave positions 1 and 2 already merged.
    const found = await this.prisma.customer.findMany({
      where: { organizationId: org, id: { in: [dto.survivorId, ...mergedIds] } },
      select: { id: true, mergedIntoId: true },
    });
    const byId = new Map(found.map((c) => [c.id, c]));
    for (const id of [dto.survivorId, ...mergedIds]) {
      const c = byId.get(id);
      if (!c) throw new NotFoundException('Customer not found');
      if (c.mergedIntoId) throw new ConflictException('Customer already merged');
    }

    const results: Array<{ mergedId: string; code: string; moved: Record<string, number> }> = [];
    for (const mergedId of mergedIds) {
      results.push(await this.mergeOne(user, dto.survivorId, mergedId, backupRef));
    }
    return { survivorId: dto.survivorId, merged: results };
  }

  private async mergeOne(user: AuthUser, survivorId: string, mergedId: string, backupRef: string) {
    const org = user.organizationId;
    return this.prisma.$transaction(async (tx) => {
      // Two merges touching the same customers must not interleave.
      await tx.$queryRaw`SELECT "id" FROM "Customer"
        WHERE "organizationId" = ${org} AND "id" IN (${Prisma.join([survivorId, mergedId])})
        ORDER BY "id" FOR UPDATE`;

      const survivor = await tx.customer.findFirst({ where: { id: survivorId, organizationId: org } });
      const merged = await tx.customer.findFirst({ where: { id: mergedId, organizationId: org } });
      if (!survivor || !merged) throw new NotFoundException('Customer not found');
      if (survivor.mergedIntoId || merged.mergedIntoId) {
        throw new ConflictException('Customer already merged');
      }
      const snapshot = JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonObject;

      // Mark first: the duplicate leaves the "active" set, which lets the
      // survivor take over a key the duplicate held without tripping the
      // partial unique indexes of migration 0023.
      const now = new Date();
      await tx.customer.update({
        where: { id: merged.id },
        data: { mergedIntoId: survivor.id, mergedAt: now },
      });

      const scope = { organizationId: org };
      const moveTo = { customerId: survivor.id };
      const moved: Record<string, number> = {
        Lead: (await tx.lead.updateMany({ where: { ...scope, customerId: merged.id }, data: moveTo })).count,
        Opportunity: (await tx.opportunity.updateMany({ where: { ...scope, customerId: merged.id }, data: moveTo })).count,
        Contract: (await tx.contract.updateMany({ where: { ...scope, customerId: merged.id }, data: moveTo })).count,
        Invoice: (await tx.invoice.updateMany({ where: { ...scope, customerId: merged.id }, data: moveTo })).count,
      };

      // Contacts: only one may be primary, and the survivor's wins.
      const survivorHasPrimary =
        (await tx.customerContact.count({
          where: { ...scope, customerId: survivor.id, isPrimary: true },
        })) > 0;
      moved.CustomerContact = (
        await tx.customerContact.updateMany({
          where: { ...scope, customerId: merged.id },
          data: survivorHasPrimary ? { ...moveTo, isPrimary: false } : moveTo,
        })
      ).count;

      moved.Attachment = (
        await tx.attachment.updateMany({
          where: { ...scope, entityType: 'CUSTOMER', entityId: merged.id },
          data: { entityId: survivor.id },
        })
      ).count;

      // CRM Step 5: the communication log and the follow-up tasks follow the customer.
      // (Files attached to a log entry hang off the ENTRY, whose id does not change.)
      // Reported only when there was something to move, so the shape of every earlier
      // merge — and of the rows already written to the merge log — is unchanged.
      const activities = (await tx.activity.updateMany({ where: { ...scope, customerId: merged.id }, data: moveTo })).count;
      if (activities > 0) moved.Activity = activities;
      const followUps = (await tx.followUpTask.updateMany({ where: { ...scope, customerId: merged.id }, data: moveTo })).count;
      if (followUps > 0) moved.FollowUpTask = followUps;

      // Fill the survivor's EMPTY fields from the duplicate; never overwrite.
      const empty = (v: string | null | undefined) => v === null || v === undefined || v.trim() === '';
      const fill: Prisma.CustomerUpdateInput = {};
      if (empty(survivor.vatNumber) && !empty(merged.vatNumber)) fill.vatNumber = merged.vatNumber;
      if (empty(survivor.crNumber) && !empty(merged.crNumber)) fill.crNumber = merged.crNumber;
      if (empty(survivor.mobile) && !empty(merged.mobile)) fill.mobile = merged.mobile;
      if (empty(survivor.phone) && !empty(merged.phone)) fill.phone = merged.phone;
      if (empty(survivor.email) && !empty(merged.email)) fill.email = merged.email;
      if (empty(survivor.nameEn) && !empty(merged.nameEn)) fill.nameEn = merged.nameEn;

      let survivorAfter = survivor;
      if (Object.keys(fill).length > 0) {
        // A key about to be inherited may already belong to a THIRD customer.
        await this.customers.assertNoDuplicateKeys(
          tx,
          org,
          {
            crNumber: fill.crNumber as string | undefined,
            vatNumber: fill.vatNumber as string | undefined,
            mobile: fill.mobile as string | undefined,
          },
          survivor.id,
        );
        survivorAfter = await tx.customer.update({ where: { id: survivor.id }, data: fill });
      }

      await tx.customerMergeLog.create({
        data: {
          organizationId: org,
          survivorId: survivor.id,
          mergedId: merged.id,
          movedJson: moved,
          mergedSnapshotJson: snapshot,
          backupRef,
          performedById: user.userId,
        },
      });

      for (const entityId of [survivor.id, merged.id]) {
        await this.audit.record(
          {
            organizationId: org,
            actorId: user.userId,
            entityType: 'Customer',
            entityId,
            action: 'MERGE',
            before: merged,
            after: survivorAfter,
          },
          tx,
        );
      }

      await this.outbox.emit(tx, {
        organizationId: org,
        eventCode: WF_EVENTS.CUSTOMER_MERGED,
        payload: {
          documentType: 'Customer',
          documentId: merged.id,
          documentCode: merged.code,
          fromState: 'ACTIVE',
          toState: 'MERGED',
          actorId: user.userId,
          survivorId: survivor.id,
          survivorCode: survivor.code,
          moved,
        },
      });

      return { mergedId: merged.id, code: merged.code, moved };
    });
  }
}
