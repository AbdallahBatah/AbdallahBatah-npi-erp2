import './helpers/load-env';
import { getDb } from '../src/db';
import { looksMemorable } from '../src/memory/extract-chat';
import { retrieveFacts } from '../src/memory/retrieve';
import { saveFact, type NewFact } from '../src/memory/store';

// Runs against the real local npi_copilot database. Every row written here
// carries this run's organization id and is deleted in afterAll.
const db = getDb();
const runId = Math.random().toString(36).slice(2, 10);
const orgId = `test-memory-${runId}`;
const otherOrgId = `test-memory-other-${runId}`;
let positionId: string;
let otherPositionId: string;

function fact(overrides: Partial<NewFact> = {}): NewFact {
  return {
    npiOrgId: orgId,
    scope: 'company',
    entityType: 'customer',
    factAr: 'شروط سداد شركة النخيل للمقاولات 30 يوماً من تاريخ الفاتورة',
    sourceType: 'npi',
    confidence: 0.9,
    ...overrides,
  };
}

beforeAll(async () => {
  const mine = await db.position.create({
    data: { npiOrgId: orgId, roleKey: 'accountant', departmentId: null, titleAr: 'المحاسب', personaAr: 'p' },
  });
  const other = await db.position.create({
    data: { npiOrgId: orgId, roleKey: 'sales', departmentId: null, titleAr: 'المبيعات', personaAr: 'p' },
  });
  positionId = mine.id;
  otherPositionId = other.id;
});

afterAll(async () => {
  await db.memoryFact.deleteMany({ where: { npiOrgId: { in: [orgId, otherOrgId] } } });
  await db.position.deleteMany({ where: { npiOrgId: orgId } });
  await db.$disconnect();
});

describe('saveFact', () => {
  it('stores a fact with its normalized search text', async () => {
    const result = await saveFact(db, fact());
    expect(result).toMatchObject({ saved: true, created: true });
    const row = await db.memoryFact.findFirstOrThrow({ where: { npiOrgId: orgId, entityType: 'customer' } });
    expect(row.searchText).toBe('شروط سداد شركه النخيل للمقاولات 30 يوما من تاريخ الفاتوره');
    expect(row.sourceType).toBe('npi');
  });

  it('treats the same sentence in another spelling as the same fact and keeps the higher confidence', async () => {
    const again = await saveFact(
      db,
      fact({ factAr: 'شروط سداد شركه النخيل للمقاولات ٣٠ يوماً من تاريخ الفاتورة', confidence: 0.95 }),
    );
    expect(again).toMatchObject({ saved: true, created: false });
    const rows = await db.memoryFact.findMany({ where: { npiOrgId: orgId, entityType: 'customer' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBeCloseTo(0.95);

    const lower = await saveFact(db, fact({ confidence: 0.5 }));
    expect(lower).toMatchObject({ saved: true, created: false });
    const after = await db.memoryFact.findFirstOrThrow({ where: { npiOrgId: orgId, entityType: 'customer' } });
    expect(after.confidence).toBeCloseTo(0.95);
  });

  it('keeps the same sentence apart between organizations', async () => {
    const result = await saveFact(db, fact({ npiOrgId: otherOrgId }));
    expect(result).toMatchObject({ saved: true, created: true });
  });

  it.each([
    ['empty', fact({ factAr: '   ' }), 'empty'],
    ['only punctuation', fact({ factAr: '؟؟!!' }), 'empty'],
    ['too long', fact({ factAr: 'ا'.repeat(501) }), 'too_long'],
    ['confidence above 1', fact({ confidence: 1.2 }), 'bad_confidence'],
    ['confidence not a number', fact({ confidence: Number.NaN }), 'bad_confidence'],
    ['position scope without a position', fact({ scope: 'position', positionId: null }), 'position_missing'],
    ['about an employee (BR-06)', fact({ factAr: 'أكفأ مهندس في الفريق هو خالد', entityType: 'position' }), 'hr_guard'],
  ])('refuses a fact that is %s', async (_label, input, reason) => {
    const before = await db.memoryFact.count({ where: { npiOrgId: orgId } });
    await expect(saveFact(db, input)).resolves.toEqual({ saved: false, reason });
    await expect(db.memoryFact.count({ where: { npiOrgId: orgId } })).resolves.toBe(before);
  });
});

describe('retrieveFacts', () => {
  beforeAll(async () => {
    await saveFact(
      db,
      fact({
        scope: 'position',
        positionId,
        entityType: 'position',
        factAr: 'أفضّل مراجعة فواتير الموردين يوم الأحد',
        sourceType: 'chat',
      }),
    );
  });

  it('finds a company fact and counts the use', async () => {
    const at = new Date('2026-09-27T10:00:00.000Z');
    const hits = await retrieveFacts(db, { npiOrgId: orgId, positionId: null, query: 'شروط سداد النخيل' }, () => at);
    expect(hits.map((h) => h.entityType)).toEqual(['customer']);
    const row = await db.memoryFact.findUniqueOrThrow({ where: { id: hits[0].id } });
    expect(row.useCount).toBe(1);
    expect(row.lastUsedAt?.toISOString()).toBe(at.toISOString());
  });

  it('shows a position fact to its own position only', async () => {
    const query = 'مراجعة فواتير الموردين';
    const own = await retrieveFacts(db, { npiOrgId: orgId, positionId, query });
    const other = await retrieveFacts(db, { npiOrgId: orgId, positionId: otherPositionId, query });
    const none = await retrieveFacts(db, { npiOrgId: orgId, positionId: null, query });
    expect(own).toHaveLength(1);
    expect(other).toHaveLength(0);
    expect(none).toHaveLength(0);
  });

  it('returns nothing for an unrelated question and counts nothing', async () => {
    const hits = await retrieveFacts(db, { npiOrgId: orgId, positionId, query: 'حالة الطقس غداً في أبها' });
    expect(hits).toEqual([]);
  });

  it('never crosses organizations', async () => {
    const hits = await retrieveFacts(db, { npiOrgId: `nobody-${runId}`, positionId: null, query: 'شروط سداد النخيل' });
    expect(hits).toEqual([]);
  });
});

describe('looksMemorable', () => {
  it.each([
    ['للعلم، شركة النخيل يدفعون دائماً خلال 45 يوماً'],
    ['اتفقنا مع المورد على مهلة توريد 14 يوم'],
    ['خل في بالك إن المشروع يحتاج موافقة البلدية قبل التركيب'],
    ['أفضّل التعامل مع مصنع الخليج في الألواح عادةً'],
  ])('accepts a standing arrangement: %s', (text) => {
    expect(looksMemorable(text)).toBe(true);
  });

  it.each([
    ['a question', 'وش شروط سداد النخيل؟'],
    ['a question without a mark', 'كم مهلة التوريد عند المورد'],
    ['a one-off request', 'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس'],
    ['a greeting', 'مرحبا'],
    ['small talk', 'شكراً لك على المساعدة اليوم'],
    ['very long text', `للعلم ${'كلام '.repeat(300)}`],
  ])('skips %s', (_label, text) => {
    expect(looksMemorable(text)).toBe(false);
  });
});
