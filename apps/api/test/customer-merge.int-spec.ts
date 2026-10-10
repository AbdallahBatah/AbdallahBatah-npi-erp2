/**
 * CRM Phase 1 · Step 2 — the unified customer record and the duplicate merge,
 * against a real PostgreSQL.
 *
 * Two fresh organizations are built: M (where the merge happens) and X (a
 * neighbour, to prove the merge cannot reach across the tenant boundary).
 * Customers and the documents hanging off them are written directly through
 * Prisma so the scenario does not depend on the pricing / posting machinery;
 * the services under test are CustomersService, CustomerContactsService and
 * CustomerMergeService, built by hand like the other integration specs.
 */
import { ConflictException, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@npi/db';
import { normalizeArabicName, normalizeSaudiMobile } from '@npi/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { NumberingService } from '../src/common/numbering.service';
import { AuditService } from '../src/common/audit.service';
import { OrgSettingsService, ORG_SETTING_KEYS } from '../src/common/org-settings.service';
import { OutboxService } from '../src/common/workflow/outbox.service';
import { CustomersService } from '../src/modules/crm/customers.service';
import { CustomerContactsService } from '../src/modules/crm/customer-contacts.service';
import { CustomerMergeService } from '../src/modules/crm/customer-merge.service';
import type { AuthUser } from '../src/common/auth-user';

const prisma = new PrismaService();
const numbering = new NumberingService(prisma);
const audit = new AuditService(prisma);
const settings = new OrgSettingsService(prisma, audit);
const customers = new CustomersService(prisma, numbering, audit, settings);
const contacts = new CustomerContactsService(prisma, audit);
const merges = new CustomerMergeService(prisma, audit, new OutboxService(prisma), settings, customers);

let ORG_M = '';
let ORG_X = '';
let USER_M: AuthUser;
let USER_X: AuthUser;

const suffix = `${Date.now()}`;
/** 10-digit CR numbers unique per run. */
const cr = (n: number) => `${suffix.slice(-8)}${String(n).padStart(2, '0')}`;
/** Saudi mobiles unique per run. */
const mobile = (n: number) => `05${suffix.slice(-7)}${n}`;

async function newOrg(label: string): Promise<{ id: string; user: AuthUser }> {
  const org = await prisma.organization.create({
    data: { legalNameAr: `منشأة اختبار الدمج ${label}`, legalNameEn: `Merge Test ${label} ${suffix}`, baseCurrency: 'SAR' },
  });
  const source = await prisma.organization.findFirstOrThrow({
    where: { numberingSequences: { some: { documentType: 'CUSTOMER' } }, id: { not: org.id } },
    select: { id: true },
  });
  const sequences = await prisma.numberingSequence.findMany({ where: { organizationId: source.id, documentType: 'CUSTOMER' } });
  await prisma.numberingSequence.createMany({
    data: sequences.map((s) => ({
      organizationId: org.id, documentType: s.documentType, prefix: s.prefix, fiscalYear: s.fiscalYear, nextValue: 1, padding: s.padding,
    })),
  });
  return {
    id: org.id,
    user: { userId: `merge-test-user-${label}`, organizationId: org.id, permissions: ['crm.customer.merge'] } as unknown as AuthUser,
  };
}

/** What a customer owns, counted from the tables. */
async function owned(organizationId: string, customerId: string) {
  const where = { organizationId, customerId };
  const [leads, opportunities, contracts, invoices, contactRows, attachments] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.opportunity.count({ where }),
    prisma.contract.count({ where }),
    prisma.invoice.count({ where }),
    prisma.customerContact.count({ where }),
    prisma.attachment.count({ where: { organizationId, entityType: 'CUSTOMER', entityId: customerId } }),
  ]);
  return { leads, opportunities, contracts, invoices, contacts: contactRows, attachments };
}

async function hang(organizationId: string, customerId: string, tag: string) {
  await prisma.lead.create({ data: { organizationId, code: `L-${tag}`, contactName: `lead ${tag}`, customerId } });
  await prisma.opportunity.create({ data: { organizationId, code: `O-${tag}`, name: `opp ${tag}`, customerId } });
  await prisma.contract.create({ data: { organizationId, code: `C-${tag}`, customerId } });
  await prisma.invoice.create({ data: { organizationId, code: `I-${tag}`, customerId } });
  await prisma.attachment.create({
    data: {
      organizationId, entityType: 'CUSTOMER', entityId: customerId, fileName: `${tag}.pdf`,
      mimeType: 'application/pdf', sizeBytes: 1, storageKey: `merge-test/${suffix}-${tag}.pdf`,
    },
  });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    throw new Error('Refusing to run against a non-local database');
  }
  const m = await newOrg('M');
  const x = await newOrg('X');
  ORG_M = m.id; USER_M = m.user;
  ORG_X = x.id; USER_X = x.user;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ── the SQL functions that back-filled the columns equal the TypeScript ones ──

