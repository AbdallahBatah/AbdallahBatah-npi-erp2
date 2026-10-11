// Fixtures for e2e/no-bypass.spec.ts (T-28): seeds genuine intake jobs, reads
// the copilot's own audit and job rows, and reads NPI's state back through its
// HTTP API as a given user (never NPI's database — 08 §E.10).
//
// A job needs an extraction, and no e2e may call the model (D-T28-1), so the
// extraction is the only scripted thing: `seedPreviewJob` calls the server's
// own `startIntake` from the test process with a `llm` that returns the T-26
// wire JSON. Everything else is the application's own code and the real
// systems: the copilot's Prisma client, the real NPI client carrying THAT
// user's token, the real resolution reads against NPI as that user, and the
// application's own `buildPreview`. The job in the database is therefore the
// job the chat would have made after the model answered.
import '../../tests/helpers/load-env';
import type { APIRequestContext } from '@playwright/test';
import { partiesFromNpi } from '../../src/extract/resolve';
import { PrismaClient } from '../../src/generated/prisma';
import { startIntake, type IntakeCaller, type StartIntakeDeps } from '../../src/intake/job';
import type { CreatedEntity, ExecutionLog, IntakeStatus } from '../../src/intake/types';
import { createFsStorage, docsRoot } from '../../src/intake/upload';
import type { ModelResponse } from '../../src/llm/provider';
import { createNpiClient } from '../../src/npi/client';
import { readList } from '../../src/npi/responses';
import { npiGet, npiLogin, type ScratchAccount } from './scratch-orgs';

const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
/** Same base `scratch-orgs.ts` targets: the e2e run's own NPI api. */
export const API_BASE = `http://localhost:${API_PORT}/api`;

// ─── The scripted extraction ────────────────────────────────────────────────

export interface ScriptedLlm {
  complete(): Promise<ModelResponse>;
  /** How many times the extraction was asked for. */
  readonly calls: number;
}

/**
 * The only stand-in in this spec: answers any extraction request with `wire`
 * and counts the asks. It is handed straight to `startIntake`, not to
 * `createLlmClient`, so it writes no `llm_audit` row — which is the point the
 * spec relies on: after seeding, the job's audit trail is empty, and any row
 * that appears later was written by the code under test.
 */
export function scriptedLlm(wire: unknown): ScriptedLlm {
  let calls = 0;
  return {
    async complete() {
      calls += 1;
      return {
        text: JSON.stringify(wire),
        toolCalls: [],
        stopReason: 'end_turn',
        tokensIn: 0,
        tokensOut: 0,
        modelId: 'scripted-no-model',
      };
    },
    get calls() {
      return calls;
    },
  };
}

// ─── Wire builders ──────────────────────────────────────────────────────────
// Copied from tests/intake-job.spec.ts (`f`, `none`, `prWire`, `contractWire`),
// not imported: that file is a test, and these two builders differ from the
// originals only where the real NPI needs it (a date after today, the seeded
// customer's VAT number).

type W = { value: string; confidence: number; evidence: string; page: number };
const f = (value: string | number | null, confidence = 1, evidence: string | null = 'q', page: number | null = 1): W => ({
  value: value === null ? '' : String(value),
  confidence,
  evidence: evidence ?? '',
  page: page ?? 0,
});
const none = (): W => ({ value: '', confidence: 0, evidence: '', page: 0 });

/** `YYYY-MM-DD` of today (local calendar, as `todayIso` in the extraction) plus `days`. */
export function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const CUSTOMER_NAME = 'شركة النخيل للمقاولات';

/** Seed catalogue item `MOD-550`, unitCost 320: 40 x 320 = 12,800, above the seeded
 *  requisition rule's 10,000 floor, so NPI parks the requisition for the `pm` role. */
function prWire() {
  return {
    justification: f('استكمال أعمال التركيب في المشروع', 0.9),
    projectCode: f('PRJ-00012'),
    projectName: none(),
    departmentName: none(),
    neededBy: f(isoDaysFromToday(3), 0.9),
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
  };
}

/** The customer's VAT number is the seeded customer CUS-00001's
 *  (packages/db/prisma/seed.ts, `vatNumber: '310000000000003'`), so the
 *  resolution reads `customer: matched` and plan step 1 is `customer_use` — no
 *  NPI write before the contract. */
export const SEEDED_CUSTOMER_VAT = '310000000000003';

function contractWire() {
  return {
    customer: {
      nameAr: f(CUSTOMER_NAME),
      nameEn: f('Al Nakheel Contracting'),
      customerType: f('CI'),
      vatNumber: f(SEEDED_CUSTOMER_VAT),
      crNumber: f('1010567890'),
      phone: f('0501234567'),
      email: f('info@nakheel.sa'),
    },
    contractType: f('EPC'),
    startDate: f(isoDaysFromToday(30)),
    endDate: f(isoDaysFromToday(210)),
    totalValue: f(850000),
    retentionPct: f(10),
    advancePct: none(),
    milestones: [
      { sequence: f(1), descriptionAr: f('دفعة مقدمة عند التوقيع'), descriptionEn: none(), amount: f(255000), percent: f(30), dueDate: none(), triggerType: f('EVENT') },
      { sequence: f(2), descriptionAr: f('عند اكتمال التوريد'), descriptionEn: none(), amount: f(340000), percent: f(40), dueDate: none(), triggerType: f('EVENT') },
      { sequence: f(3), descriptionAr: f('عند التشغيل والتسليم'), descriptionEn: none(), amount: f(255000), percent: f(30), dueDate: none(), triggerType: f('EVENT') },
    ],
  };
}

