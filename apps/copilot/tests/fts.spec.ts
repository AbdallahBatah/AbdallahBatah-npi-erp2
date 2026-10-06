// These tests run against the real local `npi_copilot` database (not a
// mock). They must FAIL — not silently skip — if the database is
// unreachable, so no try/catch swallows a connection error here.
import './helpers/load-env';
import { getDb } from '../src/db';
import { searchFacts, buildSearchText } from '../src/memory/fts';

const db = getDb();

const runId = Math.random().toString(36).slice(2, 10);
const orgId = `test-fts-${runId}`;
const otherOrgId = `test-fts-other-${runId}`;

const createdFactIds: string[] = [];
const createdPositionIds: string[] = [];
const createdAuditIds: string[] = [];

async function makeFact(input: {
  npiOrgId: string;
  scope: 'company' | 'position';
  positionId?: string | null;
  entityType: 'customer' | 'vendor' | 'project' | 'item' | 'position';
  npiEntityId?: string | null;
  factAr: string;
  sourcePermission?: string | null;
}) {
  const fact = await db.memoryFact.create({
    data: {
      npiOrgId: input.npiOrgId,
      scope: input.scope,
      positionId: input.positionId ?? null,
      entityType: input.entityType,
      npiEntityId: input.npiEntityId ?? null,
      factAr: input.factAr,
      searchText: buildSearchText(input.factAr),
      sourceType: 'npi',
      sourcePermission: input.sourcePermission ?? null,
      confidence: 1,
    },
  });
  createdFactIds.push(fact.id);
  return fact;
}

let positionA: { id: string };
let positionB: { id: string };

let factCompanyAhmad: { id: string };
let factCompanyVendorAlFahd: { id: string };
let factOtherOrg: { id: string };
let factPositionA: { id: string };
const limitTestFactIds: string[] = [];

beforeAll(async () => {
  positionA = await db.position.create({
    data: {
      npiOrgId: orgId,
      roleKey: `sales_manager_${runId}`,
      titleAr: 'مدير المبيعات',
      personaAr: 'شخصية مدير المبيعات لأغراض الاختبار',
    },
  });
  createdPositionIds.push(positionA.id);

  positionB = await db.position.create({
    data: {
      npiOrgId: orgId,
      roleKey: `finance_manager_${runId}`,
      titleAr: 'مدير المالية',
      personaAr: 'شخصية مدير المالية لأغراض الاختبار',
    },
  });
  createdPositionIds.push(positionB.id);

  factCompanyAhmad = await makeFact({
    npiOrgId: orgId,
    scope: 'company',
    entityType: 'customer',
    npiEntityId: 'CUST-001',
    factAr: 'أحمد الجهني هو المسؤول عن المشتريات في الشركة',
  });

  factCompanyVendorAlFahd = await makeFact({
    npiOrgId: orgId,
    scope: 'company',
    entityType: 'vendor',
    npiEntityId: 'VEND-100',
    factAr: 'مورد الفهد للحديد والصلب يسلم خلال عشرة أيام',
  });

  factOtherOrg = await makeFact({
    npiOrgId: otherOrgId,
    scope: 'company',
    entityType: 'customer',
    npiEntityId: 'CUST-999',
    factAr: 'شركة زهرة المدينة للنقل والتوزيع',
  });

  factPositionA = await makeFact({
    npiOrgId: orgId,
    scope: 'position',
    positionId: positionA.id,
    entityType: 'customer',
    npiEntityId: 'CUST-777',
    factAr: 'العميل يفضل الدفع الآجل ثلاثين يوماً',
  });

  for (let i = 0; i < 3; i += 1) {
    const fact = await makeFact({
      npiOrgId: orgId,
      scope: 'company',
      entityType: 'project',
      npiEntityId: `PRJ-LIMIT-${i}`,
      factAr: `المصنع رقم ${i} يقع في المنطقة الصناعية الثانية`,
    });
    limitTestFactIds.push(fact.id);
  }
});

afterAll(async () => {
  if (createdAuditIds.length > 0) {
    await db.llmAudit.deleteMany({ where: { id: { in: createdAuditIds } } });
  }
  if (createdFactIds.length > 0) {
    await db.memoryFact.deleteMany({ where: { id: { in: createdFactIds } } });
  }
  if (createdPositionIds.length > 0) {
    await db.position.deleteMany({ where: { id: { in: createdPositionIds } } });
  }
  await db.$disconnect();
});

