// T-30 (F-13, ADR-18, spec/madar/01 §3 scenario 5): the handover document of a
// position. Three parts, none of which talks to anything but its arguments:
//
//  - `buildHandoverBody` reads what NPI's approval matrix is waiting on from
//    the position's role, the vendors / routines / company facts the firm's
//    memory holds, and the names of the people and the department. Every NPI
//    read is gated by the permission NPI itself requires and degrades to a
//    named reason (`HandoverSkipReason`), never to "nothing is waiting".
//  - `renderHandoverAr` / `handoverGuidanceAr` turn the stored body into the
//    plain text the document page shows and the excerpt the successor's chat
//    carries for seven days.
//  - `writeNarrative` asks the advanced-tier model for a short narrative over
//    the redacted text. It is best effort: a failure is recorded in the body
//    (`narrative.status = 'failed'`) and never fails a reassignment.
//
// Everything except the narrative is deterministic. Arabic text built here is
// stored (`handover_docs.bodyAr`), so numbers and dates go through
// `formatNumber` / `formatDate` and nothing is rendered with `toLocaleString`.
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma';
import { modelJsonSchema, parseModelJson } from '../extract/run';
import { formatDate, formatNumber } from '../i18n/format';
import { LlmError, type LlmContext } from '../llm/client';
import type { ModelResponse, RedactedRequest } from '../llm/provider';
import { readDirectoryUsers, readRoles } from '../npi/admin';
import { readApprovalHistory, readVendorsBrief, waitingOnRole } from '../npi/approvals';
import type { NpiClient } from '../npi/client';
import { readDepartments } from '../npi/directory';
import { NpiError } from '../npi/errors';
import { APPROVAL_DOCUMENT_LABEL_AR } from '../onboarding/plan';
import { staticPrompt, type Pseudonymizer } from '../privacy/pseudonymizer';
import { loadPrompt } from '../prompts/load';
import { normalizeArabic } from '../text/normalize';
import {
  HANDOVER_PERMISSION,
  type HandoverBody,
  type HandoverFact,
  type HandoverNarrative,
  type HandoverSection,
  type HandoverSkipReason,
  type HandoverTask,
  type HandoverVendor,
} from './handover-types';

export type HandoverDb = Pick<PrismaClient, 'position' | 'positionAssignment' | 'memoryFact'>;

export type HandoverNpi = Pick<
  NpiClient,
  'listApprovalHistory' | 'listRoles' | 'listDepartments' | 'listDepartmentDirectory' | 'listVendors'
>;

export interface HandoverCaller {
  npiOrgId: string;
  npiUserId: string;
  permissions: readonly string[];
}

/** D-T30-6 caps. */
const MAX_TASKS = 50;
const MAX_VENDORS = 20;
const MAX_ROUTINES = 30;
const MAX_COMPANY_FACTS = 15;
/** `GET /approvals/history` caps `take` at 200 (approvals.controller.ts:102). */
const HISTORY_TAKE = 200;
/** A safety bound on the vendor-fact read, far above what a firm's memory holds. */
const MAX_VENDOR_FACT_ROWS = 1000;

/** `valueJson.kind` of the company-scope NPI facts a newcomer reads first. */
const COMPANY_FACT_KINDS = ['customer_credit_terms', 'contract_payment_terms', 'active_project'] as const;

const FACT_ORDER = [{ useCount: 'desc' }, { updatedAt: 'desc' }] as const;

// ─── Reads ───────────────────────────────────────────────────────────────────

type Read<T> = { ok: true; value: T } | { ok: false; reason: HandoverSkipReason };

/**
 * One NPI read, gated by the permission NPI requires. A caller without the
 * permission makes no call (`no_permission`); NPI answering 403 is
 * `npi_refused`; any other `NpiError` (including a body the reader rejects) is
 * `npi_error`. A non-`NpiError` is a bug and propagates.
 */
