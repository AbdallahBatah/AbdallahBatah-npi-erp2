import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import type { Prisma } from '@npi/db';

/**
 * Keys of the per-organization settings table (`OrgSetting`). CRM Step 2 reads
 * the first two, Step 4 the proposal pair, Step 5 the follow-up reminder pair.
 */
export const ORG_SETTING_KEYS = {
  /** Name similarity (0..1) at which two customers are called alike. */
  CUSTOMER_SIMILARITY_THRESHOLD: 'crm.customer.similarityThreshold',
  /** Master switch of the customer merge tool. Shipped OFF. */
  CUSTOMER_MERGE_ENABLED: 'crm.customer.mergeEnabled',
  /** Days a new proposal revision is valid when the author names no date. */
  PROPOSAL_VALIDITY_DAYS: 'crm.proposal.validityDays',
  /** A line cost older than this many days (or of unknown age) is warned about. */
  PROPOSAL_COST_AGE_WARN_DAYS: 'crm.proposal.costAgeWarnDays',
  /** Package 3 · P3-6: a budget whose margin is under this percentage is flagged to the approver. */
  PROPOSAL_MIN_MARGIN_PCT: 'crm.proposal.minMarginPct',
  /** A follow-up task's reminder goes this many days before its due day (0 = on the day). */
  TASK_REMINDER_DAYS_BEFORE: 'crm.task.reminderDaysBefore',
  /** ...at this hour, Riyadh time (0..23). */
  TASK_REMINDER_HOUR: 'crm.task.reminderHour',
} as const;

/** What a missing row means. Migration 0022 also writes these as rows. */
export const ORG_SETTING_DEFAULTS = {
  [ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD]: 0.8,
  [ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED]: false,
  [ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS]: 30,
  [ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS]: 30,
  [ORG_SETTING_KEYS.PROPOSAL_MIN_MARGIN_PCT]: 15,
  [ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE]: 1,
  [ORG_SETTING_KEYS.TASK_REMINDER_HOUR]: 8,
} as const;

const isDays = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365;
const isIntBetween = (lo: number, hi: number) => (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * The settings an administrator may edit from the screen (GET / PATCH /admin/settings),
 * each with the rule its value must satisfy. The merge master switch is deliberately
 * NOT here: turning it on is a decision taken with the data in hand, in SQL.
 */
export const ORG_SETTING_EDITABLE: Record<string, { valid: (v: unknown) => boolean }> = {
  [ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS]: { valid: isDays },
  [ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS]: { valid: isDays },
  [ORG_SETTING_KEYS.PROPOSAL_MIN_MARGIN_PCT]: { valid: isIntBetween(0, 100) },
  [ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE]: { valid: isIntBetween(0, 30) },
  [ORG_SETTING_KEYS.TASK_REMINDER_HOUR]: { valid: isIntBetween(0, 23) },
  [ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD]: {
    valid: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 1,
  },
};

type Client = Prisma.TransactionClient | PrismaService;

/**
 * Typed access to `OrgSetting` (organization + key → JSON value). A setting
 * that has no row, or whose stored value is not the type the caller expects,
 * yields the caller's default — a corrupt row must not switch a safety flag on.
 */
@Injectable()
export class OrgSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get<T extends string | number | boolean>(
    organizationId: string,
    key: string,
    defaultValue: T,
    tx?: Prisma.TransactionClient,
  ): Promise<T> {
    const client: Client = tx ?? this.prisma;
    const row = await client.orgSetting.findUnique({
      where: { organizationId_key: { organizationId, key } },
      select: { valueJson: true },
    });
    if (!row) return defaultValue;
    return typeof row.valueJson === typeof defaultValue ? (row.valueJson as T) : defaultValue;
  }

  /** The editable settings with their current values (stored, else the default). */
  async getEditable(organizationId: string): Promise<Record<string, string | number | boolean>> {
    const keys = Object.keys(ORG_SETTING_EDITABLE);
    const rows = await this.prisma.orgSetting.findMany({
      where: { organizationId, key: { in: keys } },
      select: { key: true, valueJson: true },
    });
    const stored = new Map(rows.map((r) => [r.key, r.valueJson]));
    const out: Record<string, string | number | boolean> = {};
    for (const key of keys) {
      const fallback = (ORG_SETTING_DEFAULTS as Record<string, string | number | boolean>)[key];
      const value = stored.get(key);
      out[key] = value !== undefined && typeof value === typeof fallback ? (value as string | number | boolean) : fallback;
    }
    return out;
  }

  /**
   * Write several editable settings at once: all valid or none written. An unknown
   * key (or one that exists but is not editable here) and a value outside its range
   * are both 400s, decided before anything is written.
   */
  async setEditable(
    organizationId: string,
    patch: Record<string, unknown>,
    actorId: string | null,
  ): Promise<void> {
    const entries = Object.entries(patch);
    for (const [key, value] of entries) {
      const rule = Object.prototype.hasOwnProperty.call(ORG_SETTING_EDITABLE, key) ? ORG_SETTING_EDITABLE[key] : undefined;
      if (!rule) throw new BadRequestException('Unknown setting key');
      if (!rule.valid(value)) throw new BadRequestException('Setting value out of range');
    }
    if (entries.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      for (const [key, value] of entries) {
        await this.set(organizationId, key, value as string | number | boolean, actorId, tx);
      }
    });
  }

  /** Upsert a setting and record the change (before / after) in the audit trail. */
  async set(
    organizationId: string,
    key: string,
    value: string | number | boolean,
    actorId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (client: Prisma.TransactionClient) => {
      const before = await client.orgSetting.findUnique({
        where: { organizationId_key: { organizationId, key } },
      });
      const after = await client.orgSetting.upsert({
        where: { organizationId_key: { organizationId, key } },
        create: { organizationId, key, valueJson: value },
        update: { valueJson: value },
      });
      await this.audit.record(
        {
          organizationId,
          actorId,
          entityType: 'OrgSetting',
          entityId: after.id,
          action: before ? 'UPDATE' : 'CREATE',
          before,
          after,
        },
        client,
      );
    };
    if (tx) await run(tx);
    else await this.prisma.$transaction(run);
  }
}
