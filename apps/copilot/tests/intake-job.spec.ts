// T-26: starting an intake job (src/intake/job.ts) and acting on it
// (src/intake/edit.ts) — in-memory db, scripted model, fake NPI lists and an
// in-memory document store. No network, no real database.
import path from 'node:path';
import { t } from '../src/i18n/ar';
import { LlmError, type LlmContext } from '../src/llm/client';
import type { ModelResponse, RedactedBlock, RedactedRequest } from '../src/llm/provider';
import type { LlmAuditData } from '../src/audit/log';
import { executeJob, type ExecuteDeps, type ExecutionNpi } from '../src/execute/run';
import { NpiError } from '../src/npi/errors';
import type { DictionaryEntry } from '../src/privacy/pseudonymizer';
import { clearPromptCache } from '../src/prompts/load';
import type { ConsentEventRow } from '../src/intake/consent';
import { metaSidecarPath, textSidecarPath, type DocumentKind, type DocumentRow, type DocumentStorage } from '../src/intake/upload';
import { getIntakeView, startIntake, type StartIntakeDeps, type StartIntakeInput } from '../src/intake/job';
import { applyIntakeAction, IntakeEditFailed, IntakePlanFailed, IntakeStateError, type EditDeps } from '../src/intake/edit';
import type { ResolutionNpi } from '../src/intake/resolution';
import type { CreatedEntity, ExecutionLog, IntakeAction, IntakeView, PreviewField, StoredExtraction, StoredPreview } from '../src/intake/types';

process.env.COPILOT_PROMPTS_DIR = path.resolve(__dirname, '../prompts');

// ─── wire helpers ───────────────────────────────────────────────────────────

type W = { value: string; confidence: number; evidence: string; page: number };
const f = (value: string | number | null, confidence = 1, evidence: string | null = 'q', page: number | null = 1): W => ({
  value: value === null ? '' : String(value),
  confidence,
  evidence: evidence ?? '',
  page: page ?? 0,
});
const none = (): W => ({ value: '', confidence: 0, evidence: '', page: 0 });

const CUSTOMER = 'شركة النخيل للمقاولات';
const VENDOR = 'شركة الخليج للألواح الشمسية';
const NOW = new Date('2026-10-05T09:00:00.000Z');
const CALLER = { npiOrgId: 'org-1', npiUserId: 'user-1' };
const DICTIONARY: DictionaryEntry[] = [
  { kind: 'customer', npiId: 'cus-1', names: [CUSTOMER] },
  { kind: 'vendor', npiId: 'ven-1', names: [VENDOR] },
];
const TOKEN = /⟦[^⟧]+⟧/g;

function prWire(overrides: Record<string, unknown> = {}) {
  return {
    justification: f('استكمال أعمال التركيب في المشروع', 0.9),
    projectCode: f('PRJ-00012'),
    projectName: none(),
    departmentName: none(),
    neededBy: f('2026-10-08', 0.9),
    currency: none(),
    lines: [
      {
        itemName: f('لوح 550 واط'),
        sku: f('MOD-550'),
        qty: f(40),
        unit: none(),
        estimatedUnitPrice: none(),
        wbsCode: none(),
        wbsName: none(),
        notes: none(),
      },
    ],
    ...overrides,
  };
}

function contractWire(overrides: Record<string, unknown> = {}, customer: Record<string, unknown> = {}) {
  return {
    customer: {
      nameAr: f(CUSTOMER),
      nameEn: f('Al Nakheel Contracting'),
      customerType: f('CI'),
      vatNumber: f('310123456700003'),
      crNumber: f('1010567890'),
      phone: f('0501234567'),
      email: f('info@nakheel.sa'),
      ...customer,
    },
    contractType: f('EPC'),
    startDate: f('2026-11-01'),
    endDate: f('2027-04-30'),
    totalValue: f(850000),
    retentionPct: f(10),
    advancePct: none(),
    milestones: [
      { sequence: f(1), descriptionAr: f('دفعة مقدمة عند التوقيع'), descriptionEn: none(), amount: f(255000), percent: f(30), dueDate: none(), triggerType: f('EVENT') },
      { sequence: f(2), descriptionAr: f('عند اكتمال التوريد'), descriptionEn: none(), amount: f(340000), percent: f(40), dueDate: none(), triggerType: f('EVENT') },
      { sequence: f(3), descriptionAr: f('عند التشغيل والتسليم'), descriptionEn: none(), amount: f(255000), percent: f(30), dueDate: none(), triggerType: f('EVENT') },
    ],
    ...overrides,
  };
}

function grnWire() {
  const serials = Array.from({ length: 8 }, (_, i) => `GS550-2609-${String(i + 1).padStart(4, '0')}`).join(';');
  return {
    purchaseOrderCode: f('PO-00007'),
    deliveryNoteRef: f('DN-4471'),
    deliveryDate: f('2026-10-04'),
    vendorName: f(VENDOR),
    projectCode: f('PRJ-00012'),
    locationName: f('مستودع الرياض'),
    notes: none(),
    lines: [{ itemName: f('لوح شمسي 550 واط'), sku: f('MOD-550'), qty: f(8), unit: f('قطعة'), serials: f(serials), batchNo: none(), notes: none() }],
  };
}

function reply(text: string): ModelResponse {
  return { text, toolCalls: [], stopReason: 'end_turn', tokensIn: 100, tokensOut: 50, modelId: 'claude-sonnet-5' };
}

// ─── fakes ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function withoutUndefined(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function createFakeDb() {
  let seq = 0;
  const jobs = new Map<string, Row>();
  const documents = new Map<string, DocumentRow>();
  const consentEvents = new Map<string, ConsentEventRow>();
  const audit: LlmAuditData[] = [];
  // Rows are cloned in and out, as a real database would: the caller can
  // neither alias the stored JSON nor store something that is not JSON.
  const clone = <T>(value: T): T => structuredClone(value);

  const api = {
    intakeJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: Row = { id: `job-${seq}`, approvedAt: null, createdAt: NOW, updatedAt: NOW, ...clone(withoutUndefined(data)) };
        jobs.set(row.id, row);
        return clone(row);
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = [...jobs.values()].find((row) => matches(row, where));
        return found ? clone(found) : null;
      },
      // Honours every key of `where` (a conditional update) and rejects when
      // no row matches, as Prisma does with P2025 (D-T27-7).
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = [...jobs.values()].find((r) => matches(r, where));
        if (!row) throw new Error(`P2025: no job matches ${JSON.stringify(where)}`);
        Object.assign(row, clone(withoutUndefined(data)), { updatedAt: NOW });
        return clone(row);
      },
    },
    document: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = [...documents.values()].find((row) => matches(row as unknown as Record<string, unknown>, where));
        return found ? clone(found) : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<DocumentRow> }) => {
        const row = documents.get(where.id);
        if (!row) throw new Error('no document');
        Object.assign(row, data);
        return clone(row);
      },
    },
    consentEvent: {
      findUnique: async ({ where }: { where: { id: string } }) => consentEvents.get(where.id) ?? null,
    },
    llmAudit: {
      create: async ({ data }: { data: LlmAuditData }) => {
        audit.push(clone(data));
        return data;
      },
    },
  };

  return { api, jobs, documents, consentEvents, audit };
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
  const putJson = (relPath: string, value: unknown) => files.set(relPath, new TextEncoder().encode(JSON.stringify(value)));
  return { storage, files, putJson };
}

