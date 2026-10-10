// T-22 acceptance (fakes only, no DB — gate: `npx jest consent` from
// apps/copilot): consent recording/verification (src/intake/consent.ts),
// vision block construction (src/llm/vision.ts), the vision pre-flight and
// audit-safe outbound text in the LLM client (src/llm/client.ts), the audit
// invariant (src/audit/log.ts) and the Anthropic request-shape mapping for
// image/document blocks (src/llm/providers/anthropic.ts).
import {
  consentNeeded,
  ConsentRequiredError,
  POLICY_LINE_AR,
  POLICY_VERIFIED_ON,
  recordConsent,
  requireConsent,
  type ConsentDb,
  type ConsentDecision,
  type ConsentEventRow,
  type VerifiedConsent,
} from '../src/intake/consent';
import type { DocumentKind, DocumentRow, DocumentStorage } from '../src/intake/upload';
import { metaSidecarPath, pagePngPath } from '../src/intake/upload';
import {
  auditView,
  auditViewOfMessages,
  documentVisionBlocks,
  imageBlock,
  pdfBlock,
  VISION_MAX_IMAGE_BASE64_BYTES,
  VisionInputError,
} from '../src/llm/vision';
import type { ConsentedBase64, RedactedBlock, RedactedMessage } from '../src/llm/provider';
import { createLlmClient, LlmError, type LlmContext, type LlmDb } from '../src/llm/client';
import type { ModelProvider, ModelResponse, ProviderCall, RedactedRequest } from '../src/llm/provider';
import { createAnthropicProvider, type AnthropicLike } from '../src/llm/providers/anthropic';
import { writeAuditEvent, writeLlmAudit, AuditInvariantError, type AuditDb, type LlmAuditData } from '../src/audit/log';
import { staticPrompt } from '../src/privacy/pseudonymizer';

// ─── fakes ──────────────────────────────────────────────────────────────────

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

function makeDocumentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  const now = new Date();
  return {
    id: nextId('doc'),
    npiOrgId: 'org-1',
    npiUserId: 'user-1',
    fileName: 'photo.jpg',
    mime: 'image/jpeg',
    sizeBytes: 100,
    sha256: 'x'.repeat(64),
    storagePath: 'org-1/x.jpg',
    kind: 'image',
    sensitivityFlag: false,
    consentEventId: null,
    extractedTextRedactedRef: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FakeConsentDb implements ConsentDb {
  documents = new Map<string, DocumentRow>();
  events = new Map<string, ConsentEventRow>();

  document = {
    findFirst: async (args: { where: { id: string; npiOrgId: string; npiUserId: string } }) => {
      const row = this.documents.get(args.where.id);
      if (!row) return null;
      if (row.npiOrgId !== args.where.npiOrgId || row.npiUserId !== args.where.npiUserId) return null;
      return row;
    },
    update: async (args: { where: { id: string }; data: { consentEventId: string | null } }) => {
      const row = this.documents.get(args.where.id);
      if (!row) throw new Error('not found');
      row.consentEventId = args.data.consentEventId;
      return row;
    },
  };

  consentEvent = {
    create: async (args: {
      data: { documentId: string; npiOrgId: string; npiUserId: string; decision: ConsentDecision; policyLine: string };
    }): Promise<ConsentEventRow> => {
      const event: ConsentEventRow = { id: nextId('evt'), createdAt: new Date(), ...args.data };
      this.events.set(event.id, event);
      return event;
    },
    findUnique: async (args: { where: { id: string } }) => this.events.get(args.where.id) ?? null,
  };

  addDocument(row: DocumentRow): DocumentRow {
    this.documents.set(row.id, row);
    return row;
  }
}

function createFakeStorage() {
  const files = new Map<string, Uint8Array>();
  const storage: DocumentStorage = {
    async write(relPath, bytes) {
      files.set(relPath, bytes);
    },
    async read(relPath) {
      return files.get(relPath) ?? null;
    },
  };
  return { storage, files };
}

function jpegBytes(n = 16): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(n)]);
}

function pngBytes(n = 16): Uint8Array {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n)]);
}

async function mintVerifiedConsent(
  db: FakeConsentDb,
  row: DocumentRow,
  caller = { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId },
): Promise<VerifiedConsent> {
  db.addDocument(row);
  await recordConsent(db, caller, { documentId: row.id, decision: 'approved' });
  return requireConsent(db, caller, row.id);
}

