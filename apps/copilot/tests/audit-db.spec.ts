// T-33 part A against the real local `npi_copilot` database (not a mock):
// the trust log's readers over rows seeded the way the copilot writes them.
// Like tests/consent-db.spec.ts these must FAIL — not silently skip — when the
// database is unreachable, so no try/catch swallows a connection error. The
// NPI directory is a fake returning an empty list: a unit test has no NPI.
import './helpers/load-env';
import { getDb } from '../src/db';
import {
  TRUST_PERMISSION,
  auditSummary,
  getAuditRow,
  listAudit,
  type AuditCaller,
  type AuditQueryDb,
  type AuditQueryDeps,
  type AuditQueryNpi,
} from '../src/audit/query';
import { t } from '../src/i18n/ar';

const db = getDb();

// No cast: the real Prisma client must satisfy AuditQueryDb as written
// (the same pattern tests/consent-db.spec.ts proves for ConsentDb/AuditDb).
const queryDb: AuditQueryDb = db;

const runId = Math.random().toString(36).slice(2, 10);
const orgId = `test-trust-${runId}`;
const otherOrgId = `test-trust-other-${runId}`;
const userId = `test-trust-user-${runId}`;

const npi: AuditQueryNpi = { listDepartmentDirectory: async () => [] };
const deps: AuditQueryDeps = { db: queryDb, npi };
const caller: AuditCaller = { npiOrgId: orgId, npiUserId: userId, permissions: [TRUST_PERMISSION] };

const createdDocumentIds: string[] = [];
const createdAuditIds: string[] = [];

const chatText = JSON.stringify({
  system: 'أنت مدار.',
  messages: [{ role: 'user', content: 'ما رصيد ⟦عميل_1⟧؟' }],
});

let consentId = '';
let documentId = '';
let chatId = '';
let imageId = '';
let refusedId = '';
let otherOrgRowId = '';
let imageText = '';

beforeAll(async () => {
  const doc = await db.document.create({
    data: {
      npiOrgId: orgId,
      npiUserId: userId,
      fileName: 'bill.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
      sha256: `${'b'.repeat(56)}${runId}`,
      storagePath: `test/${orgId}/bill.jpg`,
      kind: 'image',
      sensitivityFlag: false,
    },
  });
  documentId = doc.id;
  createdDocumentIds.push(doc.id);

  const consent = await db.consentEvent.create({
    data: {
      documentId: doc.id,
      npiOrgId: orgId,
      npiUserId: userId,
      decision: 'approved',
      policyLine: 'test policy line',
    },
  });
  consentId = consent.id;

  imageText = JSON.stringify({
    system: 'استخرج حقول الفاتورة.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'الفاتورة من ⟦مورد_1⟧' },
          { type: 'image', mediaType: 'image/jpeg', sizeBytes: 10, consentEventId: consent.id },
        ],
      },
    ],
  });

  const base = {
    npiOrgId: orgId,
    npiUserId: userId,
    conversationId: null,
    intakeJobId: null,
  } as const;

  const chat = await db.llmAudit.create({
    data: {
      ...base,
      ts: new Date('2026-10-06T10:00:00.000Z'),
      documentId: null,
      event: 'chat',
      modelTier: 'economy',
      modelId: 'claude-haiku',
      tokensIn: 100,
      tokensOut: 40,
      costUsdMicro: 48236n,
      outboundRedactedText: chatText,
      imageSent: false,
      consentEventId: null,
      latencyMs: 700,
      error: null,
    },
  });
  chatId = chat.id;

  const image = await db.llmAudit.create({
    data: {
      ...base,
      ts: new Date('2026-10-06T10:01:00.000Z'),
      documentId: doc.id,
      event: 'extract_vendor_bill',
      modelTier: 'advanced',
      modelId: 'claude-sonnet',
      tokensIn: 900,
      tokensOut: 300,
      costUsdMicro: 123456789n,
      outboundRedactedText: imageText,
      imageSent: true,
      consentEventId: consent.id,
      latencyMs: 4100,
      error: null,
    },
  });
  imageId = image.id;

  const refused = await db.llmAudit.create({
    data: {
      ...base,
      ts: new Date('2026-10-06T10:02:00.000Z'),
      documentId: null,
      event: 'refused_confidential',
      modelTier: null,
      modelId: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0n,
      outboundRedactedText: null,
      imageSent: false,
      consentEventId: null,
      latencyMs: null,
      error: null,
    },
  });
  refusedId = refused.id;

  const other = await db.llmAudit.create({
    data: {
      npiOrgId: otherOrgId,
      npiUserId: 'someone-else',
      conversationId: null,
      intakeJobId: null,
      documentId: null,
      ts: new Date('2026-10-06T10:03:00.000Z'),
      event: 'chat',
      modelTier: 'economy',
      modelId: 'claude-haiku',
      tokensIn: 1,
      tokensOut: 1,
      costUsdMicro: 1n,
      outboundRedactedText: null,
      imageSent: false,
      consentEventId: null,
      latencyMs: null,
      error: null,
    },
  });
  otherOrgRowId = other.id;

  createdAuditIds.push(chatId, imageId, refusedId, otherOrgRowId);
});