function createFakeNpi() {
  const forbidden = () =>
    new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden resource' });
  return {
    listCustomers: jest.fn(async () => [{ id: 'cus-1', code: 'CUS-00001', nameAr: CUSTOMER, nameEn: 'Al Nakheel Contracting', vatNumber: '310123456700003' }]),
    listVendors: jest.fn(async () => [{ id: 'ven-1', code: 'VEN-00001', nameAr: VENDOR, vatNumber: '311111111111113' }]),
    listProjects: jest.fn(async () => [{ id: 'prj-12', code: 'PRJ-00012', nameAr: 'محطة الرياض الشمسية' }]),
    getProject: jest.fn(async () => ({ id: 'prj-12', code: 'PRJ-00012', wbsElements: [] })),
    // An engineer cannot read the department list: the normal "unreadable" case.
    listDepartments: jest.fn(async () => {
      throw forbidden();
    }),
    listRequisitions: jest.fn(async () => [{ id: 'req-12', code: 'PR-00012', status: 'APPROVED' }]),
    listPurchaseOrders: jest.fn(async () => [{ id: 'po-7', code: 'PO-00007', status: 'SENT', vendorId: 'ven-1', vendor: { nameAr: VENDOR } }]),
    getPurchaseOrder: jest.fn(async () => ({
      id: 'po-7',
      code: 'PO-00007',
      status: 'SENT',
      vendorId: 'ven-1',
      lines: [
        { id: 'pol-1', itemId: 'itm-550', qty: '40', receivedQty: '0', unitPrice: '320', item: { sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', isSerialised: true } },
      ],
      goodsReceipts: [],
    })),
    listItems: jest.fn(async () => [{ id: 'itm-550', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', unitCost: '320' }]),

    // Writes (T-27): every one a `jest.fn`, so the tests can count them.
    createCustomer: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'cus-9', code: 'CUS-00009' })),
    createContract: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'con-1', code: 'CON-00012' })),
    createRequisition: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'req-1', code: 'PR-00031' })),
    submitRequisition: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'wf-1' })),
    createVendor: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'ven-9', code: 'VEN-00009' })),
    createPurchaseOrder: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'po-9', code: 'PO-00009' })),
    getRequisition: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'req-12', code: 'PR-00012', lines: [{ id: 'prl-1', itemId: 'itm-550' }] })),
    convertRequisition: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'po-9', code: 'PO-00009' })),
    receiveOnPurchaseOrder: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'grn-5', code: 'GRN-00005' })),
    createBill: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'bill-4', code: 'VB-00004' })),
    attachFile: jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: 'att-1' })),
  };
}

type FakeNpi = ReturnType<typeof createFakeNpi>;

/** Every NPI write the executor can make. */
const npiWrites = (npi: FakeNpi) => [
  npi.createCustomer,
  npi.createContract,
  npi.createRequisition,
  npi.submitRequisition,
  npi.createVendor,
  npi.createPurchaseOrder,
  npi.convertRequisition,
  npi.receiveOnPurchaseOrder,
  npi.createBill,
  npi.attachFile,
];

class FakeLlm {
  requests: RedactedRequest[] = [];
  contexts: LlmContext[] = [];
  constructor(private impl: (req: RedactedRequest, ctx: LlmContext) => ModelResponse | Promise<ModelResponse>) {}
  async complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> {
    this.requests.push(JSON.parse(JSON.stringify(req)) as RedactedRequest);
    this.contexts.push(ctx);
    return this.impl(req, ctx);
  }
}