// ─── src/intake/consent.ts ──────────────────────────────────────────────────

describe('consentNeeded', () => {
  it.each<[DocumentKind, boolean]>([
    ['image', true],
    ['pdf_scanned', true],
    ['pdf_text', false],
  ])('consentNeeded(%s) === %s', (kind, expected) => {
    expect(consentNeeded(kind)).toBe(expected);
  });
});

describe('POLICY_LINE_AR', () => {
  it('equals the ar.ts key and carries the verified date', () => {
    expect(POLICY_LINE_AR).toContain(POLICY_VERIFIED_ON);
    expect(POLICY_LINE_AR.length).toBeGreaterThan(0);
  });
});

describe('recordConsent', () => {
  it('approve: records an event and sets the document pointer to it', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const outcome = await recordConsent(db, { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId }, {
      documentId: row.id,
      decision: 'approved',
    });
    expect(outcome).toMatchObject({ status: 'recorded', decision: 'approved', documentId: row.id });
    if (outcome.status !== 'recorded') return;
    expect(db.documents.get(row.id)!.consentEventId).toBe(outcome.consentEventId);
    expect(db.events.get(outcome.consentEventId)!.policyLine).toBe(POLICY_LINE_AR);
  });

  it('cancel after approve replaces the pointer with the cancellation event (clears the approval)', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const caller = { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId };
    const approved = await recordConsent(db, caller, { documentId: row.id, decision: 'approved' });
    expect(approved.status).toBe('recorded');
    const cancelled = await recordConsent(db, caller, { documentId: row.id, decision: 'cancelled' });
    expect(cancelled).toMatchObject({ status: 'recorded', decision: 'cancelled' });
    if (cancelled.status !== 'recorded' || approved.status !== 'recorded') return;
    expect(cancelled.consentEventId).not.toBe(approved.consentEventId);
    expect(db.documents.get(row.id)!.consentEventId).toBe(cancelled.consentEventId);
  });

  it('a document belonging to another org/user -> not_found', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const outcome = await recordConsent(db, { npiOrgId: 'other-org', npiUserId: 'other-user' }, {
      documentId: row.id,
      decision: 'approved',
    });
    expect(outcome).toEqual({ status: 'not_found' });
  });

  it('pdf_text -> not_needed', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow({ kind: 'pdf_text' }));
    const outcome = await recordConsent(db, { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId }, {
      documentId: row.id,
      decision: 'approved',
    });
    expect(outcome).toEqual({ status: 'not_needed' });
  });

  it('a confidential document -> confidential', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow({ sensitivityFlag: true }));
    const outcome = await recordConsent(db, { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId }, {
      documentId: row.id,
      decision: 'approved',
    });
    expect(outcome).toEqual({ status: 'confidential' });
  });
});

describe('requireConsent', () => {
  it('happy path: returns the ids after an approval', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const caller = { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId };
    await recordConsent(db, caller, { documentId: row.id, decision: 'approved' });
    const consent = await requireConsent(db, caller, row.id);
    expect(consent.documentId).toBe(row.id);
    expect(consent.npiOrgId).toBe(row.npiOrgId);
    expect(consent.npiUserId).toBe(row.npiUserId);
    expect(typeof consent.consentEventId).toBe('string');
  });

  it("throws 'none' when the document has never had a consent decision", async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const caller = { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId };
    await expect(requireConsent(db, caller, row.id)).rejects.toMatchObject({ reason: 'none' });
    await expect(requireConsent(db, caller, row.id)).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it("approve then cancel -> throws 'cancelled'", async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const caller = { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId };
    await recordConsent(db, caller, { documentId: row.id, decision: 'approved' });
    await recordConsent(db, caller, { documentId: row.id, decision: 'cancelled' });
    await expect(requireConsent(db, caller, row.id)).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it('an unknown document -> not_found', async () => {
    const db = new FakeConsentDb();
    await expect(requireConsent(db, { npiOrgId: 'o', npiUserId: 'u' }, 'nope')).rejects.toMatchObject({
      reason: 'not_found',
    });
  });

  it('a confidential document -> confidential', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow({ sensitivityFlag: true }));
    await expect(
      requireConsent(db, { npiOrgId: row.npiOrgId, npiUserId: row.npiUserId }, row.id),
    ).rejects.toMatchObject({ reason: 'confidential' });
  });
});