// ─── The copilot's own database ─────────────────────────────────────────────

let client: PrismaClient | undefined;
function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectNoBypassDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

export interface SeededJob {
  jobId: string;
  conversationId: string;
  caller: IntakeCaller;
  /** The user's NPI token as of the seeding; log in again for a later read. */
  token: string;
  /** How many extraction requests the scripted model received (exactly one). */
  llmCalls: number;
}

/**
 * A genuine intake job in `preview`, owned by `account`: a conversation row,
 * then the server's own `startIntake` with the scripted extraction. Nothing is
 * written to NPI (resolution only reads, as that user).
 */
export async function seedPreviewJob(
  request: APIRequestContext,
  account: ScratchAccount,
  flow: 'pr' | 'customer_contract',
  text: string,
): Promise<SeededJob> {
  const { token, orgId, userId } = await npiLogin(request, account);
  const caller: IntakeCaller = { npiOrgId: orgId, npiUserId: userId };
  const db = getClient();

  const conversation = await db.conversation.create({
    data: { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId, titleAr: text.slice(0, 60) },
    select: { id: true },
  });

  const llm = scriptedLlm(flow === 'pr' ? prWire() : contractWire());
  const deps: StartIntakeDeps = {
    // The real PrismaClient is what `buildTurn` hands `startIntake` too.
    db,
    llm,
    npi: createNpiClient({ token, baseUrl: API_BASE }),
    storage: createFsStorage(docsRoot()),
    dictionary: async () => [],
  };
  const outcome = await startIntake(deps, caller, {
    flow,
    text,
    documentId: null,
    conversationId: conversation.id,
    ourPartyNameAr: null,
  });
  if (!outcome.ok) throw new Error(`seedPreviewJob(${flow}): startIntake refused: ${outcome.messageAr}`);
  if (outcome.status !== 'preview') {
    throw new Error(`seedPreviewJob(${flow}): expected a preview, got ${outcome.status}: ${outcome.failureAr ?? ''}`);
  }
  return { jobId: outcome.jobId, conversationId: conversation.id, caller, token, llmCalls: llm.calls };
}

export interface AuditRow {
  event: string;
  error: string | null;
  intakeJobId: string | null;
}

/** `llm_audit` rows for a user and/or an intake job, oldest first. */
export async function auditRows(filter: { npiUserId?: string; intakeJobId?: string }): Promise<AuditRow[]> {
  if (filter.npiUserId === undefined && filter.intakeJobId === undefined) {
    throw new Error('auditRows: give a user or a job — an unfiltered read of the whole audit table is never what a test wants');
  }
  return getClient().llmAudit.findMany({
    where: { npiUserId: filter.npiUserId, intakeJobId: filter.intakeJobId },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    select: { event: true, error: true, intakeJobId: true },
  });
}

export interface JobRow {
  status: IntakeStatus;
  executionLogJson: ExecutionLog | null;
  npiEntityRefs: CreatedEntity[] | null;
}

/** The columns of `intake_jobs` the executor writes (`src/execute/run.ts`). */
export async function jobRow(jobId: string): Promise<JobRow> {
  const row = await getClient().intakeJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { status: true, executionLogJson: true, npiEntityRefs: true },
  });
  return {
    status: row.status,
    executionLogJson: row.executionLogJson as ExecutionLog | null,
    npiEntityRefs: row.npiEntityRefs as CreatedEntity[] | null,
  };
}

// ─── NPI reads (as a given user, over HTTP) ─────────────────────────────────

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null;
}

/** Reads fail loudly and say what changed, instead of an `undefined` surfacing three assertions later. */
function shape(what: string, body: unknown): never {
  throw new Error(`NPI response shape changed: ${what} (got ${JSON.stringify(body).slice(0, 300)})`);
}

function rec(value: unknown, what: string): Rec {
  return isRecord(value) ? value : shape(what, value);
}

function arr(value: unknown, what: string): unknown[] {
  return Array.isArray(value) ? value : shape(what, value);
}

function text(value: unknown, what: string): string {
  return typeof value === 'string' ? value : shape(what, value);
}

function num(value: unknown, what: string): number {
  return typeof value === 'number' ? value : shape(what, value);
}

export interface NpiRequisition {
  status: string;
  estimatedTotal: string | number;
  requestedById: string | null;
  pendingApproval: null | {
    status: string;
    currentStep: number;
    steps: Array<{ sequence: number; status: string; role: { id: string; nameAr: string; nameEn: string } }>;
  };
  workflow: { history: Array<{ actionCode: string; fromState: string; toState: string }> };
}

