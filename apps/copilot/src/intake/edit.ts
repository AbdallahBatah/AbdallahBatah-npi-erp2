// The operations a user performs on a preview (T-26, D-T26-3..6): confirm a
// field, set a field by hand, choose between NPI matches, edit with a
// sentence, approve, cancel. Every operation that changes what the card shows
// rebuilds the preview from the stored wire JSON, so the stored model can never
// drift from the stored fields. Only the sentence edit calls the model; none of
// them writes to NPI except «approve»: since T-27 approval EXECUTES — it builds
// the plan, records the decision and runs the plan against NPI inside the same
// request (D-T27-1), returning the final view (`done` | `failed`).
import { buildPlan, PlanError, type ExecutionPlan } from '../execute/plan';
import { ExecutionClaimError } from '../execute/run';
import { FLOWS, runEdit, type ExtractDeps, type FlowSpec } from '../extract/run';
import { t } from '../i18n/ar';
import { Pseudonymizer, type DictionaryEntry } from '../privacy/pseudonymizer';
import { asJson, loadDocumentView, toIntakeView, type IntakeCaller, type IntakeJobDb, type IntakeJobRow } from './job';
import { buildPreview } from './preview';
import { resolveFlow, type ResolutionNpi } from './resolution';
import type { ExecutionLog, FlowResolution, IntakeAction, IntakeView, PreviewField, PreviewModel, StoredExtraction, StoredPreview } from './types';
import type { DocumentStorage } from './upload';

export interface EditDeps {
  db: IntakeJobDb;
  llm: ExtractDeps['llm'];
  npi: ResolutionNpi;
  dictionary(): Promise<DictionaryEntry[]>;
  now?: () => Date;
  /** Runs an approved plan against NPI (`execute/run.ts` `executeJob`); the
   *  job passed in is already `approved`. Rejects with `ExecutionClaimError`
   *  when it no longer is. */
  execute(job: IntakeJobRow, plan: ExecutionPlan): Promise<IntakeJobRow>;
  /** Only for the document's page count on the returned view; without it the
   *  count the extraction recorded is used. */
  storage?: DocumentStorage;
}

export class IntakeStateError extends Error {
  constructor(readonly reason: 'not_found' | 'state' | 'bad_path' | 'bad_choice' | 'not_confirmable') {
    super(`IntakeStateError: ${reason}`);
    this.name = 'IntakeStateError';
  }
}

/** The sentence edit failed (the model could not apply it); the job is unchanged. */
export class IntakeEditFailed extends Error {
  constructor(readonly messageAr: string) {
    super('IntakeEditFailed');
    this.name = 'IntakeEditFailed';
  }
}

/** The approved values cannot be turned into an execution plan; nothing was
 *  persisted or written (T-27). `messageAr` is shown to the user. */
export class IntakePlanFailed extends Error {
  constructor(readonly messageAr: string) {
    super('IntakePlanFailed');
    this.name = 'IntakePlanFailed';
  }
}

// ─── Wire JSON access ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nodeAt(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(node)) node = node[Number(segment)];
    else if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, segment)) node = node[segment];
    else return undefined;
  }
  return node;
}

function isWireField(node: unknown): node is { value: string; confidence: number; evidence: string; page: number } {
  return isRecord(node) && typeof node.value === 'string' && typeof node.confidence === 'number';
}

function wireValueAt(root: unknown, path: string): string | undefined {
  const node = nodeAt(root, path);
  return isWireField(node) ? node.value : undefined;
}

/** A copy of `output` with the field at `path` set to `value` by the user:
 *  full confidence, the user's own entry as evidence. `null` when `path` is
 *  not a wire field. */
function withFieldSet(output: unknown, path: string, value: string): unknown | null {
  const copy = JSON.parse(JSON.stringify(output)) as unknown;
  const node = nodeAt(copy, path);
  if (!isWireField(node)) return null;
  node.value = value;
  node.confidence = 1;
  node.evidence = '';
  node.page = 0;
  return copy;
}