function makeDocument(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'doc-1',
    npiOrgId: 'org-1',
    npiUserId: 'user-1',
    fileName: 'عقد.pdf',
    mime: 'application/pdf',
    sizeBytes: 4096,
    sha256: 'a'.repeat(64),
    storagePath: 'org-1/contract.pdf',
    kind: 'pdf_text' as DocumentKind,
    sensitivityFlag: false,
    consentEventId: null,
    extractedTextRedactedRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Scripts {
  /** The reply to an extraction request. */
  extract?: (req: RedactedRequest, ctx: LlmContext) => ModelResponse | Promise<ModelResponse>;
  /** The reply to a sentence-edit request. */
  edit?: (req: RedactedRequest, ctx: LlmContext) => ModelResponse | Promise<ModelResponse>;
}

function createWorld(scripts: Scripts) {
  const fake = createFakeDb();
  const store = createFakeStorage();
  const npi = createFakeNpi();
  const llm = new FakeLlm((req, ctx) => {
    if (req.purpose.endsWith('_edit')) {
      if (!scripts.edit) throw new Error('unexpected edit call');
      return scripts.edit(req, ctx);
    }
    if (!scripts.extract) throw new Error('unexpected extraction call');
    return scripts.extract(req, ctx);
  });
  const deps: StartIntakeDeps = {
    db: fake.api as unknown as StartIntakeDeps['db'],
    llm,
    npi: npi as unknown as ResolutionNpi,
    storage: store.storage,
    dictionary: async () => DICTIONARY,
    now: () => NOW,
  };
  const executeDeps: ExecuteDeps = {
    db: fake.api as unknown as ExecuteDeps['db'],
    npi: npi as unknown as ExecutionNpi,
    storage: store.storage,
    now: () => NOW,
  };
  const editDeps: EditDeps = {
    db: fake.api as unknown as EditDeps['db'],
    llm,
    npi: npi as unknown as ResolutionNpi,
    dictionary: async () => DICTIONARY,
    now: () => NOW,
    // What `buildEditDeps` wires: approve runs the plan against the same db and NPI.
    execute: (job, plan) => executeJob(executeDeps, CALLER, job, plan),
  };
  return { ...fake, store, npi, llm, deps, editDeps };
}

type World = ReturnType<typeof createWorld>;

const inputOf = (overrides: Partial<StartIntakeInput> = {}): StartIntakeInput => ({
  flow: 'pr',
  text: 'أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس',
  documentId: null,
  conversationId: 'conv-1',
  ourPartyNameAr: null,
  ...overrides,
});

async function start(world: World, overrides: Partial<StartIntakeInput> = {}): Promise<string> {
  const outcome = await startIntake(world.deps, CALLER, inputOf(overrides));
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
  if (outcome.status !== 'preview') throw new Error(`expected preview, got ${outcome.status}: ${outcome.failureAr}`);
  return outcome.jobId;
}

const act = (world: World, action: IntakeAction, caller = CALLER) => applyIntakeAction(world.editDeps, caller, action);

function stored(world: World, jobId: string) {
  const row = world.jobs.get(jobId)!;
  return {
    row,
    extracted: row.extractedJson as StoredExtraction,
    preview: row.previewJson as StoredPreview,
  };
}

function viewField(view: IntakeView, path: string): PreviewField {
  const model = view.preview!;
  const all = [...model.sections.flatMap((s) => s.fields), ...(model.lines?.rows.flatMap((r) => r.fields) ?? [])];
  const found = all.find((x) => x.path === path);
  if (!found) throw new Error(`no field ${path}`);
  return found;
}

const contentText = (req: RedactedRequest): string => {
  const content = req.messages[0].content;
  return typeof content === 'string' ? content : JSON.stringify(content);
};

beforeEach(() => clearPromptCache());

// ─── startIntake ────────────────────────────────────────────────────────────

describe('startIntake — a sentence (purchase requisition)', () => {
  it('opens the job before the model call, reads NPI, and stores a preview', async () => {
    let statusDuringCall: unknown;
    const holder: { world?: World } = {};
    const world = createWorld({
      extract: (_req, ctx) => {
        // The job exists and says «extracting» while the model works, and the
        // audit context carries its id (llm_audit.intakeJobId).
        statusDuringCall = holder.world?.jobs.get(ctx.intakeJobId ?? '')?.status;
        return reply(JSON.stringify(prWire()));
      },
    });

    holder.world = world;

    const outcome = await startIntake(world.deps, CALLER, inputOf());

    expect(outcome).toEqual({ ok: true, jobId: expect.any(String), status: 'preview', failureAr: null });
    if (!outcome.ok) return;
    expect(statusDuringCall).toBe('extracting');
    expect(world.llm.contexts[0]).toMatchObject({ npiOrgId: 'org-1', npiUserId: 'user-1', conversationId: 'conv-1', intakeJobId: outcome.jobId });
    expect(world.llm.requests).toHaveLength(1);
    expect(world.llm.requests[0].purpose).toBe('extract_pr');
    expect(contentText(world.llm.requests[0])).toContain('أبي 40 لوح 550 واط');

    const { row, extracted, preview } = stored(world, outcome.jobId);
    expect(world.jobs.size).toBe(1);
    expect(row).toMatchObject({ status: 'preview', flowType: 'pr', conversationId: 'conv-1', npiOrgId: 'org-1', npiUserId: 'user-1' });
    expect(row.documentId ?? null).toBeNull();

    // extractedJson: the wire JSON the model returned, the flags, the hint, one usage entry.
    expect(extracted.output).toEqual(prWire());
    expect(extracted.userHint).toBe('أبي 40 لوح 550 واط للمشروع PRJ-00012 قبل الخميس');
    expect(extracted.flags).toEqual({ ligatureSuspect: false, referenceDate: '2026-10-05' });
    expect(extracted.source.kind).toBe('text');
    expect(extracted.usage).toHaveLength(1);
    expect(extracted.usage[0]).toMatchObject({ tokensIn: 100, tokensOut: 50, modelId: 'claude-sonnet-5' });

    // previewJson: resolution from the NPI lists, nothing decided yet.
    expect(world.npi.listProjects).toHaveBeenCalled();
    expect(world.npi.listItems).toHaveBeenCalled();
    expect(preview.resolution?.project).toMatchObject({ kind: 'matched', id: 'prj-12' });
    expect(preview.resolution?.lines[0].item).toMatchObject({ kind: 'matched', id: 'itm-550', by: 'sku' });
    expect(preview.resolution?.lines[0].unitCost).toBe(320);
    expect(preview.choices).toEqual({});
    expect(preview.confirmed).toEqual([]);
    expect(Object.keys(preview.fields)).toEqual(expect.arrayContaining(['justification', 'lines.0.qty']));
    expect(preview.model.sections[0].key).toBe('request');
    expect(preview.model.steps.map((s) => s.labelAr)).toEqual([t('preview.step.pr_create', { n: 1 }), t('preview.step.pr_submit')]);
  });

  it('sends the sentence redacted and stores the model’s answer with the names back in place', async () => {
    const world = createWorld({
      extract: (req) => {
        const tokens = contentText(req).match(TOKEN) ?? [];
        expect(tokens.length).toBeGreaterThan(0);
        return reply(JSON.stringify(prWire({ justification: f(`توريد للعميل ${tokens[0]}`, 0.9) })));
      },
    });
    const jobId = await start(world, { text: `أبي 40 لوح 550 واط للمشروع PRJ-00012 لصالح ${CUSTOMER}` });

    expect(contentText(world.llm.requests[0])).not.toContain('النخيل');
    const { extracted } = stored(world, jobId);
    expect(JSON.stringify(extracted.output)).toContain(CUSTOMER);
    expect(JSON.stringify(extracted.output)).not.toMatch(TOKEN);
  });

  it('records a model failure on the job: the Arabic reason, no preview', async () => {
    const world = createWorld({
      extract: () => {
        throw new LlmError('timeout');
      },
    });
    const outcome = await startIntake(world.deps, CALLER, inputOf());

    expect(outcome).toEqual({ ok: true, jobId: expect.any(String), status: 'failed', failureAr: t('extract.failed.model_error') });
    if (!outcome.ok) return;
    const { row } = stored(world, outcome.jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe(t('extract.failed.model_error'));
    expect(row.extractedJson ?? null).toBeNull();
    expect(row.previewJson ?? null).toBeNull();

    const view = await getIntakeView(world.deps, CALLER, outcome.jobId);
    expect(view).toMatchObject({ id: outcome.jobId, status: 'failed', preview: null, failureAr: t('extract.failed.model_error'), execution: null, flow: 'pr', flowLabelAr: t('flow.pr') });
  });

  it('fails the job when the model’s JSON is unusable', async () => {
    const world = createWorld({ extract: () => reply('هذا ليس JSON') });
    const outcome = await startIntake(world.deps, CALLER, inputOf());
    expect(outcome).toMatchObject({ ok: true, status: 'failed', failureAr: t('extract.failed.invalid_json') });
  });

  it('gives a flow with nothing usable the incomplete message, as a preview (not a failure)', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(prWire({ lines: [] }))) });
    const outcome = await startIntake(world.deps, CALLER, inputOf());
    expect(outcome).toMatchObject({ ok: true, status: 'preview' });
    if (!outcome.ok) return;
    const { preview } = stored(world, outcome.jobId);
    expect(preview.resolution).toBeNull();
    expect(preview.model.incompleteAr).toBe(t('extract.incomplete.pr'));
    expect(preview.model.canApprove).toBe(false);
    expect(world.npi.listItems).not.toHaveBeenCalled();
  });

  it('tells the model which company is ours', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(contractWire())) });
    await start(world, { flow: 'customer_contract', text: 'عقد جديد مع النخيل', ourPartyNameAr: 'شركة الطاقة الوطنية والصناعية' });
    expect(world.llm.requests[0].purpose).toBe('extract_customer_contract');
    expect(world.llm.requests[0].system).toContain('شركة الطاقة الوطنية والصناعية');
  });
});

