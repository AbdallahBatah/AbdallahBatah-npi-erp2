// The executor (T-27, F-11, D-T27-1/7/8/9): performs an approved plan against
// NPI, as the logged-in user, one step at a time.
//
//  - Strictly in order. A step's failure is final (ADR-29): the step is marked
//    `failed` with NPI's own Arabic message, nothing after it runs, nothing is
//    retried, and what was already created is reported (`npiEntityRefs`).
//  - Every state change is persisted to `intake_jobs.executionLogJson` BEFORE
//    the next NPI call, so a crash leaves a truthful log.
//  - Steps the copilot never performs (`manual`) are only marked, never called.
//  - The job is claimed with a conditional update (`status: 'approved'` →
//    `executing`), so a double «اعتمد» can never execute twice (D-T27-7).
//  - One `llm_audit` row per execution (`intake_executed` /
//    `intake_execution_failed`); its write never changes the outcome (D-T27-9).
import { writeAuditEvent, type AuditDb } from '../audit/log';
import { t } from '../i18n/ar';
import { asJson, type IntakeCaller, type IntakeJobDb, type IntakeJobRow } from '../intake/job';
import type { CreatedEntity, ExecutionLog, ExecutionStep } from '../intake/types';
import type { DocumentStorage } from '../intake/upload';
import type { NpiClient } from '../npi/client';
import { NpiError } from '../npi/errors';
import { readEntityRef } from '../npi/responses';
import { performCustomerContract } from './flows/customer_contract';
import { performGrn } from './flows/grn';
import { performPo } from './flows/po';
import { performPr } from './flows/pr';
import { performUserPermissions } from './flows/user_permissions';
import { performVendorBill } from './flows/vendor_bill';
import { StepFailure, type ExecutionPlan, type PlannedStep, type Ref } from './plan';

export type ExecutionNpi = Pick<
  NpiClient,
  | 'createCustomer'
  | 'createContract'
  | 'createRequisition'
  | 'submitRequisition'
  | 'createVendor'
  | 'createPurchaseOrder'
  | 'getRequisition'
  | 'convertRequisition'
  | 'receiveOnPurchaseOrder'
  | 'createBill'
  | 'attachFile'
  | 'setUserPermissions'
>;

export interface ExecuteDeps {
  db: IntakeJobDb & AuditDb;
  npi: ExecutionNpi;
  storage: DocumentStorage;
  now?: () => Date;
}

/** The job was not `approved` when the executor tried to claim it. */
export class ExecutionClaimError extends Error {
  constructor() {
    super('ExecutionClaimError');
    this.name = 'ExecutionClaimError';
  }
}

export interface PerformContext {
  npi: ExecutionNpi;
  /** What the steps done so far created, by 1-based step number. */
  created: Map<number, CreatedEntity>;
  /** The NPI id behind a `Ref`; throws a plain Error when the step it points
   *  at created nothing (a bug, reported as an unexpected error). */
  resolveRef(ref: Ref): string;
}

type Perform = (step: PlannedStep, ctx: PerformContext) => Promise<{ entity: CreatedEntity | null }>;

const PERFORM: Record<ExecutionPlan['flow'], Perform> = {
  customer_contract: performCustomerContract,
  pr: performPr,
  po: performPo,
  grn: performGrn,
  vendor_bill: performVendorBill,
  user_permissions: performUserPermissions,
};

// ─── The attachment (shared by every flow that has one) ─────────────────────

const NPI_UPLOAD_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp']);
const EXTENSION_OF_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** D-T27-4: NPI allows only a few extensions on an upload and drives what a
 *  browser does with a file by it. The stored name is kept when its extension
 *  is allowed; otherwise (a converted HEIC is stored as JPEG) the extension of
 *  the stored mime is appended. */
function uploadFileName(fileName: string, mime: string): string {
  const ext = /\.([^./\\]+)$/.exec(fileName)?.[1]?.toLowerCase();
  if (ext !== undefined && NPI_UPLOAD_EXTENSIONS.has(ext)) return fileName;
  const fromMime = EXTENSION_OF_MIME[mime];
  return fromMime === undefined ? fileName : `${fileName}.${fromMime}`;
}