async function guarded<T>(
  caller: HandoverCaller,
  permission: string,
  call: () => Promise<T>,
): Promise<Read<T>> {
  if (!caller.permissions.includes(permission)) return { ok: false, reason: 'no_permission' };
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    return { ok: false, reason: err.kind === 'forbidden' ? 'npi_refused' : 'npi_error' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface FactRow {
  id: string;
  factAr: string;
  npiEntityId: string | null;
  valueJson: unknown;
  sourceType: 'npi' | 'chat';
  useCount: number;
  updatedAt: Date;
}

const FACT_SELECT = {
  id: true,
  factAr: true,
  npiEntityId: true,
  valueJson: true,
  sourceType: true,
  useCount: true,
  updatedAt: true,
} as const;

function byUse(a: { useCount: number; updatedAt: Date }, b: { useCount: number; updatedAt: Date }): number {
  return b.useCount - a.useCount || b.updatedAt.getTime() - a.updatedAt.getTime();
}

function toFact(row: FactRow): HandoverFact {
  return { factId: row.id, factAr: row.factAr, sourceType: row.sourceType };
}

interface VendorGroup {
  npiVendorId: string | null;
  facts: FactRow[];
}

/** Groups the vendor facts by NPI vendor id, a null-keyed fact by its
 *  normalized sentence, and puts each `recurring_item` sentence under its
 *  `valueJson.lastVendorId` (D-T30-6). */
function groupVendorFacts(vendorFacts: FactRow[], recurringItems: FactRow[]): VendorGroup[] {
  const groups = new Map<string, VendorGroup>();
  const add = (key: string, npiVendorId: string | null, row: FactRow): void => {
    const group = groups.get(key) ?? { npiVendorId, facts: [] };
    if (!group.facts.some((f) => f.factAr === row.factAr)) group.facts.push(row);
    groups.set(key, group);
  };
  for (const row of vendorFacts) {
    if (row.npiEntityId !== null && row.npiEntityId.length > 0) add(`id:${row.npiEntityId}`, row.npiEntityId, row);
    else add(`text:${normalizeArabic(row.factAr)}`, null, row);
  }
  for (const row of recurringItems) {
    const last = isRecord(row.valueJson) ? row.valueJson.lastVendorId : undefined;
    if (typeof last === 'string' && last.length > 0) add(`id:${last}`, last, row);
  }
  for (const group of groups.values()) group.facts.sort(byUse);
  return [...groups.values()];
}

/**
 * Builds the document body for a reassignment: everything except the
 * narrative (`narrative.status = 'skipped'`; `writeNarrative` attaches it).
 * The position must belong to the caller's organization — the caller checks
 * first, this is the backstop.
 */
export async function buildHandoverBody(
  deps: { db: HandoverDb; npi: HandoverNpi; now?: () => Date },
  caller: HandoverCaller,
  input: {
    positionId: string;
    successor: { npiUserId: string };
    predecessor: { npiUserId: string; since: Date } | null;
  },
): Promise<HandoverBody> {
  const now = (deps.now ?? (() => new Date()))();
  const { db, npi } = deps;

  const position = await db.position.findFirst({ where: { id: input.positionId, npiOrgId: caller.npiOrgId } });
  if (position === null) throw new Error('position not found');

  // ── memory (the copilot's own database) ──────────────────────────────────
  const visible = [{ scope: 'company' as const }, { scope: 'position' as const, positionId: position.id }];
  // D-17: a fact derived from NPI data is shown only to a caller who holds the
  // permission of its source; a fact without one (routines, chat) needs none.
  const permitted = {
    AND: [{ OR: [{ sourcePermission: null }, { sourcePermission: { in: [...caller.permissions] } }] }],
  };

  const vendorFacts = (await db.memoryFact.findMany({
    where: { npiOrgId: caller.npiOrgId, entityType: 'vendor', OR: visible, ...permitted },
    select: FACT_SELECT,
    orderBy: [...FACT_ORDER],
    take: MAX_VENDOR_FACT_ROWS,
  })) as FactRow[];
  const recurringItems = (await db.memoryFact.findMany({
    where: { npiOrgId: caller.npiOrgId, OR: visible, valueJson: { path: ['kind'], equals: 'recurring_item' }, ...permitted },
    select: FACT_SELECT,
    orderBy: [...FACT_ORDER],
    take: MAX_VENDOR_FACT_ROWS,
  })) as FactRow[];
  const routineRows = (await db.memoryFact.findMany({
    where: { npiOrgId: caller.npiOrgId, scope: 'position', positionId: position.id },
    select: FACT_SELECT,
    orderBy: [...FACT_ORDER],
    take: MAX_ROUTINES,
  })) as FactRow[];
  const companyRows = (await db.memoryFact.findMany({
    where: {
      npiOrgId: caller.npiOrgId,
      scope: 'company',
      OR: COMPANY_FACT_KINDS.map((kind) => ({ valueJson: { path: ['kind'], equals: kind } })),
      ...permitted,
    },
    select: FACT_SELECT,
    orderBy: [...FACT_ORDER],
    take: MAX_COMPANY_FACTS,
  })) as FactRow[];

  const groups = groupVendorFacts(vendorFacts, recurringItems);

  // ── NPI reads, each behind its own permission ────────────────────────────
  const rolesRead = guarded(caller, HANDOVER_PERMISSION.roles, async () => readRoles(await npi.listRoles()));
  const directoryRead = guarded(caller, HANDOVER_PERMISSION.directory, async () =>
    readDirectoryUsers(await npi.listDepartmentDirectory()),
  );
  const departmentsRead: Promise<Read<ReturnType<typeof readDepartments>> | null> =
    position.departmentId === null
      ? Promise.resolve(null)
      : guarded(caller, HANDOVER_PERMISSION.directory, async () => readDepartments(await npi.listDepartments()));
  const vendorsRead: Promise<Read<ReturnType<typeof readVendorsBrief>> | null> = groups.some((g) => g.npiVendorId !== null)
    ? guarded(caller, HANDOVER_PERMISSION.vendors, async () => readVendorsBrief(await npi.listVendors()))
    : Promise.resolve(null);

  const tasksRead = (async (): Promise<HandoverSection<HandoverTask>> => {
    if (!caller.permissions.includes(HANDOVER_PERMISSION.approvals)) return { status: 'skipped', reason: 'no_permission' };
    const roles = await rolesRead;
    if (!roles.ok) return { status: 'skipped', reason: roles.reason };
    const role = roles.value.find((r) => r.key === position.roleKey);
    // A role NPI no longer lists cannot have a chain waiting on it.
    if (role === undefined) return { status: 'read', items: [] };
    const history = await guarded(caller, HANDOVER_PERMISSION.approvals, async () =>
      readApprovalHistory(await npi.listApprovalHistory({ status: 'PENDING', take: HISTORY_TAKE })),
    );
    if (!history.ok) return { status: 'skipped', reason: history.reason };
    const items = waitingOnRole(history.value.rows, role.id)
      .map((row): HandoverTask => {
        const step = row.steps.find((s) => s.sequence === row.currentStep);
        return {
          id: row.id,
          documentType: row.documentType,
          documentCode: row.documentCode,
          amount: row.amount,
          currentStep: row.currentStep,
          stepCount: row.steps.length,
          waitingSince: row.currentStepAt,
          raisedByNameAr: row.raisedBy?.nameAr ?? null,
          escalated: step !== undefined && step.escalatedAt !== null,
        };
      })
      .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince))
      .slice(0, MAX_TASKS);
    return { status: 'read', items };
  })();

  const [roles, directory, departments, vendorsBrief, tasks] = await Promise.all([
    rolesRead,
    directoryRead,
    departmentsRead,
    vendorsRead,
    tasksRead,
  ]);

  const nameOfUser = (npiUserId: string): string | null =>
    directory.ok ? (directory.value.find((u) => u.id === npiUserId)?.nameAr ?? null) : null;

  const vendorById = new Map((vendorsBrief?.ok ? vendorsBrief.value : []).map((v) => [v.id, v]));

  // A chat fact about a vendor carries no NPI id (T-11 stores the sentence
  // only), so it forms a group of its own next to the NPI-named group of the
  // same vendor. Once NPI has named the vendors, a name-less group whose first
  // sentence contains a named vendor's name joins that vendor's group: one
  // vendor, one entry in the document.
  const named = groups.filter((g) => g.npiVendorId !== null && vendorById.has(g.npiVendorId));
  const merged: VendorGroup[] = [];
  for (const group of groups) {
    const first = group.facts[0];
    const host =
      group.npiVendorId === null && first !== undefined
        ? named.find((g) => {
            const name = normalizeArabic(vendorById.get(g.npiVendorId as string)?.nameAr ?? '');
            return name.length > 0 && normalizeArabic(first.factAr).includes(name);
          })
        : undefined;
    if (host === undefined) {
      merged.push(group);
      continue;
    }
    for (const row of group.facts) if (!host.facts.some((f) => f.factAr === row.factAr)) host.facts.push(row);
    host.facts.sort(byUse);
  }

  const vendors: HandoverVendor[] = merged
    .map((group) => {
      const brief = group.npiVendorId === null ? undefined : vendorById.get(group.npiVendorId);
      return {
        npiVendorId: group.npiVendorId,
        nameAr: brief?.nameAr ?? null,
        code: brief?.code ?? null,
        factsAr: group.facts.map((f) => f.factAr),
        totalUse: group.facts.reduce((sum, f) => sum + f.useCount, 0),
      };
    })
    .sort(
      (a, b) =>
        b.totalUse - a.totalUse || (a.nameAr ?? a.factsAr[0] ?? '').localeCompare(b.nameAr ?? b.factsAr[0] ?? '', 'ar'),
    )
    .slice(0, MAX_VENDORS)
    .map(({ totalUse: _totalUse, ...vendor }) => vendor);

  const departmentNameAr =
    departments?.ok && position.departmentId !== null
      ? (departments.value.find((d) => d.id === position.departmentId)?.nameAr ?? null)
      : null;

  return {
    version: 1,
    generatedAt: now.toISOString(),
    position: {
      id: position.id,
      roleKey: position.roleKey,
      roleNameAr: roles.ok ? (roles.value.find((r) => r.key === position.roleKey)?.nameAr ?? null) : null,
      departmentId: position.departmentId,
      departmentNameAr,
      titleAr: position.titleAr,
    },
    predecessor:
      input.predecessor === null
        ? null
        : {
            npiUserId: input.predecessor.npiUserId,
            nameAr: nameOfUser(input.predecessor.npiUserId),
            since: input.predecessor.since.toISOString(),
          },
    successor: { npiUserId: input.successor.npiUserId, nameAr: nameOfUser(input.successor.npiUserId) },
    tasks,
    vendors,
    routines: routineRows.sort(byUse).map(toFact),
    companyFacts: companyRows.sort(byUse).map(toFact),
    narrative: { status: 'skipped' },
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const SKIP_REASON_AR: Record<HandoverSkipReason, string> = {
  no_permission: 'لا تملك صلاحية قراءة سجل الاعتمادات',
  npi_refused: 'رفض NPI القراءة',
  npi_error: 'تعذر الوصول إلى NPI',
};

const UNKNOWN_NAME_AR = 'غير معروف';

/** One line: every run of whitespace (including a stored newline) becomes one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function documentLabelAr(documentType: string): string {
  return Object.prototype.hasOwnProperty.call(APPROVAL_DOCUMENT_LABEL_AR, documentType)
    ? APPROVAL_DOCUMENT_LABEL_AR[documentType as keyof typeof APPROVAL_DOCUMENT_LABEL_AR]
    : documentType;
}

function taskLineAr(task: HandoverTask): string {
  const parts = [
    `- ${documentLabelAr(task.documentType)} ${task.documentCode} بمبلغ ${formatNumber(task.amount)} ريال`,
    `الخطوة ${formatNumber(task.currentStep)} من ${formatNumber(task.stepCount)}`,
    `بانتظار منذ ${formatDate(task.waitingSince)}`,
  ];
  if (task.escalated) parts.push('متأخرة');
  if (task.raisedByNameAr !== null && oneLine(task.raisedByNameAr).length > 0) {
    parts.push(`رفعها ${oneLine(task.raisedByNameAr)}`);
  }
  return parts.join('، ');
}

function tasksLinesAr(tasks: HandoverSection<HandoverTask>): string[] {
  if (tasks.status === 'skipped') return [`تعذر قراءة المهام من NPI: ${SKIP_REASON_AR[tasks.reason]}`];
  if (tasks.items.length === 0) return ['لا مهام مفتوحة بانتظار هذا المنصب في NPI.'];
  return tasks.items.map(taskLineAr);
}

function vendorLinesAr(vendors: HandoverVendor[]): string[] {
  if (vendors.length === 0) return ['لا موردون مسجّلون في الذاكرة لهذا المنصب.'];
  const lines: string[] = [];
  for (const vendor of vendors) {
    // A vendor NPI could not name is headed by its first sentence, which is
    // then not repeated underneath.
    const named = vendor.nameAr !== null;
    const name = oneLine(vendor.nameAr ?? vendor.factsAr[0] ?? '');
    lines.push(`- ${name}${vendor.code !== null ? ` (${vendor.code})` : ''}`);
    for (const fact of named ? vendor.factsAr : vendor.factsAr.slice(1)) lines.push(`  · ${oneLine(fact)}`);
  }
  return lines;
}

/**
 * The plain-text document: header, then the sections «المهام المفتوحة في NPI»,
 * «الموردون المتعامل معهم», «الإجراءات المعتادة», «حقائق عن الشركة» (omitted when
 * empty) and «ملخص الاستلام» (only once the narrative is written), separated
 * by one blank line, ending with a newline.
 */
export function renderHandoverAr(body: HandoverBody): string {
  const header = [`دليل استلام المنصب: ${oneLine(body.position.titleAr)}`];
  if (body.predecessor !== null) {
    header.push(
      `من: ${oneLine(body.predecessor.nameAr ?? UNKNOWN_NAME_AR)} (منذ ${formatDate(body.predecessor.since)})`,
    );
  }
  header.push(`إلى: ${oneLine(body.successor.nameAr ?? UNKNOWN_NAME_AR)}`);
  header.push(`أُنشئ في ${formatDate(body.generatedAt)}`);

  const sections: string[][] = [header];
  sections.push(['المهام المفتوحة في NPI', ...tasksLinesAr(body.tasks)]);
  sections.push(['الموردون المتعامل معهم', ...vendorLinesAr(body.vendors)]);
  sections.push([
    'الإجراءات المعتادة',
    ...(body.routines.length === 0
      ? ['لا إجراءات مسجّلة في ذاكرة المنصب بعد.']
      : body.routines.map((fact) => `- ${oneLine(fact.factAr)}`)),
  ]);
  if (body.companyFacts.length > 0) {
    sections.push(['حقائق عن الشركة', ...body.companyFacts.map((fact) => `- ${oneLine(fact.factAr)}`)]);
  }
  if (body.narrative.status === 'written') {
    const narrative = ['ملخص الاستلام', oneLine(body.narrative.summaryAr)];
    if (body.narrative.firstWeekAr.length > 0) {
      narrative.push('الأسبوع الأول:', ...body.narrative.firstWeekAr.map((line) => `- ${oneLine(line)}`));
    }
    if (body.narrative.cautionsAr.length > 0) {
      narrative.push('تنبيهات:', ...body.narrative.cautionsAr.map((line) => `- ${oneLine(line)}`));
    }
    sections.push(narrative);
  }
  return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

// ─── Chat guidance (seven days) ──────────────────────────────────────────────

/** Characters the excerpt may take, closing line included (D: «≤ 1,500»). */
const GUIDANCE_MAX_CHARS = 1500;
const GUIDANCE_MAX_VENDORS = 10;
const GUIDANCE_CLOSING = 'دليل الاستلام الكامل في صفحة «دليل الاستلام».';

/**
 * The excerpt the successor's chat carries for seven days: who took over what
 * and when, the written summary and first-week lines, how many NPI tasks are
 * open, the vendors, and always a closing pointer to the full document.
 * Truncated at a line boundary with «…» when it would exceed 1,500 characters;
 * the first line and the closing line are always kept.
 */
export function handoverGuidanceAr(body: HandoverBody): string {
  const predecessor = body.predecessor?.nameAr ? ` خلفاً لـ ${oneLine(body.predecessor.nameAr)}` : '';
  const intro = `استلم هذا الموظف منصب ${oneLine(body.position.titleAr)} في ${formatDate(body.generatedAt)}${predecessor}.`;

  const lines: string[] = [];
  if (body.narrative.status === 'written') {
    lines.push(oneLine(body.narrative.summaryAr));
    if (body.narrative.firstWeekAr.length > 0) {
      lines.push('الأسبوع الأول:', ...body.narrative.firstWeekAr.map((line) => `- ${oneLine(line)}`));
    }
  }
  lines.push(
    body.tasks.status === 'read'
      ? `المهام المفتوحة في NPI: ${formatNumber(body.tasks.items.length)}`
      : `المهام المفتوحة في NPI: ${SKIP_REASON_AR[body.tasks.reason]}`,
  );
  const vendorNames = body.vendors
    .map((vendor) => vendor.nameAr ?? vendor.code)
    .filter((name): name is string => name !== null && name.length > 0)
    .slice(0, GUIDANCE_MAX_VENDORS)
    .map(oneLine);
  if (vendorNames.length > 0) lines.push(`الموردون: ${vendorNames.join('، ')}`);

  const tail = `\n${GUIDANCE_CLOSING}`;
  const kept: string[] = [intro.length + tail.length <= GUIDANCE_MAX_CHARS ? intro : intro.slice(0, GUIDANCE_MAX_CHARS - tail.length - 1)];
  let used = kept[0].length + tail.length;
  let truncated = false;
  for (const line of lines) {
    // Room for the line, its separator and a possible «…» line.
    if (used + 1 + line.length + 2 > GUIDANCE_MAX_CHARS) {
      truncated = true;
      break;
    }
    kept.push(line);
    used += 1 + line.length;
  }
  if (truncated) kept.push('…');
  return `${kept.join('\n')}${tail}`;
}

// ─── Narrative ───────────────────────────────────────────────────────────────

export const HandoverNarrativeSchema = z.object({
  summaryAr: z.string(),
  firstWeekAr: z.array(z.string()),
  cautionsAr: z.array(z.string()),
});

/** Latin text a stored Arabic sentence may carry: document and item codes
 *  (`PR-00025`, `MOD-550`, `CAB-LV6`) and the word NPI, which the section
 *  headings themselves use. */
const ALLOWED_LATIN = /\b(?:[A-Z]{2,4}-[A-Z0-9]{2,6}|NPI)\b/g;

/** True when `text` has a Latin letter outside an allowed code (D-T30-7). */
export function hasStrayLatin(text: string): boolean {
  return /[A-Za-z]/.test(text.replace(ALLOWED_LATIN, ''));
}

const MAX_FIRST_WEEK_LINES = 7;
const MAX_CAUTION_LINES = 4;
const NARRATIVE_MAX_TOKENS = 2000;

export interface NarrativeDeps {
  llm: { complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> };
  pseudonymizer: Pseudonymizer;
  now?: () => Date;
}

/**
 * One advanced-tier call over the redacted document. Names leave only through
 * `pseudonymizer.redact` and come back through `rehydrate` after the call. An
 * `LlmError` is `failed` with its kind; unparseable output is `bad_output`; a
 * refusal stop is `refused`; a summary that is empty once the lines with stray
 * Latin letters are dropped is `latin_text`. A non-`LlmError` propagates.
 */
export async function writeNarrative(deps: NarrativeDeps, ctx: LlmContext, body: HandoverBody): Promise<HandoverNarrative> {
  const now = deps.now ?? (() => new Date());
  const failed = (reason: string): HandoverNarrative => ({ status: 'failed', reason, failedAt: now().toISOString() });

  const request: RedactedRequest = {
    tier: 'advanced',
    purpose: 'handover_narrative',
    system: staticPrompt(loadPrompt('handover.md')),
    messages: [
      {
        role: 'user',
        content: deps.pseudonymizer.redact(renderHandoverAr({ ...body, narrative: { status: 'skipped' } })),
      },
    ],
    jsonSchema: modelJsonSchema(HandoverNarrativeSchema),
    maxTokens: NARRATIVE_MAX_TOKENS,
  };

  let response: ModelResponse;
  try {
    response = await deps.llm.complete(request, ctx);
  } catch (err) {
    if (err instanceof LlmError) return failed(err.kind);
    throw err;
  }
  if (response.stopReason === 'refusal') return failed('refused');

  const raw = parseModelJson(response.text);
  const parsed = HandoverNarrativeSchema.safeParse(raw);
  if (!parsed.success) return failed('bad_output');

  // Originals back in place of the placeholders, after the audit row exists.
  const clean = (line: string): string => oneLine(deps.pseudonymizer.rehydrate(line));
  const lines = (values: string[]): string[] => values.map(clean).filter((line) => line.length > 0);
  const keepArabic = (values: string[]): string[] => values.filter((line) => !hasStrayLatin(line));

  const summaryBefore = clean(parsed.data.summaryAr);
  const summaryAr = hasStrayLatin(summaryBefore) ? '' : summaryBefore;
  if (summaryAr.length === 0) return failed(summaryBefore.length > 0 ? 'latin_text' : 'bad_output');

  return {
    status: 'written',
    summaryAr,
    firstWeekAr: keepArabic(lines(parsed.data.firstWeekAr)).slice(0, MAX_FIRST_WEEK_LINES),
    cautionsAr: keepArabic(lines(parsed.data.cautionsAr)).slice(0, MAX_CAUTION_LINES),
    modelId: response.modelId,
    writtenAt: now().toISOString(),
  };
}