describe('startIntake — a stored text PDF', () => {
  const CONTRACT_PAGES = [
    { num: 1, text: `عقد توريد وتركيب نظام طاقة شمسية\nالطرف الأول: ${CUSTOMER}، السجل التجاري 1010567890.\nالطرف الثاني: شركة NPI للطاقة الشمسية.` },
    { num: 2, text: 'قيمة العقد الإجمالية: 850,000 ريال سعودي. نسبة المحتجزات: 10%.' },
  ];

  it('reads the sidecar pages, redacts the names outbound and rehydrates them in the output', async () => {
    const world = createWorld({
      extract: (req) => {
        const body = contentText(req);
        const token = /الطرف الأول: (⟦[^⟧]+⟧)/.exec(body)?.[1];
        expect(token).toBeDefined();
        return reply(JSON.stringify(contractWire({}, { nameAr: f(token ?? '') })));
      },
    });
    world.documents.set('doc-1', makeDocument());
    world.store.putJson(textSidecarPath('org-1/contract.pdf'), { pages: CONTRACT_PAGES });
    world.store.putJson(metaSidecarPath('org-1/contract.pdf'), { pageCount: 3, textChars: 900, rasterPages: 0 });

    const jobId = await start(world, { flow: 'customer_contract', text: null, documentId: 'doc-1' });

    const sent = contentText(world.llm.requests[0]);
    expect(sent).not.toContain('النخيل');
    expect(sent).toContain('=== صفحة 2 ===');
    expect(sent).toContain('850,000');
    expect(world.llm.contexts[0]).toMatchObject({ intakeJobId: jobId, documentId: 'doc-1' });

    const { row, extracted, preview } = stored(world, jobId);
    expect(row.documentId).toBe('doc-1');
    expect(extracted.userHint ?? null).toBeNull();
    expect(extracted.source).toEqual({ kind: 'text', pages: 2 });
    expect((extracted.output as { customer: { nameAr: W } }).customer.nameAr.value).toBe(CUSTOMER);
    expect(preview.resolution?.customer).toMatchObject({ kind: 'matched', id: 'cus-1', by: 'vat' });
    // A document exists, so the plan ends by attaching it.
    expect(preview.model.steps.map((s) => s.labelAr)).toContain(t('preview.step.attach'));
  });

  it('refuses a document that is not the caller’s: no job, no model call', async () => {
    const world = createWorld({ extract: () => reply('{}') });
    world.documents.set('doc-1', makeDocument({ npiUserId: 'someone-else' }));
    const outcome = await startIntake(world.deps, CALLER, inputOf({ flow: 'customer_contract', text: null, documentId: 'doc-1' }));
    expect(outcome).toEqual({ ok: false, reason: 'document_not_found', messageAr: t('document.error.not_found') });
    expect(world.jobs.size).toBe(0);
    expect(world.llm.requests).toHaveLength(0);

    const missing = await startIntake(world.deps, CALLER, inputOf({ documentId: 'doc-404' }));
    expect(missing).toMatchObject({ ok: false, reason: 'document_not_found' });
  });
});

describe('startIntake — a photo (vision)', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);

  function photoWorld() {
    const world = createWorld({ extract: () => reply(JSON.stringify(grnWire())) });
    world.documents.set('doc-2', makeDocument({ id: 'doc-2', kind: 'image', mime: 'image/jpeg', fileName: 'اشعار-تسليم.jpg', storagePath: 'org-1/dn.jpg' }));
    world.store.files.set('org-1/dn.jpg', JPEG);
    world.store.putJson(metaSidecarPath('org-1/dn.jpg'), { pageCount: 1, textChars: null, rasterPages: 1 });
    return world;
  }

  it('without a recorded consent: no model call and no job row', async () => {
    const world = photoWorld();
    const outcome = await startIntake(world.deps, CALLER, inputOf({ flow: 'grn', text: null, documentId: 'doc-2' }));
    expect(outcome).toEqual({ ok: false, reason: 'consent_required', messageAr: t('intake.consent_required') });
    expect(world.llm.requests).toHaveLength(0);
    expect(world.jobs.size).toBe(0);
  });

  it('after a withdrawn consent: still refused', async () => {
    const world = photoWorld();
    world.consentEvents.set('ce-0', { id: 'ce-0', documentId: 'doc-2', npiOrgId: 'org-1', npiUserId: 'user-1', decision: 'cancelled', policyLine: 'x', createdAt: NOW });
    world.documents.get('doc-2')!.consentEventId = 'ce-0';
    const outcome = await startIntake(world.deps, CALLER, inputOf({ flow: 'grn', text: null, documentId: 'doc-2' }));
    expect(outcome).toMatchObject({ ok: false, reason: 'consent_required' });
    expect(world.jobs.size).toBe(0);
  });

  it('with an approved consent: the image goes out under its consent id and the job reaches a preview', async () => {
    const world = photoWorld();
    world.consentEvents.set('ce-1', { id: 'ce-1', documentId: 'doc-2', npiOrgId: 'org-1', npiUserId: 'user-1', decision: 'approved', policyLine: 'x', createdAt: NOW });
    world.documents.get('doc-2')!.consentEventId = 'ce-1';

    const jobId = await start(world, { flow: 'grn', text: null, documentId: 'doc-2' });

    const content = world.llm.requests[0].messages[0].content as RedactedBlock[];
    expect(Array.isArray(content)).toBe(true);
    const image = content.find((block) => block.type === 'image');
    expect(image).toMatchObject({ type: 'image', mediaType: 'image/jpeg', consentEventId: 'ce-1' });
    expect(world.llm.contexts[0]).toMatchObject({ intakeJobId: jobId, documentId: 'doc-2' });

    const { extracted, preview } = stored(world, jobId);
    expect(extracted.source.kind).toBe('vision');
    expect(preview.resolution?.purchaseOrder).toMatchObject({ kind: 'matched', id: 'po-7' });
    expect(world.npi.getPurchaseOrder).toHaveBeenCalledWith('po-7');
    expect(preview.model.sections[0].key).toBe('delivery');
  });

  it('a stored image that cannot be read fails the job with the unreadable-document message', async () => {
    const world = photoWorld();
    world.consentEvents.set('ce-1', { id: 'ce-1', documentId: 'doc-2', npiOrgId: 'org-1', npiUserId: 'user-1', decision: 'approved', policyLine: 'x', createdAt: NOW });
    world.documents.get('doc-2')!.consentEventId = 'ce-1';
    world.store.files.delete('org-1/dn.jpg');

    const outcome = await startIntake(world.deps, CALLER, inputOf({ flow: 'grn', text: null, documentId: 'doc-2' }));
    expect(outcome).toMatchObject({ ok: true, status: 'failed', failureAr: t('document.error.unreadable') });
    expect(world.llm.requests).toHaveLength(0);
  });
});

// ─── getIntakeView ──────────────────────────────────────────────────────────

describe('getIntakeView', () => {
  it('returns the document with its page count from the meta sidecar', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(contractWire())) });
    world.documents.set('doc-1', makeDocument());
    world.store.putJson(textSidecarPath('org-1/contract.pdf'), { pages: [{ num: 1, text: `الطرف الأول: ${CUSTOMER}` }] });
    world.store.putJson(metaSidecarPath('org-1/contract.pdf'), { pageCount: 3, textChars: 900, rasterPages: 0 });
    const jobId = await start(world, { flow: 'customer_contract', text: null, documentId: 'doc-1' });

    const view = await getIntakeView(world.deps, CALLER, jobId);
    expect(view).not.toBeNull();
    expect(view).toMatchObject({
      id: jobId,
      flow: 'customer_contract',
      flowLabelAr: t('flow.customer_contract'),
      status: 'preview',
      conversationId: 'conv-1',
      failureAr: null,
      execution: null,
      approvedAt: null,
      document: { id: 'doc-1', fileName: 'عقد.pdf', kind: 'pdf_text', pageCount: 3 },
    });
    expect(view!.preview?.flowLabelAr).toBe(t('flow.customer_contract'));
    expect(typeof view!.createdAt).toBe('string');
  });

  it('has no document for a sentence, and does not exist for another user', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(prWire())) });
    const jobId = await start(world);
    expect((await getIntakeView(world.deps, CALLER, jobId))!.document).toBeNull();
    expect(await getIntakeView(world.deps, { npiOrgId: 'org-1', npiUserId: 'user-2' }, jobId)).toBeNull();
    expect(await getIntakeView(world.deps, { npiOrgId: 'org-2', npiUserId: 'user-1' }, jobId)).toBeNull();
    expect(await getIntakeView(world.deps, CALLER, 'job-404')).toBeNull();
  });
});