async function performAttach(
  deps: ExecuteDeps,
  caller: IntakeCaller,
  job: IntakeJobRow,
  step: Extract<PlannedStep, { kind: 'attach' }>,
  ctx: PerformContext,
): Promise<{ entity: CreatedEntity | null }> {
  const row =
    job.documentId === null
      ? null
      : await deps.db.document.findFirst({ where: { id: job.documentId, npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId } });
  if (row === null) throw new StepFailure(t('document.error.not_found'));
  const bytes = await deps.storage.read(row.storagePath);
  if (bytes === null) throw new StepFailure(t('document.error.unreadable'));

  const fileName = uploadFileName(row.fileName, row.mime);
  const ref = readEntityRef(await deps.npi.attachFile(step.entityType, ctx.resolveRef(step.target), { fileName, mime: row.mime, bytes }));
  // An attachment has no business code in NPI; the card shows the file name
  // in its place (the raw cuid tells the user nothing).
  return { entity: { kind: 'attachment', id: ref.id, code: ref.code ?? fileName, npiPath: null } };
}

// ─── The executor ───────────────────────────────────────────────────────────

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function executeJob(deps: ExecuteDeps, caller: IntakeCaller, job: IntakeJobRow, plan: ExecutionPlan): Promise<IntakeJobRow> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const steps: ExecutionStep[] = plan.steps.map((s) => ({ n: s.n, labelAr: s.labelAr, state: 'pending' }));
  const log: ExecutionLog = { status: 'running', steps, startedAt: now().toISOString() };

  // Claim: only an `approved` job moves to `executing`.
  try {
    await db.intakeJob.update({ where: { id: job.id, status: 'approved' }, data: { status: 'executing', executionLogJson: asJson(clone(log)) } });
  } catch {
    throw new ExecutionClaimError();
  }

  const persist = async (): Promise<void> => {
    await db.intakeJob.update({ where: { id: job.id }, data: { executionLogJson: asJson(clone(log)) } });
  };

  const created = new Map<number, CreatedEntity>();
  const refs: CreatedEntity[] = [];
  const ctx: PerformContext = {
    npi: deps.npi,
    created,
    resolveRef(ref) {
      if ('id' in ref) return ref.id;
      const entity = created.get(ref.fromStep);
      if (entity === undefined) throw new Error(`executeJob: step ${ref.fromStep} created nothing`);
      return entity.id;
    },
  };

  const audit = async (event: 'intake_executed' | 'intake_execution_failed', error: string | null): Promise<void> => {
    try {
      await writeAuditEvent(
        db,
        { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId, conversationId: job.conversationId ?? undefined, intakeJobId: job.id, documentId: job.documentId ?? undefined },
        event,
        error,
      );
    } catch (err) {
      console.error('[copilot] execution audit write failed', job.id, err instanceof Error ? err.message : err);
    }
  };

  for (const planned of plan.steps) {
    const step = steps[planned.n - 1];

    if (planned.kind === 'manual') {
      step.state = 'manual';
      await persist();
      continue;
    }

    step.state = 'running';
    await persist();

    let entity: CreatedEntity | null;
    try {
      const outcome = planned.kind === 'attach' ? await performAttach(deps, caller, job, planned, ctx) : await PERFORM[plan.flow](planned, ctx);
      entity = outcome.entity;
    } catch (err) {
      let errorAr: string;
      if (err instanceof NpiError || err instanceof StepFailure) {
        errorAr = err.messageAr;
      } else {
        errorAr = t('exec.error.unexpected');
        console.error('[copilot] execution step failed', job.id, planned.n, err instanceof Error ? err.message : err);
      }
      step.state = 'failed';
      step.errorAr = errorAr;
      log.status = 'failed';
      log.failedAt = planned.n;
      log.finishedAt = now().toISOString();
      const row = await db.intakeJob.update({
        where: { id: job.id },
        data: { status: 'failed', executionLogJson: asJson(clone(log)), npiEntityRefs: asJson(clone(refs)), error: null },
      });
      await audit('intake_execution_failed', `${planned.n}: ${planned.labelAr} — ${errorAr}`);
      return row;
    }

    step.state = 'done';
    if (entity !== null) {
      created.set(planned.n, entity);
      refs.push(entity);
      step.entity = { kindAr: t(`exec.kind.${entity.kind}` as const), id: entity.id, code: entity.code, npiPath: entity.npiPath };
    }
    await persist();
  }

  log.status = 'done';
  log.finishedAt = now().toISOString();
  const row = await db.intakeJob.update({
    where: { id: job.id },
    data: { status: 'done', executionLogJson: asJson(clone(log)), npiEntityRefs: asJson(clone(refs)) },
  });
  await audit('intake_executed', null);
  return row;
}
