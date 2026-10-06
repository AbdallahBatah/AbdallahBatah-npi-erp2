import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import type { Prisma } from '@npi/db';

/**
 * Keys of the per-organization settings table (`OrgSetting`). CRM Step 2 reads
 * the first two; Steps 4 and 5 add their own here.
 */
export const ORG_SETTING_KEYS = {
  /** Name similarity (0..1) at which two customers are called alike. */
  CUSTOMER_SIMILARITY_THRESHOLD: 'crm.customer.similarityThreshold',
  /** Master switch of the customer merge tool. Shipped OFF. */
  CUSTOMER_MERGE_ENABLED: 'crm.customer.mergeEnabled',
} as const;

/** What a missing row means. Migration 0022 also writes these as rows. */
export const ORG_SETTING_DEFAULTS = {
  [ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD]: 0.8,
  [ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED]: false,
} as const;

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
