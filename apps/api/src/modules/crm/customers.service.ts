import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PERMISSIONS,
  comparableName,
  diceProfiles,
  mobileSearchFragment,
  nameProfile,
  normalizeArabicName,
  normalizeSaudiMobile,
} from '@npi/shared';
import type { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../common/numbering.service';
import { AuditService } from '../../common/audit.service';
import {
  ORG_SETTING_DEFAULTS,
  ORG_SETTING_KEYS,
  OrgSettingsService,
} from '../../common/org-settings.service';
import type { AuthUser } from '../../common/auth-user';
import { CreateCustomerDto, UpdateCustomerDto } from './dto';

/** The three unique keys of a customer (§4.1). */
export type CustomerKeyField = 'crNumber' | 'vatNumber' | 'mobile';
export interface CustomerKeys {
  crNumber?: string | null;
  vatNumber?: string | null;
  mobile?: string | null;
}

/** Rows read for the in-memory similarity scan (see `similar`). */
const SIMILARITY_SCAN_LIMIT = 5000;
const SIMILAR_RESULTS = 5;

const MOBILE_MESSAGE =
  'mobile must be a Saudi mobile number (05xxxxxxxx or +9665xxxxxxxx)';

/** Trim; the empty string means "no value". */
const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly settings: OrgSettingsService,
  ) {}

  /**
   * Merged-away customers are hidden unless the caller asks for them AND may
   * merge (`crm.customer.merge`) — a duplicate is a record only the person
   * cleaning up duplicates has a reason to see.
   */
  list(user: AuthUser, search?: string, includeMerged = false) {
    const showMerged = includeMerged && user.permissions.includes(PERMISSIONS.CUSTOMER_MERGE);
    const term = search?.trim();
    const mobileFrag = mobileSearchFragment(term);
    return this.prisma.customer.findMany({
      where: {
        organizationId: user.organizationId,
        ...(showMerged ? {} : { mergedIntoId: null }),
        ...(term
          ? {
              OR: [
                { nameAr: { contains: term, mode: 'insensitive' } },
                { nameEn: { contains: term, mode: 'insensitive' } },
                { code: { contains: term, mode: 'insensitive' } },
                { crNumber: { contains: term } },
                { vatNumber: { contains: term } },
                ...(mobileFrag ? [{ mobile: { contains: mobileFrag } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The customer, with the record it was merged into when it was merged away. */
  async get(user: AuthUser, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { mergedInto: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  // ── duplicate keys ────────────────────────────────────────────────────────

  /**
   * Normalise the three keys the way they are stored and compared: trimmed,
   * empty → null, mobile → +9665xxxxxxxx. `undefined` stays undefined (an
   * update that does not mention a key must not clear it).
   */
  normalizeKeys(dto: CustomerKeys): CustomerKeys {
    const out: CustomerKeys = {};
    if (dto.crNumber !== undefined) out.crNumber = clean(dto.crNumber);
    if (dto.vatNumber !== undefined) out.vatNumber = clean(dto.vatNumber);
    if (dto.mobile !== undefined) {
      const raw = clean(dto.mobile);
      if (raw === null) out.mobile = null;
      else {
        const normalized = normalizeSaudiMobile(raw);
        if (!normalized) throw new BadRequestException(MOBILE_MESSAGE);
        out.mobile = normalized;
      }
    }
    return out;
  }

  /**
   * Refuse a CR / VAT / mobile that another (not merged-away) customer of the
   * same organization already carries. Runs inside the caller's transaction.
   * The error carries the existing record so the UI can offer to open it; a
   * rejection is audited by the caller's failed request, not as an event.
   */
  async assertNoDuplicateKeys(
    tx: Prisma.TransactionClient,
    organizationId: string,
    keys: CustomerKeys,
    excludeId?: string,
  ): Promise<void> {
    const fields: CustomerKeyField[] = ['crNumber', 'vatNumber', 'mobile'];
    for (const field of fields) {
      const value = keys[field];
      if (!value) continue;
      const existing = await tx.customer.findFirst({
        where: {
          organizationId,
          mergedIntoId: null,
          [field]: value,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true, code: true, nameAr: true, nameEn: true },
      });
      if (existing) {
        throw new ConflictException({
          statusCode: 409,
          message: `Duplicate customer key: ${field} already used by ${existing.code} (${existing.nameAr})`,
          code: 'CUSTOMER_DUPLICATE',
          field,
          existing,
        });
      }
    }
  }

  // ── similar names ─────────────────────────────────────────────────────────

  /**
   * Up to five customers whose name is at least as close to `name` as the
   * organization's threshold (default 0.8), closest first. Scans the
   * organization's customers in memory (capped at 5,000): ample for the current
   * volume, and `pg_trgm` is the documented upgrade if it ever is not.
   */
  async similar(user: AuthUser, name: string, excludeId?: string) {
    const query = comparableName(name);
    if (query.length < 2) return [];
    const threshold = await this.threshold(user.organizationId);
    const q = nameProfile(query);
    const rows = await this.prisma.customer.findMany({
      where: {
        organizationId: user.organizationId,
        mergedIntoId: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        nameNormalized: true,
        entityKind: true,
      },
      take: SIMILARITY_SCAN_LIMIT,
    });
    const scored: Array<{
      id: string;
      code: string;
      nameAr: string;
      nameEn: string;
      entityKind: string;
      score: number;
    }> = [];
    for (const r of rows) {
      const ar = diceProfiles(q, nameProfile(comparableName(r.nameNormalized ?? r.nameAr)));
      // The English name counts too: someone typing «Riyadh Industries» must
      // find the record that was keyed in Arabic with an English twin.
      const en = r.nameEn ? diceProfiles(q, nameProfile(comparableName(r.nameEn))) : 0;
      const score = Math.max(ar, en);
      if (score >= threshold) {
        scored.push({
          id: r.id,
          code: r.code,
          nameAr: r.nameAr,
          nameEn: r.nameEn,
          entityKind: r.entityKind,
          score: Math.round(score * 1000) / 1000,
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, SIMILAR_RESULTS);
  }

  /** The organization's similarity threshold, clamped to a sane (0, 1] range. */
  async threshold(organizationId: string): Promise<number> {
    const t = await this.settings.get<number>(
      organizationId,
      ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD,
      ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD],
    );
    return t > 0 && t <= 1 ? t : 0.8;
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateCustomerDto) {
    const entityKind = dto.entityKind ?? 'COMPANY';
    const keys = this.normalizeKeys({
      crNumber: dto.crNumber ?? null,
      vatNumber: dto.vatNumber ?? null,
      mobile: dto.mobile ?? null,
    });

    // The mandatory key depends on who the customer is. This binds NEW records
    // only: customers created before Step 2 may lack it and stay editable.
    if (entityKind === 'INDIVIDUAL' && !keys.mobile) {
      throw new BadRequestException('An individual customer requires a mobile number');
    }
    if (entityKind === 'COMPANY' && !keys.crNumber && !keys.vatNumber) {
      throw new BadRequestException('A company customer requires a CR number or a VAT number');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.assertNoDuplicateKeys(tx, user.organizationId, keys);
      const code = await this.numbering.next(user.organizationId, 'CUSTOMER', tx);
      const created = await tx.customer.create({
        data: {
          organizationId: user.organizationId,
          code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn,
          nameNormalized: normalizeArabicName(dto.nameAr),
          entityKind,
          customerType: dto.customerType ?? 'CI',
          vatNumber: keys.vatNumber,
          crNumber: keys.crNumber,
          mobile: keys.mobile,
          creditTermsDays: dto.creditTermsDays ?? 0,
          phone: clean(dto.phone),
          email: dto.email,
        },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Customer',
          entityId: created.id,
          action: 'CREATE',
          after: created,
        },
        tx,
      );
      return created;
    });
  }

  /**
   * Edit a customer — read, duplicate-check, write and audit in ONE
   * transaction (the audit row used to be written after, outside it). A
   * merged-away record is frozen: edit the survivor instead.
   */
  async update(user: AuthUser, id: string, dto: UpdateCustomerDto) {
    const keys = this.normalizeKeys({
      crNumber: dto.crNumber,
      vatNumber: dto.vatNumber,
      mobile: dto.mobile,
    });
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { id, organizationId: user.organizationId },
      });
      if (!existing) throw new NotFoundException('Customer not found');
      if (existing.mergedIntoId) throw new ConflictException('Customer already merged');

      await this.assertNoDuplicateKeys(tx, user.organizationId, keys, existing.id);

      const data: Prisma.CustomerUpdateInput = {};
      if (dto.nameAr !== undefined) {
        data.nameAr = dto.nameAr;
        data.nameNormalized = normalizeArabicName(dto.nameAr);
      }
      if (dto.nameEn !== undefined) data.nameEn = dto.nameEn;
      if (dto.customerType !== undefined) data.customerType = dto.customerType;
      if (dto.entityKind !== undefined) data.entityKind = dto.entityKind;
      if (dto.creditTermsDays !== undefined) data.creditTermsDays = dto.creditTermsDays;
      if (dto.phone !== undefined) data.phone = clean(dto.phone);
      if (dto.email !== undefined) data.email = dto.email;
      if (keys.crNumber !== undefined) data.crNumber = keys.crNumber;
      if (keys.vatNumber !== undefined) data.vatNumber = keys.vatNumber;
      if (keys.mobile !== undefined) data.mobile = keys.mobile;

      const updated = await tx.customer.update({ where: { id: existing.id }, data });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId: user.userId,
          entityType: 'Customer',
          entityId: id,
          action: 'UPDATE',
          before: existing,
          after: updated,
        },
        tx,
      );
      return updated;
    });
  }

  // ── the single-page view (§5) ─────────────────────────────────────────────

  /**
   * Everything the customer page shows, in one round trip: the record, counts
   * and the first 50 rows of each tab. Each list is read only if the caller
   * holds the READ permission of the module it comes from, and is omitted from
   * the response otherwise — the page hides the tab.
   */
  async overview(user: AuthUser, id: string) {
    const customer = await this.get(user, id);
    const org = user.organizationId;
    const has = (p: string) => user.permissions.includes(p);
    const TAKE = 50;
    const out: Record<string, unknown> = { customer };

    const contactsWhere = { organizationId: org, customerId: id };
    const [contacts, contactsCount] = await Promise.all([
      this.prisma.customerContact.findMany({
        where: contactsWhere,
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        take: TAKE,
      }),
      this.prisma.customerContact.count({ where: contactsWhere }),
    ]);
    out.contacts = contacts;
    const counts: Record<string, number> = { contacts: contactsCount };

    const tasks: Array<Promise<void>> = [];

    if (has(PERMISSIONS.OPPORTUNITY_READ)) {
      const where = { organizationId: org, customerId: id };
      tasks.push(
        Promise.all([
          this.prisma.opportunity.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: TAKE,
            select: {
              id: true,
              code: true,
              name: true,
              stage: true,
              opportunityType: true,
              estimatedValue: true,
              currency: true,
              expectedCloseDate: true,
              createdAt: true,
            },
          }),
          this.prisma.opportunity.count({ where }),
        ]).then(([rows, n]) => {
          out.opportunities = rows;
          counts.opportunities = n;
        }),
      );
    }

    if (has(PERMISSIONS.PROPOSAL_READ)) {
      // Proposals hang off opportunities. Pricing is deliberately not selected:
      // it is cost-redacted elsewhere and the overview is a navigation aid.
      const where = { organizationId: org, opportunity: { customerId: id } };
      tasks.push(
        Promise.all([
          this.prisma.proposal.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: TAKE,
            select: {
              id: true,
              code: true,
              status: true,
              currency: true,
              createdAt: true,
              opportunity: { select: { id: true, code: true, name: true } },
            },
          }),
          this.prisma.proposal.count({ where }),
        ]).then(([rows, n]) => {
          out.proposals = rows;
          counts.proposals = n;
        }),
      );
    }

    if (has(PERMISSIONS.CONTRACT_READ)) {
      const where = { organizationId: org, customerId: id };
      tasks.push(
        Promise.all([
          this.prisma.contract.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: TAKE,
            select: {
              id: true,
              code: true,
              contractType: true,
              status: true,
              totalValue: true,
              currency: true,
              startDate: true,
              endDate: true,
              createdAt: true,
            },
          }),
          this.prisma.contract.count({ where }),
        ]).then(([rows, n]) => {
          out.contracts = rows;
          counts.contracts = n;
        }),
      );
    }

    if (has(PERMISSIONS.PROJECT_READ)) {
      const where = { organizationId: org, contract: { customerId: id } };
      tasks.push(
        Promise.all([
          this.prisma.project.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: TAKE,
            select: {
              id: true,
              code: true,
              nameAr: true,
              nameEn: true,
              stage: true,
              capacityKwp: true,
              contract: { select: { id: true, code: true } },
            },
          }),
          this.prisma.project.count({ where }),
        ]).then(([rows, n]) => {
          out.projects = rows;
          counts.projects = n;
        }),
      );
    }

    // Progress claims are SUBCONTRACTOR claims against the customer's projects
    // (a cost to the company), so they need both the procurement read key and
    // the cost-visibility key.
    if (has(PERMISSIONS.PROCUREMENT_READ) && has(PERMISSIONS.COSTS_VIEW)) {
      const where = {
        organizationId: org,
        agreement: { project: { contract: { customerId: id } } },
      };
      tasks.push(
        Promise.all([
          this.prisma.progressClaim.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: TAKE,
            select: {
              id: true,
              code: true,
              sequence: true,
              claimedAmount: true,
              status: true,
              createdAt: true,
              agreement: {
                select: {
                  id: true,
                  code: true,
                  project: { select: { id: true, code: true, nameAr: true, nameEn: true } },
                },
              },
            },
          }),
          this.prisma.progressClaim.count({ where }),
        ]).then(([rows, n]) => {
          out.claims = rows;
          counts.claims = n;
        }),
      );
    }

    await Promise.all(tasks);
    out.counts = counts;
    return out;
  }
}