function findField(model: PreviewModel, path: string): PreviewField | undefined {
  for (const section of model.sections) {
    const hit = section.fields.find((f) => f.path === path);
    if (hit) return hit;
  }
  for (const row of model.lines?.rows ?? []) {
    const hit = row.fields.find((f) => f.path === path);
    if (hit) return hit;
  }
  return undefined;
}

// ─── Rebuild ────────────────────────────────────────────────────────────────

/**
 * Re-assesses the wire output and rebuilds the preview. `reResolve` reads NPI
 * again (after `set`/`edit`, which change values); `confirm` and `choose`
 * reuse the stored resolution, so they make no NPI call.
 */
/** Re-assesses the stored wire output (every `set`/`edit` already patched it;
 *  `confirm` and `choose` change no value). */
function assessStored(job: IntakeJobRow, extraction: StoredExtraction): { assessed: unknown; values: unknown } {
  const spec = FLOWS[job.flowType] as FlowSpec<unknown, unknown, unknown>;
  const parsed = spec.parse(extraction.output);
  if (!parsed.success) throw new IntakeStateError('state');
  return spec.assess(parsed.data, extraction.flags);
}

async function rebuild(
  deps: EditDeps,
  job: IntakeJobRow,
  state: { extraction: StoredExtraction; choices: Record<string, string>; confirmed: string[]; resolution: FlowResolution | null },
  reResolve: boolean,
  callerNpiUserId: string,
): Promise<StoredPreview> {
  const { assessed, values } = assessStored(job, state.extraction);
  const resolution = reResolve ? (values === null ? null : await resolveFlow(deps.npi, job.flowType, values, { callerNpiUserId })) : state.resolution;
  const { model, fields } = buildPreview({
    flow: job.flowType,
    assessed,
    values,
    resolution,
    choices: state.choices,
    confirmed: state.confirmed,
    hasDocument: job.documentId !== null,
  });
  // A decision whose question no longer exists (or whose answer is no longer
  // an option) is forgotten.
  const choices = Object.fromEntries(
    Object.entries(state.choices).filter(([target, choice]) => model.choices.some((c) => c.target === target && c.options.some((o) => o.id === choice))),
  );
  return { resolution, choices, confirmed: state.confirmed, fields, model };
}

// ─── Operations ─────────────────────────────────────────────────────────────