// ─── src/llm/vision.ts ──────────────────────────────────────────────────────

describe('imageBlock / pdfBlock shape', () => {
  it('imageBlock returns the expected shape', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const consent = await mintVerifiedConsent(db, row);
    const block = imageBlock(consent, { mediaType: 'image/jpeg', bytes: jpegBytes() });
    expect(block.type).toBe('image');
    expect(block.mediaType).toBe('image/jpeg');
    expect(block.consentEventId).toBe(consent.consentEventId);
    expect(block.sizeBytes).toBe(jpegBytes().length);
    expect(typeof block.data).toBe('string');
  });

  it('pdfBlock returns the expected shape, with an optional title', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow({ kind: 'pdf_scanned', mime: 'application/pdf' }));
    const consent = await mintVerifiedConsent(db, row);
    const bytes = Buffer.from('%PDF-1.4 fake pdf bytes', 'latin1');
    const block = pdfBlock(consent, { bytes, title: 'عقد' });
    expect(block.type).toBe('document');
    expect(block.mediaType).toBe('application/pdf');
    expect(block.title).toBe('عقد');
    expect(block.sizeBytes).toBe(bytes.length);
  });

  it('empty bytes -> VisionInputError("empty")', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const consent = await mintVerifiedConsent(db, row);
    expect(() => imageBlock(consent, { mediaType: 'image/jpeg', bytes: new Uint8Array(0) })).toThrow(
      VisionInputError,
    );
    try {
      imageBlock(consent, { mediaType: 'image/jpeg', bytes: new Uint8Array(0) });
    } catch (err) {
      expect((err as VisionInputError).kind).toBe('empty');
    }
  });

  it('a base64-encoded length over the 10 MB image limit -> VisionInputError("too_large")', async () => {
    const db = new FakeConsentDb();
    const row = db.addDocument(makeDocumentRow());
    const consent = await mintVerifiedConsent(db, row);
    // base64 length = ceil(n/3)*4; need > 10 MiB, so n just over 7.5 MiB.
    // Allocated once, well under 10 MB itself.
    const overLimitBytes = Math.ceil(VISION_MAX_IMAGE_BASE64_BYTES * 0.76);
    const bytes = Buffer.alloc(overLimitBytes);
    let thrown: VisionInputError | null = null;
    try {
      imageBlock(consent, { mediaType: 'image/jpeg', bytes });
    } catch (err) {
      thrown = err as VisionInputError;
    }
    expect(thrown).toBeInstanceOf(VisionInputError);
    expect(thrown?.kind).toBe('too_large');
  });
});

