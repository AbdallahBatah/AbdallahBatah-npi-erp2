// Database fixture for e2e/trust.spec.ts (T-33, F-17): seeds the `llm_audit`
// rows the trust screen must show, with a known order, a known consent and a
// known redacted outbound text, and removes exactly those rows afterwards.
//
// Uses the copilot's own Prisma client (never NPI's database, 08 §E.10) and
// the same `.env` loading `tests/helpers/load-env.ts` already does for Jest.
// Never logs the connection URL.
//
// Why this fixture writes `llm_audit` itself: the trust log is read-only, so no
// product path can put a known row there. The rows go in through the real
// Prisma client, so Postgres still enforces the I4 CHECK
// (`llm_audit_image_requires_consent_check`) on them; the image row below
// carries the consent event of an image document created the same way
// `tests/consent-db.spec.ts` creates one. `writeLlmAudit` is not used here
// (tests/no-bypass-llm.spec.ts R6 keeps it out of `e2e/`).
//
// Cleanup deletes only the ids this fixture created. Nothing else in the log is
// ever touched: the demo organization's own rows are the owner's history.
import { createHash } from 'node:crypto';
import '../../tests/helpers/load-env';
import { PrismaClient } from '../../src/generated/prisma';
import { t } from '../../src/i18n/ar';

let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

/** A real demo customer name that appears nowhere in the seeded data: the spec
 *  asserts the page never shows it (UAT 4.1, «ولا اسم حقيقي»). */
const REAL_NAME = 'شركة النخيل للمقاولات';

const MINUTE_MS = 60_000;

export interface TrustFixtureInput {
  npiOrgId: string;
  adminUserId: string;
  engineerUserId: string;
}

export interface TrustFixture {
  run: string;
  npiOrgId: string;
  adminUserId: string;
  engineerUserId: string;
  documentId: string;
  consentEventId: string;
  rowIds: { r1: string; r2: string; r3: string; r4: string; r5: string; r6: string };
  /** `ts` of R1; R2..R6 are one to five minutes older. */
  base: Date;
  REAL_NAME: string;
}

/**
 * Seeds one image document with an approved consent, and six `llm_audit` rows
 * (R1..R5 in the administrator's organization, newest first; R6 in a foreign
 * organization that must never be visible). `base` is taken as "now" so the
 * seeded rows are the newest of the organization and land on the first page.
 */