describe('searchFacts', () => {
  it('finds a fact by an exact Arabic word', async () => {
    const hits = await searchFacts(db, { npiOrgId: orgId, permissions: [], query: 'الجهني' });
    expect(hits.some((h) => h.id === factCompanyAhmad.id)).toBe(true);
  });

  it('finds it when the query has tashkeel and a different alef form than the stored text', async () => {
    // Stored text has "أحمد" (hamza-above-alef, no diacritics). Query uses
    // "إحمد" (hamza-below-alef) plus tashkeel — both must normalize to the
    // same token stream to match.
    const hits = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'إِحْمَد الجُهْني',
    });
    expect(hits.some((h) => h.id === factCompanyAhmad.id)).toBe(true);
  });

  it('finds it by a slightly misspelled name (trigram path, not an exact token match)', async () => {
    // "الفهض" (typo) vs stored "الفهد": plainto_tsquery ANDs all terms, so
    // this must NOT match via the tsvector path (the mistyped token isn't
    // in the document) and can only be found via word_similarity.
    const hits = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'مورد الفهض للحديد والصلب',
    });
    expect(hits.some((h) => h.id === factCompanyVendorAlFahd.id)).toBe(true);
  });

  it('never returns a fact belonging to another organization', async () => {
    const hits = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'زهرة المدينة للنقل',
    });
    expect(hits.some((h) => h.id === factOtherOrg.id)).toBe(false);

    // Sanity check: the fact is actually findable under its own org.
    const hitsForOtherOrg = await searchFacts(db, {
      npiOrgId: otherOrgId,
      permissions: [],
      query: 'زهرة المدينة للنقل',
    });
    expect(hitsForOtherOrg.some((h) => h.id === factOtherOrg.id)).toBe(true);
  });

  it('returns a position-scoped fact only for its own positionId', async () => {
    const hits = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'الدفع الآجل ثلاثين يوماً',
      positionId: positionA.id,
    });
    expect(hits.some((h) => h.id === factPositionA.id)).toBe(true);
  });

  it('does not return a position-scoped fact for a different position', async () => {
    const hits = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'الدفع الآجل ثلاثين يوماً',
      positionId: positionB.id,
    });
    expect(hits.some((h) => h.id === factPositionA.id)).toBe(false);
  });

  it('does not return a position-scoped fact when no positionId is given', async () => {
    const hits = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'الدفع الآجل ثلاثين يوماً',
    });
    expect(hits.some((h) => h.id === factPositionA.id)).toBe(false);
  });

  it('returns a company-scoped fact regardless of which position asks', async () => {
    const hitsA = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'الجهني',
      positionId: positionA.id,
    });
    const hitsB = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'الجهني',
      positionId: positionB.id,
    });
    const hitsNone = await searchFacts(db, { npiOrgId: orgId, permissions: [], query: 'الجهني' });
    expect(hitsA.some((h) => h.id === factCompanyAhmad.id)).toBe(true);
    expect(hitsB.some((h) => h.id === factCompanyAhmad.id)).toBe(true);
    expect(hitsNone.some((h) => h.id === factCompanyAhmad.id)).toBe(true);
  });

  it('returns an empty array for an empty query without touching the database', async () => {
    const hits = await searchFacts(db, { npiOrgId: orgId, permissions: [], query: '' });
    expect(hits).toEqual([]);
  });

  it('returns an empty array for a whitespace-only query', async () => {
    const hits = await searchFacts(db, { npiOrgId: orgId, permissions: [], query: '   ' });
    expect(hits).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    const hits = await searchFacts(db, {
      npiOrgId: orgId,
      permissions: [],
      query: 'المصنع المنطقة الصناعية',
      limit: 2,
    });
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('searchFacts: source permission (D-17)', () => {
  const CONTRACT = 'commercial.contract.read';
  const org = `test-fts-perm-${runId}`;
  let contractFactId: string;
  let plainFactId: string;
  let positionContractFactId: string;

  beforeAll(async () => {
    contractFactId = (
      await makeFact({
        npiOrgId: org,
        scope: 'company',
        entityType: 'customer',
        factAr: 'عقد الراجحي للطاقة دفعة مقدمة عشرون بالمئة',
        sourcePermission: CONTRACT,
      })
    ).id;
    plainFactId = (
      await makeFact({
        npiOrgId: org,
        scope: 'company',
        entityType: 'customer',
        factAr: 'عقد الراجحي للطاقة يتابعه فريق المبيعات',
        sourcePermission: null,
      })
    ).id;
    positionContractFactId = (
      await makeFact({
        npiOrgId: org,
        scope: 'position',
        positionId: positionA.id,
        entityType: 'customer',
        factAr: 'ملاحظة المنصب عن عقد الراجحي للطاقة',
        sourcePermission: CONTRACT,
      })
    ).id;
  });

  const ids = async (permissions: string[], positionId: string | null = null) =>
    (await searchFacts(db, { npiOrgId: org, query: 'عقد الراجحي للطاقة', permissions, positionId })).map((h) => h.id).sort();

  it('an empty permission list sees only the facts without a source permission', async () => {
    expect(await ids([])).toEqual([plainFactId]);
  });

  it("a permission that is not the fact's own does not unlock it", async () => {
    expect(await ids(['crm.customer.read'])).toEqual([plainFactId]);
  });

  it("the fact's own permission unlocks it, and the hit says which permission it carries", async () => {
    expect(await ids([CONTRACT])).toEqual([contractFactId, plainFactId].sort());
    const hits = await searchFacts(db, { npiOrgId: org, query: 'عقد الراجحي للطاقة', permissions: [CONTRACT] });
    expect(hits.find((h) => h.id === contractFactId)?.sourcePermission).toBe(CONTRACT);
    expect(hits.find((h) => h.id === plainFactId)?.sourcePermission).toBeNull();
  });

  it('a position fact with a permission needs both the position and the permission', async () => {
    expect(await ids([CONTRACT], positionA.id)).toEqual([contractFactId, plainFactId, positionContractFactId].sort());
    expect(await ids([], positionA.id)).toEqual([plainFactId]);
    expect(await ids([CONTRACT], positionB.id)).toEqual([contractFactId, plainFactId].sort());
    expect(await ids([CONTRACT], null)).toEqual([contractFactId, plainFactId].sort());
  });
});

describe('llm_audit CHECK constraint (invariant I4)', () => {
  it('rejects imageSent = true with a null consentEventId', async () => {
    await expect(
      db.llmAudit.create({
        data: {
          npiOrgId: orgId,
          npiUserId: `test-user-${runId}`,
          event: 'test.image_without_consent',
          imageSent: true,
          consentEventId: null,
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts imageSent = true when a consentEventId is present', async () => {
    const row = await db.llmAudit.create({
      data: {
        npiOrgId: orgId,
        npiUserId: `test-user-${runId}`,
        event: 'test.image_with_consent',
        imageSent: true,
        consentEventId: `test-consent-${runId}`,
      },
    });
    createdAuditIds.push(row.id);
    expect(row.imageSent).toBe(true);
  });
});
