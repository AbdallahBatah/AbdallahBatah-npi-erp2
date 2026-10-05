// Intake jobs (T-26, D-T26-1..3): the unit of preview and execution.
//
// `startIntake` turns what a user sent (a sentence, a stored document, or both)
// into a job: it reads the document under the T-22 rules (a text PDF as
// redacted page text; a photo or a scan only through a verified consent), runs
// the flow's extraction synchronously, resolves the names against NPI, builds
// the preview and stores everything on the `intake_jobs` row. Nothing is
// written to NPI here, and the model is never reached except through
// `runExtraction` (hence through the pseudonymizer and the audited client).
import type { FlowType } from '../agents/router';
import type { Prisma } from '../generated/prisma';
import { repairPdfTextWithFlags, runExtraction, todayIso, type ExtractDeps, type ExtractSource, type SourceFlags } from '../extract/run';
import { t } from '../i18n/ar';
import type { RedactedBlock } from '../llm/provider';
import { documentVisionBlocks, VisionInputError } from '../llm/vision';
import { Pseudonymizer, type DictionaryEntry } from '../privacy/pseudonymizer';
import { ConsentRequiredError, requireConsent, type ConsentDb } from './consent';
import { buildPreview } from './preview';
import { resolveFlow, type ResolutionNpi } from './resolution';
import type {
  ExecutionLog,
  IntakeDocumentView,
  IntakeStatus,
  IntakeView,
  StoredExtraction,
  StoredPreview,
} from './types';
import { summarizeDocument, textSidecarPath, type DocumentRow, type DocumentStorage } from './upload';

export interface IntakeJobRow {
  id: string;
  npiOrgId: string;
  npiUserId: string;
  documentId: string | null;
  conversationId: string | null;
  flowType: FlowType;
  status: IntakeStatus;
  extractedJson: unknown;
  previewJson: unknown;
  executionLogJson: unknown;
  error: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** JSON columns accept plain JSON only; the stored shapes (`StoredExtraction`,
 *  `StoredPreview`, `ExecutionLog`) are JSON by construction. */
export function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export interface IntakeJobData {
  status?: IntakeStatus;
  extractedJson?: Prisma.InputJsonValue;
  previewJson?: Prisma.InputJsonValue;
  executionLogJson?: Prisma.InputJsonValue;
  /** The `CreatedEntity[]` the execution made, in creation order (T-27). */
  npiEntityRefs?: Prisma.InputJsonValue;
  error?: string | null;
  approvedAt?: Date | null;
}

/**
 * The part of the Prisma client this module and `edit.ts` call, typed
 * structurally (the real client satisfies it without a cast; a small
 * in-memory fake does too). Everything is looked up by owner as well as id:
 * another user's job does not exist as far as this user is concerned.
 */
export interface IntakeJobDb {
  intakeJob: {
    create(args: {
      data: { npiOrgId: string; npiUserId: string; documentId: string | null; conversationId: string | null; flowType: FlowType; status: IntakeStatus };
    }): Promise<IntakeJobRow>;
    findFirst(args: { where: { id: string; npiOrgId: string; npiUserId: string } }): Promise<IntakeJobRow | null>;
    /** With `status` in `where` the update is conditional: it rejects when no
     *  row matches (Prisma P2025), which is how a double «اعتمد» is stopped
     *  without a transaction (D-T27-7). */
    update(args: { where: { id: string; status?: IntakeStatus }; data: IntakeJobData }): Promise<IntakeJobRow>;
  };
  document: {
    findFirst(args: { where: { id: string; npiOrgId: string; npiUserId: string } }): Promise<DocumentRow | null>;
  };
  consentEvent: {
    findUnique: ConsentDb['consentEvent']['findUnique'];
  };
}

export interface IntakeCaller {
  npiOrgId: string;
  npiUserId: string;
}

export interface StartIntakeDeps {
  db: IntakeJobDb;
  llm: ExtractDeps['llm'];
  npi: ResolutionNpi;
  storage: DocumentStorage;
  dictionary(): Promise<DictionaryEntry[]>;
  now?: () => Date;
}

export interface StartIntakeInput {
  flow: FlowType;
  /** What the user typed: the whole sentence, or a note sent with a document. */
  text: string | null;
  documentId: string | null;
  conversationId: string;
  /** The firm's own name, so the model does not take it for the customer. */
  ourPartyNameAr: string | null;
}

export type StartIntakeOutcome =
  | { ok: true; jobId: string; status: 'preview' | 'failed'; failureAr: string | null }
  | { ok: false; reason: 'document_not_found' | 'consent_required'; messageAr: string };

type PreparedSource =
  | { ok: true; source: ExtractSource; pages: number; ligatureSuspect: boolean }
  | { ok: false; reason: 'consent_required' }
  | { ok: false; reason: 'unreadable' };

async function readTextPages(storage: DocumentStorage, row: DocumentRow): Promise<{ num: number; text: string }[] | null> {
  const bytes = await storage.read(textSidecarPath(row.storagePath));
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { pages?: unknown };
    if (!Array.isArray(parsed.pages)) return null;
    return parsed.pages.flatMap((p): { num: number; text: string }[] =>
      typeof p === 'object' && p !== null && typeof (p as { num?: unknown }).num === 'number' && typeof (p as { text?: unknown }).text === 'string'
        ? [{ num: (p as { num: number }).num, text: (p as { text: string }).text }]
        : [],
    );
  } catch {
    return null;
  }
}