// ─── applyIntakeAction ──────────────────────────────────────────────────────

/** A contract whose total and retention the model was unsure of. */
const unsureContract = () => contractWire({ totalValue: f(850000, 0.5, 'القيمة 850,000', 2), retentionPct: f(10, 0.5, 'المحتجزات 10%', 2) });

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const CONTRACT_PDF_PAGES = [
  { num: 1, text: `عقد توريد وتركيب نظام طاقة شمسية\nالطرف الأول: ${CUSTOMER}، السجل التجاري 1010567890.` },
  { num: 2, text: 'قيمة العقد الإجمالية: 850,000 ريال سعودي. نسبة المحتجزات: 10%.' },
];

/** The stored contract PDF (text sidecar, meta sidecar and the bytes) a job can be started on. */
function storeContractPdf(world: World) {
  world.documents.set('doc-1', makeDocument());
  world.store.putJson(textSidecarPath('org-1/contract.pdf'), { pages: CONTRACT_PDF_PAGES });
  world.store.putJson(metaSidecarPath('org-1/contract.pdf'), { pageCount: 3, textChars: 900, rasterPages: 0 });
  world.store.files.set('org-1/contract.pdf', PDF_BYTES);
}

async function contractWorld(wire: unknown = unsureContract(), edit?: Scripts['edit'], options: { document?: boolean } = {}) {
  const world = createWorld({ extract: () => reply(JSON.stringify(wire)), edit });
  if (options.document) storeContractPdf(world);
  const jobId = await start(world, {
    flow: 'customer_contract',
    text: `عقد جديد مع ${CUSTOMER} بقيمة 850,000`,
    documentId: options.document ? 'doc-1' : null,
  });
  return { world, jobId };
}

async function expectReason(promise: Promise<unknown>, reason: string | RegExp) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(IntakeStateError);
  if (typeof reason === 'string') expect((error as IntakeStateError).reason).toBe(reason);
  else expect((error as IntakeStateError).reason).toMatch(reason);
}

describe('applyIntakeAction — confirm', () => {
  it('confirms a confirmable field without reading NPI again', async () => {
    const { world, jobId } = await contractWorld();
    const before = await getIntakeView(world.deps, CALLER, jobId);
    expect(viewField(before!, 'totalValue')).toMatchObject({ status: 'unconfirmed', confirmable: true });
    expect(before!.preview!.canApprove).toBe(false);
    const reads = world.npi.listCustomers.mock.calls.length;

    const view = await act(world, { id: jobId, action: 'confirm', path: 'totalValue' });

    expect(viewField(view, 'totalValue').status).toBe('confirmed');
    expect(viewField(view, 'retentionPct').status).toBe('unconfirmed');
    expect(view.preview!.canApprove).toBe(false);
    expect(stored(world, jobId).preview.confirmed).toEqual(['totalValue']);
    expect(world.npi.listCustomers.mock.calls.length).toBe(reads);

    const done = await act(world, { id: jobId, action: 'confirm', path: 'retentionPct' });
    expect(done.preview!.canApprove).toBe(true);
    expect(done.preview!.blockersAr).toEqual([]);
  });

  it('refuses a field NPI would reject, a field that is fine, and a path that does not exist', async () => {
    const { world, jobId } = await contractWorld(contractWire({}, { vatNumber: f('31012345670003') }));
    await expectReason(act(world, { id: jobId, action: 'confirm', path: 'customer.vatNumber' }), 'not_confirmable');
    await expectReason(act(world, { id: jobId, action: 'confirm', path: 'contractType' }), 'not_confirmable');
    await expectReason(act(world, { id: jobId, action: 'confirm', path: 'nope.nothing' }), 'not_confirmable');
    expect(stored(world, jobId).preview.confirmed).toEqual([]);
  });
});

describe('applyIntakeAction — set', () => {
  it('patches the wire JSON at the path, re-assesses, and reads NPI again', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(prWire())) });
    const jobId = await start(world);
    const reads = world.npi.listProjects.mock.calls.length;

    const view = await act(world, { id: jobId, action: 'set', path: 'lines.0.qty', value: '45' });

    const { extracted, preview } = stored(world, jobId);
    const wire = extracted.output as { lines: { qty: W; itemName: W }[] };
    expect(wire.lines[0].qty).toEqual({ value: '45', confidence: 1, evidence: '', page: 0 });
    expect(wire.lines[0].itemName.value).toBe('لوح 550 واط');
    expect(preview.confirmed).toEqual(['lines.0.qty']);
    expect(preview.fields['lines.0.qty'].value).toBe(45);
    expect(world.npi.listProjects.mock.calls.length).toBeGreaterThan(reads);
    expect(viewField(view, 'lines.0.qty')).toMatchObject({ value: 45, displayAr: '45', status: 'confirmed' });
    expect(view.status).toBe('preview');
    expect(world.llm.requests).toHaveLength(1);
  });

  it('can supply a missing required value, which clears the blocker', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(prWire({ justification: none() }))) });
    const jobId = await start(world);
    const before = await getIntakeView(world.deps, CALLER, jobId);
    expect(before!.preview!.canApprove).toBe(false);
    expect(before!.preview!.blockersAr).toContain(t('preview.block.required', { fields: 'سبب الطلب' }));

    const view = await act(world, { id: jobId, action: 'set', path: 'justification', value: 'استكمال أعمال التركيب في المشروع' });
    expect(viewField(view, 'justification')).toMatchObject({ value: 'استكمال أعمال التركيب في المشروع', status: 'confirmed' });
    expect(view.preview!.canApprove).toBe(true);
  });

  it('refuses a path that is not a field of the preview', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(prWire())) });
    const jobId = await start(world);
    await expectReason(act(world, { id: jobId, action: 'set', path: 'lines.9.qty', value: '1' }), 'bad_path');
    await expectReason(act(world, { id: jobId, action: 'set', path: 'noSuchField', value: '1' }), 'bad_path');
    expect((stored(world, jobId).extracted.output as { lines: { qty: W }[] }).lines[0].qty.value).toBe('40');
  });
});