export async function applyIntakeAction(deps: EditDeps, caller: IntakeCaller, action: IntakeAction): Promise<IntakeView> {
  const now = (deps.now ?? (() => new Date()))();
  const job = await deps.db.intakeJob.findFirst({ where: { id: action.id, npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId } });
  if (job === null) throw new IntakeStateError('not_found');
  if (job.status !== 'preview') throw new IntakeStateError('state');
  const extraction = job.extractedJson as StoredExtraction | null;
  const stored = job.previewJson as StoredPreview | null;
  if (extraction === null || stored === null) throw new IntakeStateError('state');

  const persist = async (data: Parameters<IntakeJobDb['intakeJob']['update']>[0]['data']): Promise<IntakeView> => {
    const updated = await deps.db.intakeJob.update({ where: { id: job.id }, data });
    return toIntakeView(updated, await loadDocumentView(deps, caller, updated));
  };

  switch (action.action) {
    case 'confirm': {
      const field = findField(stored.model, action.path);
      if (field === undefined || !field.confirmable) throw new IntakeStateError('not_confirmable');
      const confirmed = [...new Set([...stored.confirmed, action.path])];
      const next = await rebuild(deps, job, { extraction, choices: stored.choices, confirmed, resolution: stored.resolution }, false, caller.npiUserId);
      return persist({ previewJson: asJson(next) });
    }

    case 'set': {
      if (stored.fields[action.path] === undefined) throw new IntakeStateError('bad_path');
      const output = withFieldSet(extraction.output, action.path, action.value.trim());
      if (output === null) throw new IntakeStateError('bad_path');
      const nextExtraction: StoredExtraction = { ...extraction, output };
      const confirmed = [...new Set([...stored.confirmed, action.path])];
      const next = await rebuild(deps, job, { extraction: nextExtraction, choices: stored.choices, confirmed, resolution: stored.resolution }, true, caller.npiUserId);
      return persist({ extractedJson: asJson(nextExtraction), previewJson: asJson(next) });
    }

    case 'choose': {
      const choice = stored.model.choices.find((c) => c.target === action.target);
      if (choice === undefined || !choice.options.some((o) => o.id === action.choice)) throw new IntakeStateError('bad_choice');
      const choices = { ...stored.choices, [action.target]: action.choice };
      const next = await rebuild(deps, job, { extraction, choices, confirmed: stored.confirmed, resolution: stored.resolution }, false, caller.npiUserId);
      return persist({ previewJson: asJson(next) });
    }

    case 'edit': {
      const pseudonymizer = new Pseudonymizer(await deps.dictionary());
      const result = await runEdit(
        { llm: deps.llm, pseudonymizer },
        {
          flow: job.flowType,
          output: extraction.output,
          text: action.text,
          referenceDate: extraction.flags.referenceDate,
          ligatureSuspect: extraction.flags.ligatureSuspect,
        },
        {
          npiOrgId: caller.npiOrgId,
          npiUserId: caller.npiUserId,
          conversationId: job.conversationId ?? undefined,
          intakeJobId: job.id,
          documentId: job.documentId ?? undefined,
        },
      );
      if (!result.ok) {
        if (result.detail !== null) console.error('[copilot] edit failed', job.flowType, result.reason, result.detail);
        throw new IntakeEditFailed(t(result.messageKey));
      }
      const nextExtraction: StoredExtraction = { ...extraction, output: result.wire, usage: [...extraction.usage, result.usage] };
      // A confirmation vouched for the value that was there; a changed value is no longer vouched for.
      const confirmed = stored.confirmed.filter((path) => wireValueAt(extraction.output, path) === wireValueAt(result.wire, path));
      const next = await rebuild(deps, job, { extraction: nextExtraction, choices: stored.choices, confirmed, resolution: stored.resolution }, true, caller.npiUserId);
      return persist({ extractedJson: asJson(nextExtraction), previewJson: asJson(next) });
    }

    case 'approve': {
      if (!stored.model.canApprove) throw new IntakeStateError('state');
      const { values } = assessStored(job, extraction);
      let plan: ExecutionPlan;
      try {
        plan = buildPlan({ flow: job.flowType, values, resolution: stored.resolution, choices: stored.choices, hasDocument: job.documentId !== null });
      } catch (err) {
        if (err instanceof PlanError) throw new IntakePlanFailed(err.messageAr);
        throw err;
      }
      const log: ExecutionLog = {
        status: 'pending',
        steps: plan.steps.map((s) => ({ n: s.n, labelAr: s.labelAr, state: 'pending' as const })),
      };

      // Conditional on `preview`: a second «اعتمد» finds no row to move (D-T27-7).
      let approved: IntakeJobRow;
      try {
        approved = await deps.db.intakeJob.update({
          where: { id: job.id, status: 'preview' },
          data: { status: 'approved', approvedAt: now, executionLogJson: asJson(log) },
        });
      } catch {
        throw new IntakeStateError('state');
      }

      let executed: IntakeJobRow;
      try {
        executed = await deps.execute(approved, plan);
      } catch (err) {
        if (err instanceof ExecutionClaimError) throw new IntakeStateError('state');
        throw err;
      }
      return toIntakeView(executed, await loadDocumentView(deps, caller, executed));
    }

    case 'cancel':
      return persist({ status: 'cancelled' });
  }
}