afterAll(async () => {
  if (createdAuditIds.length > 0) {
    await db.llmAudit.deleteMany({ where: { id: { in: createdAuditIds } } });
  }
  if (createdDocumentIds.length > 0) {
    await db.consentEvent.deleteMany({ where: { documentId: { in: createdDocumentIds } } });
    await db.document.deleteMany({ where: { id: { in: createdDocumentIds } } });
  }
  await db.$disconnect();
});

describe('the trust log readers against the real npi_copilot database', () => {
  it('lists the organization newest first with the row mapping, and never the other organization', async () => {
    const view = await listAudit(deps, caller, { filters: {}, cursor: null, limit: 50 });
    expect(view.rows.map((r) => r.id)).toEqual([refusedId, imageId, chatId]);
    expect(view.nextCursor).toBeNull();

    const [refused, image, chat] = view.rows;

    expect(chat).toMatchObject({
      event: 'chat',
      eventLabelAr: t('trust.event.chat'),
      kind: 'model',
      modelTier: 'economy',
      tokensIn: 100,
      tokensOut: 40,
      costUsdMicro: '48236',
      imageSent: false,
      consent: null,
      document: null,
      outboundChars: chatText.length,
      userNameAr: null,
    });

    expect(image).toMatchObject({
      event: 'extract_vendor_bill',
      kind: 'model',
      modelTier: 'advanced',
      costUsdMicro: '123456789',
      imageSent: true,
      outboundChars: imageText.length,
      document: { id: documentId, fileName: 'bill.jpg', kind: 'image' },
    });
    expect(image.consent).toMatchObject({ id: consentId, decision: 'approved' });
    expect(typeof image.consent?.createdAt).toBe('string');

    expect(refused).toMatchObject({
      event: 'refused_confidential',
      eventLabelAr: t('trust.event.refused_confidential'),
      kind: 'system',
      modelTier: null,
      modelId: null,
      costUsdMicro: '0',
      outboundChars: 0,
    });

    // The list never carries the text; the JSON has no bigint.
    expect(() => JSON.stringify(view)).not.toThrow();
    expect(JSON.stringify(view)).not.toContain('outboundRedactedText');
    expect(JSON.stringify(view)).not.toContain('⟦عميل_1⟧');

    expect(view.users).toEqual([{ npiUserId: userId, nameAr: null }]);
  });

  it('keyset pagination over real timestamps walks the three rows without a gap or a repeat', async () => {
    const first = await listAudit(deps, caller, { filters: {}, cursor: null, limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([refusedId, imageId]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listAudit(deps, caller, { filters: {}, cursor: first.nextCursor, limit: 2 });
    expect(second.rows.map((r) => r.id)).toEqual([chatId]);
    expect(second.nextCursor).toBeNull();
  });

  it('filters: imageSent, event and user', async () => {
    const images = await listAudit(deps, caller, { filters: { imageSent: true }, cursor: null, limit: 50 });
    expect(images.rows.map((r) => r.id)).toEqual([imageId]);
    const byEvent = await listAudit(deps, caller, {
      filters: { event: 'refused_confidential' },
      cursor: null,
      limit: 50,
    });
    expect(byEvent.rows.map((r) => r.id)).toEqual([refusedId]);
    const byUser = await listAudit(deps, caller, { filters: { npiUserId: 'someone-else' }, cursor: null, limit: 50 });
    expect(byUser.rows).toEqual([]);
  });

  it('getAuditRow returns the parsed outbound text; the image row carries the block with its consent id', async () => {
    const chat = await getAuditRow(deps, caller, chatId);
    expect(chat?.outbound).toEqual({
      kind: 'parsed',
      system: 'أنت مدار.',
      messages: [{ role: 'user', content: 'ما رصيد ⟦عميل_1⟧؟' }],
      placeholderCount: 1,
    });

    const image = await getAuditRow(deps, caller, imageId);
    expect(image?.imageSent).toBe(true);
    expect(image?.outbound).toMatchObject({ kind: 'parsed', placeholderCount: 1 });
    if (image?.outbound?.kind !== 'parsed') throw new Error('expected a parsed outbound');
    expect(image.outbound.messages[0].content).toEqual([
      { type: 'text', text: 'الفاتورة من ⟦مورد_1⟧' },
      { type: 'image', mediaType: 'image/jpeg', sizeBytes: 10, consentEventId: consentId },
    ]);

    const refused = await getAuditRow(deps, caller, refusedId);
    expect(refused?.outbound).toBeNull();
  });

  it("getAuditRow of another organization's row is null", async () => {
    await expect(getAuditRow(deps, caller, otherOrgRowId)).resolves.toBeNull();
    await expect(getAuditRow(deps, { ...caller, npiOrgId: otherOrgId }, otherOrgRowId)).resolves.toMatchObject({
      id: otherOrgRowId,
    });
  });

  it('auditSummary: every image send has a consent id (G-M4-2)', async () => {
    expect(await auditSummary(queryDb, orgId)).toEqual({
      total: 3,
      imageSent: 1,
      imageSentWithoutConsent: 0,
      errors: 0,
    });
  });
});
