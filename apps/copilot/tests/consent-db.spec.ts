// These tests run against the real local `npi_copilot` database (not a
// mock). They must FAIL — not silently skip — if the database is
// unreachable, so no try/catch swallows a connection error here. Same env
// loading and cleanup pattern as tests/llm-db.spec.ts.
import './helpers/load-env';
import { getDb } from '../src/db';
import { recordConsent, requireConsent, ConsentRequiredError, type ConsentDb } from '../src/intake/consent';
import type { AuditDb } from '../src/audit/log';

const db = getDb();

// No cast: the real Prisma client must satisfy ConsentDb/AuditDb as written
// (the same pattern tests/llm-db.spec.ts proves for LlmDb).
const consentDb: ConsentDb = db;
const auditDb: AuditDb = db;

const runId = Math.random().toString(36).slice(2, 10);
const orgId = `test-consent-${runId}`;
const userId = `test-consent-user-${runId}`;

const createdDocumentIds: string[] = [];
const createdAuditIds: string[] = [];

afterAll(async () => {
  if (createdDocumentIds.length > 0) {
    await db.consentEvent.deleteMany({ where: { documentId: { in: createdDocumentIds } } });
    await db.document.deleteMany({ where: { id: { in: createdDocumentIds } } });
  }
  if (createdAuditIds.length > 0) {
    await db.llmAudit.deleteMany({ where: { id: { in: createdAuditIds } } });
  }
  await db.$disconnect();
});

async function createImageDocument(suffix: string) {
  const row = await db.document.create({
    data: {
      npiOrgId: orgId,
      npiUserId: userId,
      fileName: 'photo.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
      sha256: `${'a'.repeat(58)}${suffix}`,
      storagePath: `test/${orgId}/${suffix}.jpg`,
      kind: 'image',
      sensitivityFlag: false,
    },
  });
  createdDocumentIds.push(row.id);
  return row;
}

describe('ConsentDb / AuditDb against the real npi_copilot database', () => {
  it('rejects an llm_audit row with imageSent true and consentEventId null (DB CHECK llm_audit_image_requires_consent_check)', async () => {
    let caught: unknown;
    try {
      const row = await auditDb.llmAudit.create({
        data: {
          npiOrgId: orgId,
          npiUserId: userId,
          conversationId: null,
          intakeJobId: null,
          documentId: null,
          event: 'test.consent_db',
          modelTier: 'advanced',
          modelId: 'claude-sonnet-5',
          tokensIn: 1,
          tokensOut: 1,
          costUsdMicro: 0n,
          outboundRedactedText: null,
          imageSent: true,
          consentEventId: null,
          latencyMs: null,
          error: null,
        },
      });
      createdAuditIds.push((row as { id: string }).id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message.toLowerCase()).toMatch(/check|constraint/);
  });

  it('full path: approve -> requireConsent ok -> cancel -> requireConsent rejects "cancelled"', async () => {
    const row = await createImageDocument('full01');
    const caller = { npiOrgId: orgId, npiUserId: userId };

    const approved = await recordConsent(consentDb, caller, { documentId: row.id, decision: 'approved' });
    expect(approved.status).toBe('recorded');

    const consent = await requireConsent(consentDb, caller, row.id);
    expect(consent.documentId).toBe(row.id);

    const cancelled = await recordConsent(consentDb, caller, { documentId: row.id, decision: 'cancelled' });
    expect(cancelled.status).toBe('recorded');

    await expect(requireConsent(consentDb, caller, row.id)).rejects.toBeInstanceOf(ConsentRequiredError);
    await expect(requireConsent(consentDb, caller, row.id)).rejects.toMatchObject({ reason: 'cancelled' });
  });
});