describe('documentVisionBlocks', () => {
  it('kind image (jpeg): returns one image block read from storage', async () => {
    const db = new FakeConsentDb();
    const { storage } = createFakeStorage();
    const row = db.addDocument(makeDocumentRow({ mime: 'image/jpeg', storagePath: 'org-1/a.jpg' }));
    await storage.write(row.storagePath, jpegBytes());
    const consent = await mintVerifiedConsent(db, row);

    const blocks = await documentVisionBlocks(consent, storage, row);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('image');
    if (blocks[0].type === 'image') expect(blocks[0].mediaType).toBe('image/jpeg');
  });

  it('kind image (png): returns one image block with the png media type', async () => {
    const db = new FakeConsentDb();
    const { storage } = createFakeStorage();
    const row = db.addDocument(makeDocumentRow({ mime: 'image/png', storagePath: 'org-1/a.png' }));
    await storage.write(row.storagePath, pngBytes());
    const consent = await mintVerifiedConsent(db, row);

    const blocks = await documentVisionBlocks(consent, storage, row);
    expect(blocks).toHaveLength(1);
    if (blocks[0].type === 'image') expect(blocks[0].mediaType).toBe('image/png');
  });

  it('kind pdf_scanned, 1 page: one image block, no label', async () => {
    const db = new FakeConsentDb();
    const { storage } = createFakeStorage();
    const row = db.addDocument(makeDocumentRow({ kind: 'pdf_scanned', mime: 'application/pdf', storagePath: 'org-1/s.pdf' }));
    await storage.write(metaSidecarPath(row.storagePath), Buffer.from(JSON.stringify({ pageCount: 1, textChars: null, rasterPages: 1 })));
    await storage.write(pagePngPath(row.storagePath, 1), pngBytes());
    const consent = await mintVerifiedConsent(db, row);

    const blocks = await documentVisionBlocks(consent, storage, row);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('image');
  });

  it('kind pdf_scanned, 3 pages: a text label precedes each image, in order', async () => {
    const db = new FakeConsentDb();
    const { storage } = createFakeStorage();
    const row = db.addDocument(makeDocumentRow({ kind: 'pdf_scanned', mime: 'application/pdf', storagePath: 'org-1/s3.pdf' }));
    await storage.write(metaSidecarPath(row.storagePath), Buffer.from(JSON.stringify({ pageCount: 3, textChars: null, rasterPages: 3 })));
    for (const n of [1, 2, 3]) await storage.write(pagePngPath(row.storagePath, n), pngBytes(n));
    const consent = await mintVerifiedConsent(db, row);

    const blocks = await documentVisionBlocks(consent, storage, row);
    expect(blocks).toHaveLength(6);
    for (let i = 0; i < 3; i += 1) {
      const textBlock = blocks[i * 2];
      const imageBlockAt = blocks[i * 2 + 1];
      expect(textBlock.type).toBe('text');
      if (textBlock.type === 'text') expect(textBlock.text as unknown as string).toBe(`صفحة ${i + 1}:`);
      expect(imageBlockAt.type).toBe('image');
    }
  });

  it('kind pdf_text -> VisionInputError("unsupported_media")', async () => {
    const db = new FakeConsentDb();
    const { storage } = createFakeStorage();
    const row = db.addDocument(makeDocumentRow({ kind: 'pdf_scanned', mime: 'application/pdf' }));
    // mint consent while the document is still pdf_scanned-compatible, then
    // flip the row's kind to pdf_text for the call under test.
    const consent = await mintVerifiedConsent(db, row);
    const textRow: DocumentRow = { ...row, kind: 'pdf_text' };
    await expect(documentVisionBlocks(consent, storage, textRow)).rejects.toMatchObject({
      kind: 'unsupported_media',
    });
  });

  it('a consent minted for another document -> VisionInputError("consent_mismatch")', async () => {
    const db = new FakeConsentDb();
    const { storage } = createFakeStorage();
    const row1 = db.addDocument(makeDocumentRow({ storagePath: 'org-1/a.jpg' }));
    const row2 = db.addDocument(makeDocumentRow({ storagePath: 'org-1/b.jpg' }));
    await storage.write(row2.storagePath, jpegBytes());
    const consentForRow1 = await mintVerifiedConsent(db, row1);

    await expect(documentVisionBlocks(consentForRow1, storage, row2)).rejects.toMatchObject({
      kind: 'consent_mismatch',
    });
  });
});

describe('auditView / auditViewOfMessages', () => {
  it('strips data from an image/document block, keeping mediaType/sizeBytes/consentEventId', () => {
    const block: RedactedBlock = {
      type: 'image',
      mediaType: 'image/jpeg',
      data: 'base64...' as ConsentedBase64,
      consentEventId: 'evt-1',
      sizeBytes: 123,
    };
    const view = auditView(block) as Record<string, unknown>;
    expect(view).toEqual({ type: 'image', mediaType: 'image/jpeg', sizeBytes: 123, consentEventId: 'evt-1' });
    expect(view.data).toBeUndefined();
  });

  it('leaves text/tool blocks and string content unchanged', () => {
    const textBlock: RedactedBlock = { type: 'text', text: staticPrompt('hello') };
    expect(auditView(textBlock)).toBe(textBlock);

    const messages: RedactedMessage[] = [
      { role: 'user', content: staticPrompt('plain string content') },
      { role: 'assistant', content: [textBlock] },
    ];
    const view = auditViewOfMessages(messages);
    expect(view[0]).toEqual({ role: 'user', content: staticPrompt('plain string content') });
    expect(view[1]).toEqual({ role: 'assistant', content: [textBlock] });
  });
});

// ─── type-level guards ──────────────────────────────────────────────────────