describe('applyIntakeAction — choose', () => {
  it('records the decision and changes the plan', async () => {
    const { world, jobId } = await contractWorld(contractWire());
    const view = await act(world, { id: jobId, action: 'choose', target: 'customer', choice: 'new' });
    expect(view.preview!.choices[0]).toMatchObject({ target: 'customer', chosen: 'new' });
    expect(view.preview!.steps[0].labelAr).toBe(t('preview.step.customer_new', { name: CUSTOMER }));
    expect(stored(world, jobId).preview.choices).toEqual({ customer: 'new' });

    const back = await act(world, { id: jobId, action: 'choose', target: 'customer', choice: 'cus-1' });
    expect(back.preview!.steps[0].labelAr).toBe(t('preview.step.customer_use', { name: CUSTOMER }));
  });

  it('refuses an option the choice does not offer, and a target nobody asked about', async () => {
    const { world, jobId } = await contractWorld(contractWire());
    await expectReason(act(world, { id: jobId, action: 'choose', target: 'customer', choice: 'cus-999' }), 'bad_choice');
    await expectReason(act(world, { id: jobId, action: 'choose', target: 'vendor', choice: 'new' }), /^bad_/);
    expect(stored(world, jobId).preview.choices).toEqual({});
  });
});

describe('applyIntakeAction — edit by sentence', () => {
  /** What the model does with the edit request: copy the JSON it was given,
   *  change the retention to 5, return it whole. */
  const retentionTo5: Scripts['edit'] = (req) => {
    const body = contentText(req);
    const current = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as Record<string, unknown>;
    current.retentionPct = f(5, 1, 'المحتجزات 5%', 0);
    return reply(JSON.stringify(current));
  };

  it('sends the current JSON and the sentence once, redacted, and rebuilds the preview from the answer', async () => {
    const { world, jobId } = await contractWorld(unsureContract(), retentionTo5);
    await act(world, { id: jobId, action: 'confirm', path: 'totalValue' });
    await act(world, { id: jobId, action: 'confirm', path: 'retentionPct' });
    expect(stored(world, jobId).preview.confirmed.sort()).toEqual(['retentionPct', 'totalValue']);

    const view = await act(world, { id: jobId, action: 'edit', text: 'المحتجزات 5%' });

    // One more model call, the edit one, with the schema and no document.
    expect(world.llm.requests).toHaveLength(2);
    const request = world.llm.requests[1];
    expect(request.purpose).toBe('extract_customer_contract_edit');
    expect(request.tier).toBe('advanced');
    expect(request.system).not.toContain('{{today}}');
    expect(request.system).toContain('2026-10-05');
    expect(request.jsonSchema).toBeDefined();
    const body = contentText(request);
    expect(body).toContain('تعديل المستخدم: المحتجزات 5%');
    expect(body).toContain('"retentionPct"');
    expect(body).not.toContain('النخيل');
    expect(world.llm.contexts[1]).toMatchObject({ intakeJobId: jobId });

    // The new value is shown; the customer’s name is in clear again.
    expect(viewField(view, 'retentionPct')).toMatchObject({ value: 5, displayAr: '5', status: 'confirmed' });
    const { extracted, preview } = stored(world, jobId);
    expect((extracted.output as { customer: { nameAr: W } }).customer.nameAr.value).toBe(CUSTOMER);
    expect(JSON.stringify(extracted.output)).not.toMatch(TOKEN);
    expect(extracted.usage).toHaveLength(2);

    // The total did not change: the user’s confirmation stays. The retention did: it is dropped.
    expect(preview.confirmed).toEqual(['totalValue']);
    expect(viewField(view, 'totalValue').status).toBe('confirmed');
    expect(view.status).toBe('preview');
  });

  it('drops decisions whose target no longer exists after the rebuild', async () => {
    const dropCustomerName: Scripts['edit'] = (req) => {
      const body = contentText(req);
      const current = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as { customer: Record<string, unknown> };
      current.customer.nameAr = none();
      return reply(JSON.stringify(current));
    };
    const { world, jobId } = await contractWorld(contractWire(), dropCustomerName);
    await act(world, { id: jobId, action: 'choose', target: 'customer', choice: 'new' });
    expect(stored(world, jobId).preview.choices).toEqual({ customer: 'new' });

    const view = await act(world, { id: jobId, action: 'edit', text: 'احذف اسم العميل' });
    expect(view.preview!.incompleteAr).toBe(t('extract.incomplete'));
    expect(stored(world, jobId).preview.choices).toEqual({});
  });

  it('leaves the job untouched when the model’s answer is unusable', async () => {
    const { world, jobId } = await contractWorld(unsureContract(), () => reply('هذا ليس JSON'));
    const before = JSON.stringify(world.jobs.get(jobId));

    const error = await act(world, { id: jobId, action: 'edit', text: 'المحتجزات 5%' }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(IntakeEditFailed);
    expect((error as IntakeEditFailed).messageAr).toBe(t('extract.failed.invalid_json'));
    expect(JSON.stringify(world.jobs.get(jobId))).toBe(before);
    expect(world.jobs.get(jobId)!.status).toBe('preview');
  });

  it('reports a model outage the same way and keeps the job', async () => {
    const { world, jobId } = await contractWorld(unsureContract(), () => {
      throw new LlmError('timeout');
    });
    const before = JSON.stringify(world.jobs.get(jobId));
    await expect(act(world, { id: jobId, action: 'edit', text: 'المحتجزات 5%' })).rejects.toMatchObject({ messageAr: t('extract.failed.model_error') });
    expect(JSON.stringify(world.jobs.get(jobId))).toBe(before);
  });
});

function expectNoNpiWrites(world: World) {
  for (const write of npiWrites(world.npi)) expect(write).not.toHaveBeenCalled();
}

const executionOf = (view: IntakeView): ExecutionLog => view.execution as ExecutionLog;

describe('applyIntakeAction — approve executes in NPI (T-27)', () => {
  it('a contract with its document: the customer is used, the contract is created, the document attached, activation left to NPI', async () => {
    const { world, jobId } = await contractWorld(contractWire(), undefined, { document: true });
    const ready = await getIntakeView(world.deps, CALLER, jobId);
    expect(ready!.preview!.canApprove).toBe(true);
    expect(ready!.preview!.steps).toHaveLength(4);
    expectNoNpiWrites(world);

    const view = await act(world, { id: jobId, action: 'approve' });

    // The card’s own steps, now carried out.
    expect(view.status).toBe('done');
    expect(new Date(view.approvedAt!).toISOString()).toBe(NOW.toISOString());
    const execution = executionOf(view);
    expect(execution.status).toBe('done');
    expect(execution.steps.map((s) => s.labelAr)).toEqual(ready!.preview!.steps.map((s) => s.labelAr));
    expect(execution.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'manual']);
    expect(execution.steps[0].entity).toBeUndefined();
    expect(execution.steps[1].entity).toEqual({ kindAr: t('exec.kind.contract'), id: 'con-1', code: 'CON-00012', npiPath: '/contracts/con-1' });
    expect(execution.steps[2].entity).toMatchObject({ kindAr: t('exec.kind.attachment'), id: 'att-1', npiPath: null });
    expect(view.failureAr).toBeNull();
    expect(view.preview).not.toBeNull();

    // NPI: the existing customer (matched by VAT) is not created again; the contract goes on it.
    expect(world.npi.createCustomer).not.toHaveBeenCalled();
    expect(world.npi.createContract).toHaveBeenCalledTimes(1);
    expect(world.npi.createContract.mock.calls[0][0]).toMatchObject({ customerId: 'cus-1', contractType: 'EPC', totalValue: 850000 });
    expect(world.npi.attachFile).toHaveBeenCalledTimes(1);
    expect(world.npi.attachFile).toHaveBeenCalledWith('contract', 'con-1', { fileName: 'عقد.pdf', mime: 'application/pdf', bytes: PDF_BYTES });

    const row = world.jobs.get(jobId)!;
    expect(row.status).toBe('done');
    expect(row.approvedAt).toEqual(NOW);
    expect((row.executionLogJson as ExecutionLog).status).toBe('done');
    expect((row.npiEntityRefs as CreatedEntity[]).map((e) => [e.kind, e.id])).toEqual([
      ['contract', 'con-1'],
      ['attachment', 'att-1'],
    ]);

    // No model call for the execution: the one request is the extraction.
    expect(world.llm.requests).toHaveLength(1);
    // One audit row for the execution, tied to the job and its conversation.
    expect(world.audit).toHaveLength(1);
    expect(world.audit[0]).toMatchObject({ event: 'intake_executed', intakeJobId: jobId, documentId: 'doc-1', conversationId: 'conv-1', tokensIn: 0, imageSent: false });
  });

  it('NPI refuses the contract: the job is failed with the log, the preview stays and can be read, nothing is retried', async () => {
    const { world, jobId } = await contractWorld(contractWire(), undefined, { document: true });
    world.npi.createContract.mockRejectedValueOnce(new NpiError({ status: 409, kind: 'conflict', npiMessage: 'Contract number already exists' }));

    const view = await act(world, { id: jobId, action: 'approve' });

    expect(view.status).toBe('failed');
    expect(view.failureAr).toBeNull();
    expect(view.preview).not.toBeNull();
    expect(view.preview!.canApprove).toBe(true);
    expect(view.approvedAt).not.toBeNull();

    const execution = executionOf(view);
    expect(execution.status).toBe('failed');
    expect(execution.failedAt).toBe(2);
    expect(execution.steps.map((s) => s.state)).toEqual(['done', 'failed', 'pending', 'pending']);
    expect(execution.steps[1].errorAr).toContain('NPI رفض');
    expect(execution.steps[1].errorAr).toContain('Contract number already exists');

    expect(world.npi.createContract).toHaveBeenCalledTimes(1);
    expect(world.npi.attachFile).not.toHaveBeenCalled();
    expect(world.jobs.get(jobId)!.status).toBe('failed');
    expect(world.audit.map((a) => a.event)).toEqual(['intake_execution_failed']);

    // The same job reads back the same way.
    const again = await getIntakeView(world.deps, CALLER, jobId);
    expect(again).toMatchObject({ status: 'failed', failureAr: null });
    expect(again!.execution).toEqual(view.execution);
    // A failed job accepts nothing further: the user starts a new one.
    await expectReason(act(world, { id: jobId, action: 'approve' }), 'state');
    expect(world.npi.createContract).toHaveBeenCalledTimes(1);
  });

  it('a purchase requisition: created with the matched item and project and the item’s price, then submitted', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(prWire())) });
    const jobId = await start(world);
    const ready = await getIntakeView(world.deps, CALLER, jobId);
    expect(ready!.preview!.blockersAr).toEqual([]);

    const view = await act(world, { id: jobId, action: 'approve' });

    expect(view.status).toBe('done');
    expect(executionOf(view).steps.map((s) => s.state)).toEqual(['done', 'done']);
    expect(executionOf(view).steps[0].entity).toEqual({ kindAr: t('exec.kind.requisition'), id: 'req-1', code: 'PR-00031', npiPath: '/requisitions/req-1' });
    expect(world.npi.createRequisition).toHaveBeenCalledTimes(1);
    expect(world.npi.createRequisition.mock.calls[0][0]).toMatchObject({
      justification: 'استكمال أعمال التركيب في المشروع',
      projectId: 'prj-12',
      neededBy: '2026-10-08',
      lines: [{ itemId: 'itm-550', qty: 40, estimatedUnitPrice: 320 }],
    });
    expect(world.npi.submitRequisition).toHaveBeenCalledTimes(1);
    expect(world.npi.submitRequisition.mock.calls[0][0]).toBe('req-1');
    // A sentence has no document: nothing to attach, and the model is not called again.
    expect(world.npi.attachFile).not.toHaveBeenCalled();
    expect(world.llm.requests).toHaveLength(1);
  });

  it('a goods receipt: received on the matched PO against the PO line, with its serials and the delivery note', async () => {
    const world = createWorld({ extract: () => reply(JSON.stringify(grnWire())) });
    const jobId = await start(world, { flow: 'grn', text: 'وصلت الشحنة من أمر الشراء PO-00007: 8 ألواح 550 واط' });
    const ready = await getIntakeView(world.deps, CALLER, jobId);
    expect(ready!.preview!.blockersAr).toEqual([]);

    const view = await act(world, { id: jobId, action: 'approve' });

    expect(view.status).toBe('done');
    expect(executionOf(view).steps.map((s) => s.state)).toEqual(['done', 'manual']);
    expect(executionOf(view).steps[0].entity).toEqual({ kindAr: t('exec.kind.goods_receipt'), id: 'grn-5', code: 'GRN-00005', npiPath: '/procurement/po-7' });
    expect(world.npi.receiveOnPurchaseOrder).toHaveBeenCalledTimes(1);
    const [poId, dto] = world.npi.receiveOnPurchaseOrder.mock.calls[0] as [string, { lines: { poLineId: string; qty: number; serials: string[] }[]; notes?: string }];
    expect(poId).toBe('po-7');
    expect(dto.lines[0]).toMatchObject({ poLineId: 'pol-1', qty: 8 });
    expect(dto.lines[0].serials).toHaveLength(8);
    expect(dto.notes).toContain('DN-4471');
  });

  it('refuses to approve while something blocks, and writes nothing to NPI', async () => {
    const { world, jobId } = await contractWorld(unsureContract(), undefined, { document: true });
    await expectReason(act(world, { id: jobId, action: 'approve' }), 'state');
    expect(world.jobs.get(jobId)!.status).toBe('preview');
    expect(world.jobs.get(jobId)!.approvedAt ?? null).toBeNull();
    expect(world.jobs.get(jobId)!.executionLogJson ?? null).toBeNull();
    expectNoNpiWrites(world);
    expect(world.npi.getRequisition).not.toHaveBeenCalled();
    expect(world.audit).toHaveLength(0);
  });

  it('a plan that cannot be built is refused before anything is stored or written', async () => {
    // A line whose item NPI does not have is blocked on the card; here the
    // stored model is tampered with so that «اعتمد» is allowed, as a stale card could be.
    const world = createWorld({
      extract: () => reply(JSON.stringify(prWire({ lines: [{ ...prWire().lines[0], itemName: f('كابل نحاسي 6 ملم'), sku: f('CBL-6') }] }))),
    });
    const jobId = await start(world);
    const before = await getIntakeView(world.deps, CALLER, jobId);
    expect(before!.preview!.canApprove).toBe(false);
    expect(before!.preview!.blockersAr).toContain(t('preview.block.resolution', { reason: t('preview.item_required', { name: 'كابل نحاسي 6 ملم' }) }));
    stored(world, jobId).preview.model.canApprove = true;

    const error = await act(world, { id: jobId, action: 'approve' }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(IntakePlanFailed);
    expect((error as IntakePlanFailed).messageAr).toContain(t('preview.item_required', { name: 'كابل نحاسي 6 ملم' }));
    const row = world.jobs.get(jobId)!;
    expect(row.status).toBe('preview');
    expect(row.approvedAt ?? null).toBeNull();
    expect(row.executionLogJson ?? null).toBeNull();
    expectNoNpiWrites(world);
    expect(world.audit).toHaveLength(0);
  });

  it('approving twice executes once: the second approve is a state conflict', async () => {
    const { world, jobId } = await contractWorld(contractWire(), undefined, { document: true });
    await act(world, { id: jobId, action: 'approve' });
    await expectReason(act(world, { id: jobId, action: 'approve' }), 'state');

    expect(world.npi.createContract).toHaveBeenCalledTimes(1);
    expect(world.npi.attachFile).toHaveBeenCalledTimes(1);
    expect(world.audit).toHaveLength(1);
  });

  it('two approvals racing: one executes, the other is a state conflict (the conditional update)', async () => {
    const { world, jobId } = await contractWorld(contractWire(), undefined, { document: true });

    const outcomes = await Promise.allSettled([act(world, { id: jobId, action: 'approve' }), act(world, { id: jobId, action: 'approve' })]);

    const won = outcomes.filter((o): o is PromiseFulfilledResult<IntakeView> => o.status === 'fulfilled');
    const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(won[0].value.status).toBe('done');
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(IntakeStateError);
    expect((lost[0].reason as IntakeStateError).reason).toBe('state');
    expect(world.npi.createContract).toHaveBeenCalledTimes(1);
    expect(world.npi.attachFile).toHaveBeenCalledTimes(1);
    expect(world.audit).toHaveLength(1);
  });

  it('cancels a preview', async () => {
    const { world, jobId } = await contractWorld();
    const view = await act(world, { id: jobId, action: 'cancel' });
    expect(view.status).toBe('cancelled');
    expect(world.jobs.get(jobId)!.status).toBe('cancelled');
    expectNoNpiWrites(world);
  });

  it.each<[string, (id: string) => IntakeAction]>([
    ['confirm', (id) => ({ id, action: 'confirm', path: 'totalValue' })],
    ['set', (id) => ({ id, action: 'set', path: 'totalValue', value: '900000' })],
    ['choose', (id) => ({ id, action: 'choose', target: 'customer', choice: 'new' })],
    ['edit', (id) => ({ id, action: 'edit', text: 'المحتجزات 5%' })],
    ['approve', (id) => ({ id, action: 'approve' })],
    ['cancel', (id) => ({ id, action: 'cancel' })],
  ])('%s on a job that was already executed (done) is a state conflict and changes nothing', async (_name, build) => {
    const { world, jobId } = await contractWorld(contractWire());
    const executed = await act(world, { id: jobId, action: 'approve' });
    expect(executed.status).toBe('done');
    const before = JSON.stringify(world.jobs.get(jobId));
    const writes = npiWrites(world.npi).map((w) => w.mock.calls.length);

    await expectReason(act(world, build(jobId)), 'state');

    expect(JSON.stringify(world.jobs.get(jobId))).toBe(before);
    expect(npiWrites(world.npi).map((w) => w.mock.calls.length)).toEqual(writes);
    expect(world.llm.requests).toHaveLength(1);
  });

  it('a cancelled job accepts nothing further', async () => {
    const { world, jobId } = await contractWorld();
    await act(world, { id: jobId, action: 'cancel' });
    await expectReason(act(world, { id: jobId, action: 'approve' }), 'state');
    await expectReason(act(world, { id: jobId, action: 'confirm', path: 'totalValue' }), 'state');
  });
});