/** A text PDF goes as page text; a photo or a scan only under a verified
 *  consent (ADR-27). Nothing is created or sent when consent is missing. */
async function prepareSource(deps: StartIntakeDeps, caller: IntakeCaller, row: DocumentRow | null): Promise<PreparedSource> {
  if (row === null) return { ok: true, source: { kind: 'text', pages: [] }, pages: 0, ligatureSuspect: false };

  if (row.kind === 'pdf_text') {
    const pages = await readTextPages(deps.storage, row);
    if (pages === null) return { ok: false, reason: 'unreadable' };
    const ligatureSuspect = pages.some((p) => repairPdfTextWithFlags(p.text).flags.ligatureSuspect);
    return { ok: true, source: { kind: 'text', pages }, pages: pages.length, ligatureSuspect };
  }

  let blocks: RedactedBlock[];
  try {
    // `requireConsent` only reads `document.findFirst` and `consentEvent.findUnique`.
    const consent = await requireConsent(deps.db as unknown as ConsentDb, caller, row.id);
    blocks = await documentVisionBlocks(consent, deps.storage, row);
  } catch (err) {
    if (err instanceof ConsentRequiredError) return { ok: false, reason: 'consent_required' };
    if (err instanceof VisionInputError) return { ok: false, reason: 'unreadable' };
    throw err;
  }
  const pages = blocks.filter((b) => b.type === 'image' || b.type === 'document').length;
  return { ok: true, source: { kind: 'vision', blocks }, pages, ligatureSuspect: false };
}

/**
 * Creates the job and runs the extraction. Returns `ok: false` (and creates no
 * job, makes no model call) when the document is not the caller's or needs a
 * consent it does not have. Otherwise the job ends `preview` or `failed`.
 * A defect (anything but a modelled failure) marks the job `failed` and is
 * rethrown, so no job is left `extracting`.
 */