describe('type-level guard: ConsentedBase64 / VerifiedConsent', () => {
  it('a plain string is not assignable to ConsentedBase64', () => {
    // @ts-expect-error a bare string must not satisfy the branded ConsentedBase64 type
    const _bad: ConsentedBase64 = 'plain string';
    void _bad;
  });

  it('a hand-built image block with a plain string data fails', () => {
    const _bad: RedactedBlock = {
      type: 'image',
      mediaType: 'image/jpeg',
      // @ts-expect-error a bare string must not satisfy ConsentedBase64
      data: 'plain string',
      consentEventId: 'evt-1',
      sizeBytes: 1,
    };
    void _bad;
  });

  it('a hand-built VerifiedConsent object literal fails', () => {
    // @ts-expect-error a plain object literal cannot satisfy the branded VerifiedConsent type
    const _bad: VerifiedConsent = {
      consentEventId: 'evt-1',
      documentId: 'doc-1',
      npiOrgId: 'org-1',
      npiUserId: 'user-1',
    };
    void _bad;
  });
});

// ─── src/audit/log.ts ───────────────────────────────────────────────────────

function makeAuditData(overrides: Partial<LlmAuditData> = {}): LlmAuditData {
  return {
    npiOrgId: 'org-1',
    npiUserId: 'user-1',
    conversationId: null,
    intakeJobId: null,
    documentId: null,
    event: 'chat',
    modelTier: 'economy',
    modelId: 'claude-haiku-4-5-20251001',
    tokensIn: 1,
    tokensOut: 1,
    costUsdMicro: 0n,
    outboundRedactedText: null,
    imageSent: false,
    consentEventId: null,
    latencyMs: 1,
    error: null,
    ...overrides,
  };
}

class FakeAuditDb implements AuditDb {
  rows: LlmAuditData[] = [];
  llmAudit = {
    create: async (args: { data: LlmAuditData }) => {
      this.rows.push(args.data);
      return args.data;
    },
  };
}

describe('writeLlmAudit', () => {
  it('throws AuditInvariantError (and never calls db.create) when imageSent is true with no consentEventId', async () => {
    const db = new FakeAuditDb();
    await expect(
      writeLlmAudit(db, makeAuditData({ imageSent: true, consentEventId: null })),
    ).rejects.toBeInstanceOf(AuditInvariantError);
    expect(db.rows).toHaveLength(0);
  });

  it('writes the row unchanged when imageSent is true with a consentEventId', async () => {
    const db = new FakeAuditDb();
    await writeLlmAudit(db, makeAuditData({ imageSent: true, consentEventId: 'evt-1' }));
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].consentEventId).toBe('evt-1');
  });
});

describe('writeAuditEvent', () => {
  it('writes a non-model row with every numeric/model field at its "nothing happened" value', async () => {
    const db = new FakeAuditDb();
    await writeAuditEvent(db, { npiOrgId: 'org-1', npiUserId: 'user-1', documentId: 'doc-1' }, 'refused_confidential');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      npiOrgId: 'org-1',
      npiUserId: 'user-1',
      documentId: 'doc-1',
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
    });
  });
});

// ─── src/llm/client.ts: vision pre-flight + audit ──────────────────────────

class FakeProvider implements ModelProvider {
  readonly name = 'anthropic' as const;
  calls: ProviderCall[] = [];
  constructor(private impl: (call: ProviderCall) => Promise<ModelResponse> | ModelResponse) {}
  async complete(call: ProviderCall): Promise<ModelResponse> {
    this.calls.push(call);
    return this.impl(call);
  }
}

interface UsageRow {
  npiOrgId: string;
  npiUserId: string;
  day: Date;
  tokensIn: number;
  tokensOut: number;
  costUsdMicro: bigint;
  messageCount: number;
}

class FakeLlmDb implements LlmDb {
  auditRows: LlmAuditData[] = [];
  usage = new Map<string, UsageRow>();
  dailyUsageOverride: { tokensIn: number; tokensOut: number } | null = null;

  llmAudit = {
    create: async (args: { data: LlmAuditData }) => {
      this.auditRows.push(args.data);
      return args.data;
    },
  };

  dailyUsage = {
    findUnique: async (): Promise<{ tokensIn: number; tokensOut: number } | null> => this.dailyUsageOverride,
    upsert: async (args: {
      where: { npiUserId_day: { npiUserId: string; day: Date } };
      create: UsageRow;
      update: { tokensIn: { increment: number }; tokensOut: { increment: number }; costUsdMicro: { increment: bigint } };
    }) => {
      this.usage.set(args.where.npiUserId_day.npiUserId, args.create);
      return args.create;
    },
  };
}