describe('applyIntakeAction — items must already exist in NPI (D-T27-5)', () => {
  /** Two near-identical panels and a quote line that names neither by SKU. */
  function twoPanelsWorld() {
    const world = createWorld({
      extract: () => reply(JSON.stringify(prWire({ lines: [{ ...prWire().lines[0], itemName: f('لوح شمسي 550'), sku: none() }] }))),
    });
    world.npi.listItems.mockResolvedValue([
      { id: 'itm-550', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', unitCost: '320' },
      { id: 'itm-545', sku: 'MOD-545', nameAr: 'لوح شمسي 545 واط', unitCost: '310' },
    ]);
    return world;
  }

  it('the item question offers the candidates and no «جديد»; «new» is refused as a choice', async () => {
    const world = twoPanelsWorld();
    const jobId = await start(world);
    const view = await getIntakeView(world.deps, CALLER, jobId);
    const item = view!.preview!.choices.find((c) => c.target === 'lines.0.item');
    expect(item).toBeDefined();
    expect(item!.options.map((o) => o.id)).not.toContain('new');
    expect(item!.chosen).toBeNull();
    expect(view!.preview!.canApprove).toBe(false);

    await expectReason(act(world, { id: jobId, action: 'choose', target: 'lines.0.item', choice: 'new' }), 'bad_choice');
    expect(stored(world, jobId).preview.choices).toEqual({});

    const picked = await act(world, { id: jobId, action: 'choose', target: 'lines.0.item', choice: item!.options[0].id });
    expect(picked.preview!.canApprove).toBe(true);
  });

  it('a stored «new» for an item (decided before T-27) is forgotten on the next rebuild and blocks again', async () => {
    const world = twoPanelsWorld();
    const jobId = await start(world);
    stored(world, jobId).preview.choices['lines.0.item'] = 'new';

    const view = await act(world, { id: jobId, action: 'set', path: 'justification', value: 'استكمال أعمال التركيب' });

    expect(stored(world, jobId).preview.choices).toEqual({});
    expect(view.preview!.canApprove).toBe(false);
    await expectReason(act(world, { id: jobId, action: 'approve' }), 'state');
    expectNoNpiWrites(world);
  });
});

describe('applyIntakeAction — ownership', () => {
  it('another user’s job, another organization’s job and a job that does not exist are all not_found', async () => {
    const { world, jobId } = await contractWorld();
    await expectReason(act(world, { id: jobId, action: 'cancel' }, { npiOrgId: 'org-1', npiUserId: 'user-2' }), 'not_found');
    await expectReason(act(world, { id: jobId, action: 'cancel' }, { npiOrgId: 'org-2', npiUserId: 'user-1' }), 'not_found');
    await expectReason(act(world, { id: 'job-404', action: 'cancel' }), 'not_found');
    expect(world.jobs.get(jobId)!.status).toBe('preview');
  });
});

describe('IntakeStateError / IntakeEditFailed', () => {
  it('carry their reason and Arabic message', () => {
    const state = new IntakeStateError('bad_path');
    expect(state).toBeInstanceOf(Error);
    expect(state.reason).toBe('bad_path');
    const failed = new IntakeEditFailed(t('extract.failed.invalid_json'));
    expect(failed).toBeInstanceOf(Error);
    expect(failed.messageAr).toBe(t('extract.failed.invalid_json'));
  });
});