/**
 * `GET /requisitions/:id` (needs `scm.procurement.read`). Every field below is
 * on the wire as follows:
 *  - `status`, `estimatedTotal` (a Prisma Decimal, serialised as a string),
 *    `requestedById`: the `PurchaseRequisition` row spread by
 *    `requisitions.service.ts` `get()` (`return { ...pr, workflow, pendingApproval }`);
 *  - `pendingApproval`: `approvals.forDocument(...)`, which is `view(row)`
 *    (`approval.service.ts`), kept only while the chain is `PENDING`, else
 *    `null`: `status`, `currentStep`, `steps[{ sequence, status, role: { id, nameAr, nameEn } }]`;
 *  - `workflow.history`: `engine.history(...)`, the `WfHistory` rows
 *    (`actionCode`, `fromState`, `toState`, ...) oldest first. The engine
 *    appends an `OPEN` row when the document is created and one row per
 *    transition, so a submitted requisition's history is `OPEN`, `SUBMIT`.
 */
export async function npiRequisition(request: APIRequestContext, token: string, id: string): Promise<NpiRequisition> {
  const r = rec(await npiGet(request, token, `/requisitions/${encodeURIComponent(id)}`), 'requisition');

  const history = arr(rec(r.workflow, 'workflow').history, 'workflow.history').map((row) => {
    const h = rec(row, 'workflow.history row');
    return { actionCode: text(h.actionCode, 'actionCode'), fromState: text(h.fromState, 'fromState'), toState: text(h.toState, 'toState') };
  });

  let pendingApproval: NpiRequisition['pendingApproval'] = null;
  if (r.pendingApproval !== null && r.pendingApproval !== undefined) {
    const view = rec(r.pendingApproval, 'pendingApproval');
    pendingApproval = {
      status: text(view.status, 'pendingApproval.status'),
      currentStep: num(view.currentStep, 'pendingApproval.currentStep'),
      steps: arr(view.steps, 'pendingApproval.steps').map((s) => {
        const step = rec(s, 'pendingApproval.steps row');
        const role = rec(step.role, 'pendingApproval.steps row role');
        return {
          sequence: num(step.sequence, 'step.sequence'),
          status: text(step.status, 'step.status'),
          role: { id: text(role.id, 'role.id'), nameAr: text(role.nameAr, 'role.nameAr'), nameEn: text(role.nameEn, 'role.nameEn') },
        };
      }),
    };
  }

  const estimatedTotal = r.estimatedTotal;
  if (typeof estimatedTotal !== 'string' && typeof estimatedTotal !== 'number') shape('estimatedTotal', estimatedTotal);
  const requestedById = r.requestedById;
  if (requestedById !== null && typeof requestedById !== 'string') shape('requestedById', requestedById);

  return { status: text(r.status, 'status'), estimatedTotal, requestedById, pendingApproval, workflow: { history } };
}

export interface NpiInboxEntry {
  documentType: string;
  documentId: string;
  documentCode: string;
  /** Inbox rows only (`approval.service.ts` `inbox()`): the caller may sign this one. */
  canDecide: boolean | undefined;
}

/**
 * `GET /approvals/inbox` (`@SkipPermissions`, scoped to the caller's own role):
 * a bare array of `ApprovalRequestView` plus `canDecide`, `blockedReason`,
 * `viaDelegationFrom`, `escalated` (`approval.service.ts` `inbox()`). Only the
 * fields a document is identified by, and `canDecide`, are read here.
 */
export async function npiInbox(request: APIRequestContext, token: string): Promise<NpiInboxEntry[]> {
  return arr(await npiGet(request, token, '/approvals/inbox'), 'inbox').map((row) => {
    const e = rec(row, 'inbox row');
    return {
      documentType: text(e.documentType, 'documentType'),
      documentId: text(e.documentId, 'documentId'),
      documentCode: text(e.documentCode, 'documentCode'),
      canDecide: typeof e.canDecide === 'boolean' ? e.canDecide : undefined,
    };
  });
}

/**
 * How many rows a list endpoint returns. `GET /contracts` and `GET /customers`
 * are bare `findMany` arrays (`contracts.service.ts`, `customers.service.ts`);
 * `readList` is the application's own reader and also accepts `{ rows }`.
 */
export async function npiCount(request: APIRequestContext, token: string, listPath: '/contracts' | '/customers'): Promise<number> {
  return readList(await npiGet(request, token, listPath)).length;
}

/**
 * The Arabic name NPI holds for the customer with `vatNumber`, read through
 * the application's own `partiesFromNpi` — what the card's plan step quotes
 * (`partyLabel` in `src/intake/resolution.ts` is this same `nameAr`).
 */
export async function npiCustomerNameByVat(request: APIRequestContext, token: string, vatNumber: string): Promise<string> {
  const digits = (value: string) => value.replaceAll(/\D/g, '');
  const parties = partiesFromNpi(await npiGet(request, token, '/customers'));
  const found = parties.find((p) => p.vatNumber !== null && digits(p.vatNumber) === digits(vatNumber));
  if (!found) throw new Error(`npiCustomerNameByVat: no customer with VAT ${vatNumber} in NPI`);
  return found.nameAr;
}