describe('SQL and TypeScript normalisation agree (migration 0022 back-fill)', () => {
  const NAMES = [
    'شركة الرياض للصناعات', 'مصنع الرياض للصناعات', 'أحمد العلي', 'احمد العلى', 'مُحَمَّد', 'الــرياض',
    'آل سعود', 'ال', 'الف ليلة', 'الله', 'إبراهيم الأنصاري', 'مؤسسة النور للتجارة المحدودة',
    'ش.م.م', 'ذ.م.م', 'Riyadh  Industries, Co.', 'GULF Solar LLC', 'عميل-الجارة (فرع 2)', 'مصنع ٧٠٠',
    'شركة ۱۲۳ للتقنية', 'رئيس مجلس الإدارة', '  مسافات   كثيرة  ', 'ABC-123 مصنع', '', 'ء', 'ؤئ ةى',
    'الشركة الوطنية للطاقة الشمسية والصناعية', 'ألف باء', 'آمنة بنت محمد', 'x', 'نور الدين، وولده',
    'العميل الأول', 'ال ال ال', "O'Brien & Sons", 'ـــ', 'مكتب الاستشارات الهندسية',
  ];
  const MOBILES = [
    '0501234567', '+966501234567', '966501234567', '00966501234567', '501234567', '050 123 4567',
    '+966 (50) 123-4567', '٠٥٠١٢٣٤٥٦٧', '0112345678', '+966112345678', '0601234567', '05012345',
    '', 'abc', '05.0123.4567', '5012345678', '0550000000', '+9665500000000', '٥٠١٢٣٤٥٦٧',
  ];

  it('npi_normalize_arabic_name equals normalizeArabicName on every sample', async () => {
    const mismatches: string[] = [];
    for (const name of NAMES) {
      const rows = await prisma.$queryRaw<Array<{ n: string | null }>>`SELECT npi_normalize_arabic_name(${name}) AS n`;
      if (rows[0].n !== normalizeArabicName(name)) {
        mismatches.push(`${JSON.stringify(name)}: sql=${JSON.stringify(rows[0].n)} ts=${JSON.stringify(normalizeArabicName(name))}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('npi_normalize_saudi_mobile equals normalizeSaudiMobile on every sample', async () => {
    const mismatches: string[] = [];
    for (const m of MOBILES) {
      const rows = await prisma.$queryRaw<Array<{ n: string | null }>>`SELECT npi_normalize_saudi_mobile(${m}) AS n`;
      if (rows[0].n !== normalizeSaudiMobile(m)) {
        mismatches.push(`${JSON.stringify(m)}: sql=${JSON.stringify(rows[0].n)} ts=${JSON.stringify(normalizeSaudiMobile(m))}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('the migration back-filled the existing rows with the same values', async () => {
    const rows = await prisma.customer.findMany({ select: { code: true, nameAr: true, nameNormalized: true, createdAt: true } });
    // Rows created before this step carry the SQL value; newer ones the service's. Either way: equal.
    const wrong = rows.filter((r) => r.nameNormalized !== null && r.nameNormalized !== normalizeArabicName(r.nameAr));
    expect(wrong).toEqual([]);
  });
});

// ── duplicate keys, the partial unique indexes (0023) ──

describe('unique keys', () => {
  it('the service refuses a second customer with the same CR / VAT / mobile, naming the first', async () => {
    const first = await customers.create(USER_M, {
      nameAr: 'مؤسسة المفتاح الأول', nameEn: 'First Key', crNumber: cr(1), vatNumber: `3${suffix.slice(-13)}`.slice(0, 15), mobile: mobile(1),
    } as never);
    const attempts: Array<[string, Record<string, string>]> = [
      ['crNumber', { crNumber: cr(1) }],
      ['vatNumber', { vatNumber: first.vatNumber! }],
      ['mobile', { mobile: mobile(1).replace(/^0/, '+966') }], // same number, another spelling
    ];
    for (const [field, keys] of attempts) {
      const err = await customers.create(USER_M, { nameAr: 'نسخة', nameEn: 'Copy', crNumber: cr(99), ...keys } as never).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: 'CUSTOMER_DUPLICATE', field, existing: { id: first.id, code: first.code } });
    }
  });

  it('the same CR in ANOTHER organization is not a duplicate', async () => {
    await expect(
      customers.create(USER_X, { nameAr: 'مؤسسة المفتاح الأول', nameEn: 'First Key', crNumber: cr(1) } as never),
    ).resolves.toBeDefined();
  });

  it('the database itself refuses a duplicate CR / VAT / mobile (partial unique index → P2002, which the filter turns into 409)', async () => {
    const base = { organizationId: ORG_M, nameAr: 'خام', nameEn: 'raw' };
    await prisma.customer.create({ data: { ...base, code: `RAW-${suffix}-1`, crNumber: cr(50), vatNumber: '300000000000050', mobile: '+966500000050' } });
    for (const keys of [{ crNumber: cr(50) }, { vatNumber: '300000000000050' }, { mobile: '+966500000050' }]) {
      const err = await prisma.customer
        .create({ data: { ...base, code: `RAW-${suffix}-${Object.keys(keys)[0]}`, ...keys } })
        .catch((e) => e);
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    }
    // NULL and the empty string never collide.
    await prisma.customer.create({ data: { ...base, code: `RAW-${suffix}-n1` } });
    await prisma.customer.create({ data: { ...base, code: `RAW-${suffix}-n2` } });
    await prisma.customer.create({ data: { ...base, code: `RAW-${suffix}-e1`, crNumber: '' } });
    await prisma.customer.create({ data: { ...base, code: `RAW-${suffix}-e2`, crNumber: '' } });
  });
});

// ── contacts ──

describe('customer contacts', () => {
  it('keeps one primary, audits create/update/delete, and hard-deletes', async () => {
    const c = await customers.create(USER_M, { nameAr: 'عميل جهات الاتصال', nameEn: 'Contacts Co', crNumber: cr(2) } as never);
    const a = await contacts.create(USER_M, c.id, { name: 'أ', isPrimary: true, mobile: '0501112233' });
    expect(a.mobile).toBe('+966501112233');
    const b = await contacts.create(USER_M, c.id, { name: 'ب', isPrimary: true });
    const rows = await contacts.list(USER_M, c.id);
    expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([b.id]);

    await contacts.update(USER_M, c.id, a.id, { isPrimary: true, title: 'مدير' });
    expect((await contacts.list(USER_M, c.id)).filter((r) => r.isPrimary).map((r) => r.id)).toEqual([a.id]);

    await contacts.remove(USER_M, c.id, b.id);
    expect(await prisma.customerContact.findUnique({ where: { id: b.id } })).toBeNull();
    const trail = await prisma.auditLog.findMany({ where: { organizationId: ORG_M, entityType: 'CustomerContact', entityId: b.id } });
    expect(trail.map((t) => t.action).sort()).toEqual(['CREATE', 'DELETE']);
    expect(trail.find((t) => t.action === 'DELETE')!.beforeJson).toMatchObject({ name: 'ب' });
  });

  it('cannot reach a contact of another organization (404, never 403)', async () => {
    const c = await customers.create(USER_M, { nameAr: 'عميل خاص', nameEn: 'Private', crNumber: cr(3) } as never);
    const k = await contacts.create(USER_M, c.id, { name: 'سري' });
    await expect(contacts.list(USER_X, c.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(contacts.remove(USER_X, c.id, k.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(contacts.create(USER_X, c.id, { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── the merge ──

describe('customer merge', () => {
  let survivor: { id: string; code: string };
  let dupe: { id: string; code: string };
  let foreign: { id: string };
  const BACKUP = `npi-backup-${suffix}.dump`;

  beforeAll(async () => {
    // Survivor: has a CR, lacks VAT / email / mobile. Duplicate: has VAT, email, mobile, a different CR.
    survivor = await prisma.customer.create({
      data: {
        organizationId: ORG_M, code: `MS-${suffix}`, nameAr: 'شركة الأفق للطاقة', nameEn: 'Horizon Energy',
        nameNormalized: normalizeArabicName('شركة الأفق للطاقة'), crNumber: cr(10), creditTermsDays: 45,
      },
    });
    dupe = await prisma.customer.create({
      data: {
        organizationId: ORG_M, code: `MD-${suffix}`, nameAr: 'الافق للطاقه', nameEn: 'Afaq Energy Dup',
        nameNormalized: normalizeArabicName('الافق للطاقه'), crNumber: cr(11), vatNumber: '300000000000011',
        mobile: mobile(2), email: 'dupe@example.com', phone: '0112222222', creditTermsDays: 7,
      },
    });
    foreign = await prisma.customer.create({
      data: { organizationId: ORG_X, code: `MF-${suffix}`, nameAr: 'عميل منشأة أخرى', nameEn: 'Foreign', crNumber: cr(12) },
    });
    await hang(ORG_M, survivor.id, `S${suffix}`);
    await hang(ORG_M, dupe.id, `D${suffix}`);
    await prisma.customerContact.create({ data: { organizationId: ORG_M, customerId: survivor.id, name: 'جهة الباقي', isPrimary: true } });
    await prisma.customerContact.create({ data: { organizationId: ORG_M, customerId: dupe.id, name: 'جهة المكرر', isPrimary: true } });
  });

  it('suggests the pair as a group and changes nothing', async () => {
    const before = [await owned(ORG_M, survivor.id), await owned(ORG_M, dupe.id)];
    const out = await merges.duplicates(USER_M);
    expect(out.mergeEnabled).toBe(false);
    const group = out.groups.find((g) => g.members.some((m) => m.id === dupe.id));
    expect(group).toBeDefined();
    expect(group!.members.map((m) => m.id).sort()).toEqual([survivor.id, dupe.id].sort());
    expect(group!.reasons.some((r) => r.kind === 'NAME')).toBe(true);
    expect(group!.members.find((m) => m.id === dupe.id)!.counts).toMatchObject({ leads: 1, opportunities: 1, contracts: 1, invoices: 1, contacts: 1 });
    expect([await owned(ORG_M, survivor.id), await owned(ORG_M, dupe.id)]).toEqual(before);
  });

  it('is refused (403) while the merge switch is off, and nothing moves', async () => {
    const err = await merges.merge(USER_M, { survivorId: survivor.id, mergedIds: [dupe.id], backupRef: BACKUP }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe('Customer merge is disabled');
    expect((await owned(ORG_M, dupe.id)).leads).toBe(1);
  });

  it('once enabled: empty backupRef → 400, foreign customer → 404, and still nothing moves', async () => {
    await settings.set(ORG_M, ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED, true, USER_M.userId);
    await settings.set(ORG_X, ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED, true, USER_X.userId);
    await expect(merges.merge(USER_M, { survivorId: survivor.id, mergedIds: [dupe.id], backupRef: '' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(merges.merge(USER_M, { survivorId: survivor.id, mergedIds: [foreign.id], backupRef: BACKUP })).rejects.toBeInstanceOf(NotFoundException);
    // ...and the same from the neighbour's side.
    await expect(merges.merge(USER_X, { survivorId: foreign.id, mergedIds: [dupe.id], backupRef: BACKUP })).rejects.toBeInstanceOf(NotFoundException);
    expect((await owned(ORG_M, dupe.id)).leads).toBe(1);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: dupe.id } })).mergedIntoId).toBeNull();
  });

  it('moves every linked document, marks the duplicate (never deletes it), fills only empty fields, logs, audits and emits', async () => {
    const res = await merges.merge(USER_M, { survivorId: survivor.id, mergedIds: [dupe.id], backupRef: BACKUP });
    expect(res.merged[0].moved).toEqual({ Lead: 1, Opportunity: 1, Contract: 1, Invoice: 1, CustomerContact: 1, Attachment: 1 });

    // everything now belongs to the survivor; the duplicate owns nothing
    expect(await owned(ORG_M, dupe.id)).toEqual({ leads: 0, opportunities: 0, contracts: 0, invoices: 0, contacts: 0, attachments: 0 });
    expect(await owned(ORG_M, survivor.id)).toEqual({ leads: 2, opportunities: 2, contracts: 2, invoices: 2, contacts: 2, attachments: 2 });

    // only one primary contact: the survivor's own
    const primaries = await prisma.customerContact.findMany({ where: { customerId: survivor.id, isPrimary: true } });
    expect(primaries.map((p) => p.name)).toEqual(['جهة الباقي']);

    // the duplicate row is still there, marked, with its code and its own keys intact
    const d = await prisma.customer.findUniqueOrThrow({ where: { id: dupe.id } });
    expect(d).toMatchObject({ code: dupe.code, mergedIntoId: survivor.id, crNumber: cr(11) });
    expect(d.mergedAt).not.toBeNull();

    // the survivor filled ONLY what was empty
    const s = await prisma.customer.findUniqueOrThrow({ where: { id: survivor.id } });
    expect(s).toMatchObject({
      crNumber: cr(10),            // kept: it had one
      creditTermsDays: 45,         // kept
      nameEn: 'Horizon Energy',    // kept
      vatNumber: '300000000000011', // filled
      mobile: mobile(2),          // filled
      email: 'dupe@example.com',   // filled
      phone: '0112222222',         // filled
    });

    // log
    const log = await prisma.customerMergeLog.findFirstOrThrow({ where: { organizationId: ORG_M, mergedId: dupe.id } });
    expect(log).toMatchObject({ survivorId: survivor.id, backupRef: BACKUP, performedById: USER_M.userId });
    expect(log.movedJson).toMatchObject({ Lead: 1, Contract: 1 });
    expect(log.mergedSnapshotJson).toMatchObject({ code: dupe.code, crNumber: cr(11), vatNumber: '300000000000011' });

    // audit: MERGE on both records, before = the merged snapshot
    const trail = await prisma.auditLog.findMany({ where: { organizationId: ORG_M, action: 'MERGE' } });
    expect(trail.map((t) => t.entityId).sort()).toEqual([survivor.id, dupe.id].sort());
    expect(trail[0].beforeJson).toMatchObject({ id: dupe.id });

    // outbox event, same transaction
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { organizationId: ORG_M, eventCode: 'customer.merged' } });
    expect(ev.payloadJson).toMatchObject({ documentId: dupe.id, survivorId: survivor.id, actorId: USER_M.userId });
  });

  it('refuses to merge the same duplicate again (409) and to edit or attach to it', async () => {
    await expect(merges.merge(USER_M, { survivorId: survivor.id, mergedIds: [dupe.id], backupRef: BACKUP })).rejects.toThrow('Customer already merged');
    await expect(customers.update(USER_M, dupe.id, { nameEn: 'edit' })).rejects.toThrow('Customer already merged');
    await expect(contacts.create(USER_M, dupe.id, { name: 'x' })).rejects.toThrow('Customer already merged');
  });

  it('the merged record no longer counts as a duplicate holder: its old CR can be used by a new customer', async () => {
    await expect(
      customers.create(USER_M, { nameAr: 'عميل جديد تماماً', nameEn: 'Brand New', crNumber: cr(11) } as never),
    ).resolves.toBeDefined();
  });

  it('hides the merged record from lists and search, and shows it to a merger who asks', async () => {
    const plain = await customers.list({ ...USER_M, permissions: ['crm.customer.read'] } as AuthUser);
    expect(plain.map((c) => c.id)).not.toContain(dupe.id);
    const asked = await customers.list(USER_M, undefined, true);
    expect(asked.map((c) => c.id)).toContain(dupe.id);
    const got = await customers.get(USER_M, dupe.id);
    expect(got.mergedInto).toMatchObject({ id: survivor.id, code: survivor.code });
  });

  it('finds customers by mobile, partial or complete, in any spelling', async () => {
    const digits = mobile(2).slice(1); // 5xxxxxxxx
    expect((await customers.list(USER_M, mobile(2))).map((c) => c.id)).toContain(survivor.id);
    expect((await customers.list(USER_M, digits.slice(0, 6))).map((c) => c.id)).toContain(survivor.id);
  });

  it('the overview carries counts and lists, gated by the caller\'s permissions', async () => {
    const full = { ...USER_M, permissions: ['crm.customer.read', 'crm.opportunity.read', 'commercial.contract.read'] } as AuthUser;
    const o = (await customers.overview(full, survivor.id)) as Record<string, any>;
    expect(o.counts).toMatchObject({ contacts: 2, opportunities: 2, contracts: 2 });
    expect(o.opportunities).toHaveLength(2);
    expect(o.contracts).toHaveLength(2);
    // No proposal / project / claim permission → those lists are absent, not empty.
    expect(o.proposals).toBeUndefined();
    expect(o.projects).toBeUndefined();
    expect(o.claims).toBeUndefined();
    const bare = (await customers.overview({ ...USER_M, permissions: ['crm.customer.read'] } as AuthUser, survivor.id)) as Record<string, any>;
    expect(bare.opportunities).toBeUndefined();
    expect(bare.contacts).toHaveLength(2);
  });
});

// ── similar names against real data ──

describe('similar names', () => {
  it('warns about «شركة الرياض للصناعات» when «مصنع الرياض للصناعات» exists, but not about unrelated names', async () => {
    await customers.create(USER_M, { nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh Factory', crNumber: cr(20) } as never);
    const hits = await customers.similar(USER_M, 'شركة الرياض للصناعات');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].nameAr).toBe('مصنع الرياض للصناعات');
    expect(hits[0].score).toBeGreaterThanOrEqual(0.8);
    expect(await customers.similar(USER_M, 'مؤسسة الصحراء للتبريد')).toEqual([]);
    // the neighbour never sees it
    expect((await customers.similar(USER_X, 'شركة الرياض للصناعات')).map((h) => h.nameAr)).not.toContain('مصنع الرياض للصناعات');
  });
});