export async function startIntake(deps: StartIntakeDeps, caller: IntakeCaller, input: StartIntakeInput): Promise<StartIntakeOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  let row: DocumentRow | null = null;
  if (input.documentId !== null) {
    row = await deps.db.document.findFirst({ where: { id: input.documentId, npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId } });
    if (row === null) return { ok: false, reason: 'document_not_found', messageAr: t('document.error.not_found') };
  }

  const prepared = await prepareSource(deps, caller, row);
  if (!prepared.ok && prepared.reason === 'consent_required') {
    return { ok: false, reason: 'consent_required', messageAr: t('intake.consent_required') };
  }

  // The job exists before the model is called, so `llm_audit` rows carry its id.
  const job = await deps.db.intakeJob.create({
    data: {
      npiOrgId: caller.npiOrgId,
      npiUserId: caller.npiUserId,
      documentId: row?.id ?? null,
      conversationId: input.conversationId,
      flowType: input.flow,
      status: 'extracting',
    },
  });

  const fail = async (error: string): Promise<StartIntakeOutcome> => {
    await deps.db.intakeJob.update({ where: { id: job.id }, data: { status: 'failed', error } });
    return { ok: true, jobId: job.id, status: 'failed', failureAr: error };
  };

  if (!prepared.ok) return fail(t('document.error.unreadable'));

  try {
    const pseudonymizer = new Pseudonymizer(await deps.dictionary());
    const referenceDate = todayIso(now);
    const hint = input.text?.trim() ? input.text.trim() : null;
    const result = await runExtraction(
      { llm: deps.llm, pseudonymizer },
      {
        flow: input.flow,
        source: prepared.source,
        userHint: hint ?? undefined,
        ourPartyNameAr: input.ourPartyNameAr ?? undefined,
        referenceDate,
      },
      { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId, conversationId: input.conversationId, intakeJobId: job.id, documentId: row?.id },
    );

    if (!result.ok) {
      if (result.detail !== null) console.error('[copilot] extraction failed', input.flow, result.reason, result.detail);
      return await fail(t(result.messageKey));
    }

    const flags: SourceFlags = { ligatureSuspect: prepared.ligatureSuspect, referenceDate };
    const extraction: StoredExtraction = {
      output: result.wire,
      flags,
      userHint: hint,
      source: { kind: prepared.source.kind, pages: prepared.pages },
      usage: [result.usage],
    };
    const resolution = result.values === null ? null : await resolveFlow(deps.npi, input.flow, result.values);
    const { model, fields } = buildPreview({
      flow: input.flow,
      assessed: result.assessed,
      values: result.values,
      resolution,
      choices: {},
      confirmed: [],
      hasDocument: row !== null,
    });
    const preview: StoredPreview = { resolution, choices: {}, confirmed: [], fields, model };
    await deps.db.intakeJob.update({
      where: { id: job.id },
      data: { status: 'preview', extractedJson: asJson(extraction), previewJson: asJson(preview), error: null },
    });
    return { ok: true, jobId: job.id, status: 'preview', failureAr: null };
  } catch (err) {
    await deps.db.intakeJob
      .update({ where: { id: job.id }, data: { status: 'failed', error: t('state.error') } })
      .catch(() => undefined);
    throw err;
  }
}

// ─── The view the browser receives ──────────────────────────────────────────

/** The attached document as the card shows it. The page count comes from the
 *  stored meta sidecar when `storage` is given, else from the page count the
 *  extraction recorded, else a photo is one page. */
export async function loadDocumentView(
  deps: { db: Pick<IntakeJobDb, 'document'>; storage?: DocumentStorage },
  caller: IntakeCaller,
  job: IntakeJobRow,
): Promise<IntakeDocumentView | null> {
  if (job.documentId === null) return null;
  const row = await deps.db.document.findFirst({ where: { id: job.documentId, npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId } });
  if (row === null) return null;
  let pageCount: number;
  if (deps.storage) {
    pageCount = (await summarizeDocument(deps.storage, row)).pageCount;
  } else {
    const recorded = (job.extractedJson as StoredExtraction | null)?.source?.pages;
    pageCount = typeof recorded === 'number' ? recorded : row.kind === 'image' ? 1 : 0;
  }
  return { id: row.id, fileName: row.fileName, kind: row.kind, pageCount };
}

export function toIntakeView(job: IntakeJobRow, document: IntakeDocumentView | null): IntakeView {
  const stored = job.previewJson as StoredPreview | null;
  return {
    id: job.id,
    flow: job.flowType,
    flowLabelAr: t(`flow.${job.flowType}` as const),
    status: job.status,
    conversationId: job.conversationId,
    document,
    preview: stored?.model ?? null,
    failureAr: job.error,
    execution: (job.executionLogJson as ExecutionLog | null) ?? null,
    createdAt: job.createdAt.toISOString(),
    approvedAt: job.approvedAt ? job.approvedAt.toISOString() : null,
  };
}

export async function getIntakeView(
  deps: { db: IntakeJobDb; storage?: DocumentStorage },
  caller: IntakeCaller,
  id: string,
): Promise<IntakeView | null> {
  const job = await deps.db.intakeJob.findFirst({ where: { id, npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId } });
  if (job === null) return null;
  return toIntakeView(job, await loadDocumentView(deps, caller, job));
}