function okResponse(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    text: 'ok',
    toolCalls: [],
    stopReason: 'end_turn',
    tokensIn: 10,
    tokensOut: 10,
    modelId: 'claude-sonnet-5',
    ...overrides,
  };
}

async function makeImageMessages(db: FakeConsentDb): Promise<RedactedMessage[]> {
  const row = db.addDocument(makeDocumentRow());
  const consent = await mintVerifiedConsent(db, row);
  const block = imageBlock(consent, { mediaType: 'image/jpeg', bytes: jpegBytes() });
  return [{ role: 'user', content: [block] }];
}

function makeCtx(overrides: Partial<LlmContext> = {}): LlmContext {
  return { npiOrgId: 'org-1', npiUserId: 'user-1', ...overrides };
}

describe('createLlmClient: vision pre-flight and audit', () => {
  it('advanced + one image block: the provider receives it, the audit row has imageSent/consentEventId, and outboundRedactedText has no base64 data', async () => {
    const consentDb = new FakeConsentDb();
    const messages = await makeImageMessages(consentDb);
    const imageMsgBlock = messages[0].content as RedactedBlock[];
    const consentEventId = (imageMsgBlock[0] as { consentEventId: string }).consentEventId;

    const provider = new FakeProvider(() => okResponse());
    const db = new FakeLlmDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });

    const req: RedactedRequest = {
      tier: 'advanced',
      purpose: 'extract',
      system: staticPrompt('system'),
      messages,
    };
    await client.complete(req, makeCtx());

    expect(provider.calls).toHaveLength(1);
    const sentBlocks = provider.calls[0].request.messages[0].content as RedactedBlock[];
    expect(sentBlocks[0].type).toBe('image');

    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].imageSent).toBe(true);
    expect(db.auditRows[0].consentEventId).toBe(consentEventId);
    expect(db.auditRows[0].outboundRedactedText).not.toContain((sentBlocks[0] as { data: string }).data);
    expect(db.auditRows[0].outboundRedactedText).toContain('"type":"image"');
    expect(db.auditRows[0].outboundRedactedText).toContain(consentEventId);
  });

  it('economy tier + an image block: bad_request, zero provider calls, zero audit rows', async () => {
    const consentDb = new FakeConsentDb();
    const messages = await makeImageMessages(consentDb);
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeLlmDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });

    const req: RedactedRequest = { tier: 'economy', purpose: 'extract', system: staticPrompt('s'), messages };
    await expect(client.complete(req, makeCtx())).rejects.toMatchObject({ kind: 'bad_request' });
    expect(provider.calls).toHaveLength(0);
    expect(db.auditRows).toHaveLength(0);
  });

  it('two vision blocks with different consent event ids: bad_request before anything is sent', async () => {
    const consentDb = new FakeConsentDb();
    const row1 = consentDb.addDocument(makeDocumentRow());
    const row2 = consentDb.addDocument(makeDocumentRow());
    const consent1 = await mintVerifiedConsent(consentDb, row1);
    const consent2 = await mintVerifiedConsent(consentDb, row2);
    const block1 = imageBlock(consent1, { mediaType: 'image/jpeg', bytes: jpegBytes() });
    const block2 = imageBlock(consent2, { mediaType: 'image/jpeg', bytes: jpegBytes() });

    const provider = new FakeProvider(() => okResponse());
    const db = new FakeLlmDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    const req: RedactedRequest = {
      tier: 'advanced',
      purpose: 'extract',
      system: staticPrompt('s'),
      messages: [{ role: 'user', content: [block1, block2] }],
    };
    await expect(client.complete(req, makeCtx())).rejects.toMatchObject({ kind: 'bad_request' });
    expect(provider.calls).toHaveLength(0);
    expect(db.auditRows).toHaveLength(0);
  });

  it('provider throws after sending an image: audit row has imageSent true, the consent id, and the error kind', async () => {
    const consentDb = new FakeConsentDb();
    const messages = await makeImageMessages(consentDb);
    const consentEventId = ((messages[0].content as RedactedBlock[])[0] as { consentEventId: string }).consentEventId;
    const provider = new FakeProvider(() => {
      throw new LlmError('provider_down');
    });
    const db = new FakeLlmDb();
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    const req: RedactedRequest = { tier: 'advanced', purpose: 'extract', system: staticPrompt('s'), messages };
    await expect(client.complete(req, makeCtx())).rejects.toMatchObject({ kind: 'provider_down' });
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].imageSent).toBe(true);
    expect(db.auditRows[0].consentEventId).toBe(consentEventId);
    expect(db.auditRows[0].error).toBe('provider_down');
  });

  it('cap reached with an image in the request: the cap_reached row has imageSent false', async () => {
    const consentDb = new FakeConsentDb();
    const messages = await makeImageMessages(consentDb);
    const provider = new FakeProvider(() => okResponse());
    const db = new FakeLlmDb();
    db.dailyUsageOverride = { tokensIn: 600_000, tokensOut: 0 };
    const client = createLlmClient({ provider, db, env: {} as NodeJS.ProcessEnv });
    const req: RedactedRequest = { tier: 'advanced', purpose: 'extract', system: staticPrompt('s'), messages };
    await expect(client.complete(req, makeCtx())).rejects.toMatchObject({ kind: 'cap_reached' });
    expect(provider.calls).toHaveLength(0);
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].imageSent).toBe(false);
    expect(db.auditRows[0].consentEventId).toBeNull();
  });
});