export async function seedTrustFixture(input: TrustFixtureInput): Promise<TrustFixture> {
  const db = getClient();
  const { npiOrgId, adminUserId, engineerUserId } = input;
  const run = Math.random().toString(36).slice(2, 10);
  const base = new Date();
  const at = (minutesAgo: number): Date => new Date(base.getTime() - minutesAgo * MINUTE_MS);
  const conversationId = `trust-e2e-${run}`;
  const sha256 = createHash('sha256').update(`trust-e2e-${run}`).digest('hex');

  const document = await db.document.create({
    data: {
      npiOrgId,
      npiUserId: adminUserId,
      fileName: `trust-e2e-${run}.jpg`,
      mime: 'image/jpeg',
      sizeBytes: 10,
      sha256,
      storagePath: `e2e/trust/${run}.jpg`,
      kind: 'image',
    },
  });
  const consent = await db.consentEvent.create({
    data: {
      documentId: document.id,
      npiOrgId,
      npiUserId: adminUserId,
      decision: 'approved',
      policyLine: t('consent.policy_line'),
    },
  });
  await db.document.update({ where: { id: document.id }, data: { consentEventId: consent.id } });

  const system = 'تعليمات اختبار';

  const r1 = await db.llmAudit.create({
    data: {
      ts: at(0),
      npiOrgId,
      npiUserId: adminUserId,
      conversationId,
      documentId: document.id,
      event: 'extract_vendor_bill',
      modelTier: 'advanced',
      modelId: 'claude-sonnet-5',
      tokensIn: 13968,
      tokensOut: 2030,
      costUsdMicro: 48236n,
      outboundRedactedText: JSON.stringify({
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'فاتورة من ⟦مورد_1⟧ لأمر الشراء PO-00017' },
              { type: 'image', mediaType: 'image/jpeg', sizeBytes: 10, consentEventId: consent.id },
            ],
          },
        ],
      }),
      imageSent: true,
      consentEventId: consent.id,
      latencyMs: 16510,
      error: null,
    },
  });

  const r2 = await db.llmAudit.create({
    data: {
      ts: at(1),
      npiOrgId,
      npiUserId: adminUserId,
      conversationId,
      documentId: null,
      event: 'extract_customer_contract',
      modelTier: 'advanced',
      modelId: 'claude-sonnet-5',
      tokensIn: 1234,
      tokensOut: 567,
      costUsdMicro: 12345n,
      outboundRedactedText: JSON.stringify({
        system,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'عقد مع ⟦عميل_1⟧ بقيمة 850,000 ريال، الرقم الضريبي ⟦رقم_ضريبي_1⟧، المشروع PRJ-00012',
              },
            ],
          },
        ],
      }),
      imageSent: false,
      consentEventId: null,
      latencyMs: 3210,
      error: null,
    },
  });

  const r3 = await db.llmAudit.create({
    data: {
      ts: at(2),
      npiOrgId,
      npiUserId: adminUserId,
      conversationId,
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

  const r4 = await db.llmAudit.create({
    data: {
      ts: at(3),
      npiOrgId,
      npiUserId: adminUserId,
      conversationId,
      event: 'cap_reached',
      modelTier: null,
      modelId: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicro: 0n,
      outboundRedactedText: null,
      imageSent: false,
      consentEventId: null,
      latencyMs: null,
      error: `cap-${run}`,
    },
  });

  const r5 = await db.llmAudit.create({
    data: {
      ts: at(4),
      npiOrgId,
      npiUserId: engineerUserId,
      conversationId,
      event: 'chat',
      modelTier: 'economy',
      modelId: 'claude-haiku-4-5-20251001',
      tokensIn: 300,
      tokensOut: 40,
      costUsdMicro: 420n,
      outboundRedactedText: JSON.stringify({
        system,
        messages: [{ role: 'user', content: 'وش المهام اللي تنتظرني؟' }],
      }),
      imageSent: false,
      consentEventId: null,
      latencyMs: null,
      error: null,
    },
  });

  const r6 = await db.llmAudit.create({
    data: {
      ts: at(5),
      npiOrgId: `trust-e2e-other-${run}`,
      npiUserId: `other-${run}`,
      conversationId,
      event: 'chat',
      modelTier: 'economy',
      modelId: 'claude-haiku-4-5-20251001',
      tokensIn: 10,
      tokensOut: 5,
      costUsdMicro: 20n,
      outboundRedactedText: null,
      imageSent: false,
      consentEventId: null,
      latencyMs: null,
      error: `OTHER-${run}`,
    },
  });

  return {
    run,
    npiOrgId,
    adminUserId,
    engineerUserId,
    documentId: document.id,
    consentEventId: consent.id,
    rowIds: { r1: r1.id, r2: r2.id, r3: r3.id, r4: r4.id, r5: r5.id, r6: r6.id },
    base,
    REAL_NAME,
  };
}

/** Removes exactly the rows `seedTrustFixture` created: the audit rows, then
 *  the consent event (it references the document), then the document. */
export async function cleanupTrustFixture(fixture: TrustFixture): Promise<void> {
  const db = getClient();
  await db.llmAudit.deleteMany({ where: { id: { in: Object.values(fixture.rowIds) } } });
  await db.consentEvent.deleteMany({ where: { id: fixture.consentEventId } });
  await db.document.deleteMany({ where: { id: fixture.documentId } });
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectTrustDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