// ─── src/llm/providers/anthropic.ts: image/document block mapping ─────────

class FakeAnthropicClient implements AnthropicLike {
  public lastParams: unknown;
  constructor(private impl: (params: unknown) => Promise<unknown>) {}
  messages = {
    create: async (params: unknown) => {
      this.lastParams = params;
      return this.impl(params);
    },
  };
}

function baseRequest(overrides: Partial<RedactedRequest> = {}): RedactedRequest {
  return {
    tier: 'advanced',
    purpose: 'extract',
    system: staticPrompt('system'),
    messages: [{ role: 'user', content: staticPrompt('hello') }],
    ...overrides,
  };
}

describe('createAnthropicProvider: image/document block mapping', () => {
  it('maps an image block to {type:"image", source:{type:"base64", media_type, data}}', async () => {
    const fake = new FakeAnthropicClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = createAnthropicProvider({ client: fake });
    const consentDb = new FakeConsentDb();
    const row = consentDb.addDocument(makeDocumentRow());
    const consent = await mintVerifiedConsent(consentDb, row);
    const image = imageBlock(consent, { mediaType: 'image/jpeg', bytes: jpegBytes() });

    await provider.complete({
      modelId: 'claude-sonnet-5',
      timeoutMs: 60_000,
      request: baseRequest({ messages: [{ role: 'user', content: [image, { type: 'text', text: staticPrompt('ما هذا؟') }] }] }),
    });

    const params = fake.lastParams as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const mappedImage = params.messages[0].content[0];
    expect(mappedImage.type).toBe('image');
    expect(mappedImage.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: image.data });
    // images placed before the text in content order
    expect(params.messages[0].content[1].type).toBe('text');

    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain('consentEventId');
    expect(serialized).not.toContain('sizeBytes');
  });

  it('maps a document (PDF) block to {type:"document", source:{...}, title}', async () => {
    const fake = new FakeAnthropicClient(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const provider = createAnthropicProvider({ client: fake });
    const consentDb = new FakeConsentDb();
    const row = consentDb.addDocument(makeDocumentRow({ kind: 'pdf_scanned', mime: 'application/pdf' }));
    const consent = await mintVerifiedConsent(consentDb, row);
    const pdf = pdfBlock(consent, { bytes: Buffer.from('%PDF-1.4 x', 'latin1'), title: 'عقد' });

    await provider.complete({
      modelId: 'claude-sonnet-5',
      timeoutMs: 60_000,
      request: baseRequest({ messages: [{ role: 'user', content: [pdf] }] }),
    });

    const params = fake.lastParams as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const mapped = params.messages[0].content[0];
    expect(mapped.type).toBe('document');
    expect(mapped.source).toEqual({ type: 'base64', media_type: 'application/pdf', data: pdf.data });
    expect(mapped.title).toBe('عقد');

    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain('consentEventId');
    expect(serialized).not.toContain('sizeBytes');
  });
});
