// Fixtures for e2e/handover.spec.ts (T-30, F-13, BR-07): a second project
// manager in the e2e NPI, a pm position with its holder, a predecessor chat,
// position and vendor memory, a requisition waiting on the `pm` role, and one
// handover document written by the server's own `reassignPosition`.
//
// Same discipline as `no-bypass.ts`: NPI is reached only over HTTP, with the
// user's own token; the copilot's own Prisma client is used for copilot rows
// (never NPI's database, 08 §E.10); the only stand-in is the narrative model,
// scripted so the spec never calls a real one (the `@live-handover` test is
// the one place that does).
//
// The one direct call to NPI's user-creation endpoint in the whole project
// lives in `ensureSecondPm` below: it runs in the test process, as the seeded
// administrator, against the e2e NPI — never through `src/npi/client.ts`
// (tests/invariants.spec.ts invariant 5).
import '../../tests/helpers/load-env';
import type { APIRequestContext } from '@playwright/test';
import { PrismaClient } from '../../src/generated/prisma';
import { saveFact } from '../../src/memory/store';
import { createNpiClient } from '../../src/npi/client';
import { readItems, readRoles } from '../../src/npi/admin';
import { readEntityRef, readMe } from '../../src/npi/responses';
import { Pseudonymizer } from '../../src/privacy/pseudonymizer';
import { reassignPosition } from '../../src/positions/reassign';
import { readAdminCredentials, readSeededAccount, readSiteEngineerCredentials, type SeededAccount } from './accounts';
import { API_BASE, isoDaysFromToday, npiInbox, npiRequisition, scriptedLlm } from './no-bypass';
import { npiGet, npiLogin } from './scratch-orgs';

// ─── The copilot's own database ─────────────────────────────────────────────

let client: PrismaClient | undefined;
function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

/** Closes the fixture's own Prisma connection — call from `afterAll`. A later
 *  fixture call opens a new one. */
export async function disconnectHandoverDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

// ─── Test data (the only Arabic in the e2e besides what `t()` renders) ──────

export const E2E_PM2_EMAIL = 'pm2@npi.sa';
/** Test data for the e2e NPI's own database, not a seeded secret; never printed. */
const E2E_PM2_PASSWORD = 'Pm2-handover-e2e-2026';
const E2E_PM2_NAME_AR = 'مدير المشاريع الثاني';
const E2E_PM2_NAME_EN = 'Second Projects Manager';

export const PREDECESSOR_CHAT = {
  titleAr: 'تسليم الموقع الشمالي',
  userText: 'وش حالة طلبات الشراء المعلقة؟',
  assistantText: 'لا طلبات معلقة الآن.',
} as const;

/** The two company vendor facts: `nameAr` is the part of each sentence that
 *  names the vendor (the handover shows the first fact's text for a vendor
 *  NPI does not list). */
export const VENDOR_FACTS = [
  { nameAr: 'شركة الخليج للألواح الشمسية', factAr: 'المورد شركة الخليج للألواح الشمسية يسلّم خلال 10 أيام من الاعتماد.' },
  { nameAr: 'مصنع النور للكابلات', factAr: 'المورد مصنع النور للكابلات يشترط دفعة مقدمة 50%.' },
] as const;

export const ROUTINE_FACT_AR = 'يُراجع مدير المشاريع طلبات الشراء المعلقة كل يوم أحد.';

/** The narrative the scripted model "writes". */
export const SCRIPTED_NARRATIVE = {
  summaryAr: 'يتولى هذا المنصب متابعة طلبات الشراء المعلقة والتنسيق مع الموردين.',
  firstWeekAr: ['راجع الطلبات المعلقة في صندوق NPI', 'تعرّف على الموردين المسجّلين'],
  cautionsAr: ['الاعتماد والرفض في صندوق وارد NPI فقط'],
} as const;

const REQUISITION_JUSTIFICATION = 'ألواح للموقع الشمالي — اختبار دليل الاستلام';

// ─── NPI wire helpers (fail loudly, naming what changed) ────────────────────

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shape(what: string, body: unknown): never {
  throw new Error(`NPI response shape changed: ${what} (got ${JSON.stringify(body).slice(0, 300)})`);
}

function rec(value: unknown, what: string): Rec {
  return isRecord(value) ? value : shape(what, value);
}

function arr(value: unknown, what: string): unknown[] {
  return Array.isArray(value) ? value : shape(what, value);
}

// ─── ensureSecondPm ─────────────────────────────────────────────────────────

/**
 * A second user with the `pm` role in the e2e NPI (`pm2@npi.sa`), created once
 * as the seeded administrator and reused by every later run.
 *
 * Wire shapes:
 *  - `GET /admin/departments/directory` is `DepartmentsService.directory()`: a
 *    bare array of `DIRECTORY_SELECT` rows (`id`, `nameAr`, `nameEn`, `email`,
 *    `isActive`, `departmentId`, `role { id, key, nameAr, nameEn }`;
 *    apps/api/src/modules/admin/departments.service.ts:12-20);
 *  - `GET /admin/roles` carries each role's `id` and `key` (read through the
 *    application's own `readRoles`);
 *  - `POST /admin/users` takes `CreateUserDto { email, password (>= 8), nameAr,
 *    nameEn?, roleId, locale? }` (apps/api/src/modules/admin/dto.ts).
 */
export async function ensureSecondPm(request: APIRequestContext): Promise<SeededAccount> {
  const admin = await npiLogin(request, readAdminCredentials());
  const account: SeededAccount = { email: E2E_PM2_EMAIL, password: E2E_PM2_PASSWORD, nameAr: E2E_PM2_NAME_AR };

  const directory = arr(await npiGet(request, admin.token, '/admin/departments/directory'), 'directory');
  const existing = directory
    .map((row) => rec(row, 'directory row'))
    .find((row) => typeof row.email === 'string' && row.email.toLowerCase() === E2E_PM2_EMAIL);

  if (existing === undefined) {
    const roles = readRoles(await npiGet(request, admin.token, '/admin/roles'));
    const pmRole = roles.find((role) => role.key === 'pm');
    if (pmRole === undefined) throw new Error("ensureSecondPm: NPI has no role with key 'pm'");

    const res = await request.post(`${API_BASE}/admin/users`, {
      headers: { Authorization: `Bearer ${admin.token}` },
      data: {
        email: E2E_PM2_EMAIL,
        password: E2E_PM2_PASSWORD,
        nameAr: E2E_PM2_NAME_AR,
        nameEn: E2E_PM2_NAME_EN,
        roleId: pmRole.id,
      },
    });
    if (!res.ok()) throw new Error(`ensureSecondPm: NPI refused to create ${E2E_PM2_EMAIL}: HTTP ${res.status()}`);
  } else {
    const role = rec(existing.role, 'directory row role');
    if (role.key !== 'pm') throw new Error(`ensureSecondPm: ${E2E_PM2_EMAIL} exists with role "${String(role.key)}", expected "pm"`);
    if (existing.isActive !== true) throw new Error(`ensureSecondPm: ${E2E_PM2_EMAIL} exists but is not active`);
  }

  // Proves the credentials work (an existing user with another password fails here, naming the user).
  await npiLogin(request, account);
  return account;
}

// ─── resetPmPosition ────────────────────────────────────────────────────────

export type AccountWithId = SeededAccount & { userId: string };

export interface PmPositionState {
  orgId: string;
  positionId: string;
  positionTitleAr: string;
  /** pm1 is the one open holder of the position. */
  pm1: AccountWithId & { since: Date };
  /** pm2 holds nothing: a candidate. */
  pm2: AccountWithId;
}

/**
 * Puts the copilot's `pm` position in the state the handover starts from: pm1
 * (the seeded project manager) is its one open holder, pm2 holds no position
 * of the organization.
 *
 * With no `positionId`, pm1 signs in to the copilot through `POST
 * /copilot/api/auth` (so the real `resolvePosition` creates the position and
 * pm1's assignment on a fresh database) and the position is the `pm` position
 * pm1's open assignment points at, else the department-less one. With a
 * `positionId` (a later call in the same run) that position is kept and pm1's
 * assignment is re-opened on it if a reassignment ended it. `request` must
 * have the copilot as its `baseURL` (the Playwright `request` fixture does).
 *
 * Every other user's open assignment on the chosen position is ended too, so
 * that "the predecessor" of the next reassignment is pm1 and nobody else.
 */
export async function resetPmPosition(request: APIRequestContext, options: { positionId?: string } = {}): Promise<PmPositionState> {
  const pm1Account = readSeededAccount('pm');
  const pm2Account = await ensureSecondPm(request);
  const pm1Session = await npiLogin(request, pm1Account);
  const pm2Session = await npiLogin(request, pm2Account);
  const orgId = pm1Session.orgId;
  const db = getClient();

  let positionId = options.positionId;
  if (positionId === undefined) {
    const res = await request.post('/copilot/api/auth', { data: { email: pm1Account.email, password: pm1Account.password } });
    if (!res.ok()) throw new Error(`resetPmPosition: copilot login failed for ${pm1Account.email}: HTTP ${res.status()}`);

    const positions = await db.position.findMany({
      where: { npiOrgId: orgId, roleKey: 'pm' },
      include: { assignments: { where: { endedAt: null, npiUserId: pm1Session.userId }, select: { id: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const chosen =
      positions.find((p) => p.assignments.length > 0) ?? positions.find((p) => p.departmentId === null) ?? positions[0];
    if (chosen === undefined) throw new Error('resetPmPosition: the copilot login created no pm position');
    positionId = chosen.id;
  }

  const position = await db.position.findFirst({ where: { id: positionId, npiOrgId: orgId }, select: { id: true, titleAr: true } });
  if (position === null) throw new Error(`resetPmPosition: position ${positionId} is not in organization ${orgId}`);

  const now = new Date();
  // pm2 holds nothing, anywhere in the organization.
  await db.positionAssignment.updateMany({
    where: { npiUserId: pm2Session.userId, endedAt: null, position: { npiOrgId: orgId } },
    data: { endedAt: now },
  });
  // Nobody but pm1 holds this position.
  await db.positionAssignment.updateMany({
    where: { positionId: position.id, endedAt: null, npiUserId: { not: pm1Session.userId } },
    data: { endedAt: now },
  });
  // pm1 holds it exactly once.
  const open = await db.positionAssignment.findMany({
    where: { positionId: position.id, npiUserId: pm1Session.userId, endedAt: null },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, startedAt: true },
  });
  let since: Date;
  if (open.length === 0) {
    const created = await db.positionAssignment.create({
      data: { positionId: position.id, npiUserId: pm1Session.userId },
      select: { startedAt: true },
    });
    since = created.startedAt;
  } else {
    since = open[0].startedAt;
    const extra = open.slice(1).map((a) => a.id);
    if (extra.length > 0) await db.positionAssignment.updateMany({ where: { id: { in: extra } }, data: { endedAt: now } });
  }

  return {
    orgId,
    positionId: position.id,
    positionTitleAr: position.titleAr,
    pm1: { ...pm1Account, userId: pm1Session.userId, since },
    pm2: { ...pm2Account, userId: pm2Session.userId },
  };
}

// ─── Copilot-side seeds ─────────────────────────────────────────────────────

export interface SeededChat {
  conversationId: string;
  /** The conversation's `updatedAt`, as the document page shows it. */
  updatedAt: Date;
}

/**
 * pm1's conversation in the position: two messages. Idempotent — a repeat run
 * finds the conversation of the same title and keeps it (a second one would
 * make the document list two rows with the same title).
 */
export async function seedPredecessorChat(orgId: string, pm1UserId: string, positionId: string): Promise<SeededChat> {
  const db = getClient();
  const existing = await db.conversation.findFirst({
    where: { npiOrgId: orgId, npiUserId: pm1UserId, positionId, titleAr: PREDECESSOR_CHAT.titleAr },
    select: { id: true, _count: { select: { messages: true } } },
  });

  let conversationId: string;
  if (existing !== null && existing._count.messages === 2) {
    conversationId = existing.id;
  } else {
    if (existing !== null) await db.message.deleteMany({ where: { conversationId: existing.id } });
    conversationId =
      existing?.id ??
      (
        await db.conversation.create({
          data: { npiOrgId: orgId, npiUserId: pm1UserId, positionId, titleAr: PREDECESSOR_CHAT.titleAr },
          select: { id: true },
        })
      ).id;
    const base = Date.now();
    await db.message.create({
      data: { conversationId, role: 'user', contentAr: PREDECESSOR_CHAT.userText, createdAt: new Date(base - 60_000) },
    });
    await db.message.create({
      data: {
        conversationId,
        role: 'assistant',
        contentAr: PREDECESSOR_CHAT.assistantText,
        kind: 'answer',
        createdAt: new Date(base - 30_000),
      },
    });
  }

  const row = await db.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { updatedAt: true } });
  return { conversationId, updatedAt: row.updatedAt };
}

/** Two company vendor facts (chat-sourced, no NPI vendor id) and one routine of the position,
 *  through the application's own `saveFact` (which deduplicates, so a repeat run is harmless). */
export async function seedPositionMemory(orgId: string, positionId: string): Promise<void> {
  const db = getClient();
  const results = await Promise.all([
    ...VENDOR_FACTS.map((vendor) =>
      saveFact(db, {
        npiOrgId: orgId,
        scope: 'company',
        entityType: 'vendor',
        npiEntityId: null,
        factAr: vendor.factAr,
        sourceType: 'chat',
        confidence: 0.9,
      }),
    ),
    saveFact(db, {
      npiOrgId: orgId,
      scope: 'position',
      positionId,
      entityType: 'position',
      factAr: ROUTINE_FACT_AR,
      sourceType: 'chat',
      confidence: 0.9,
    }),
  ]);
  for (const result of results) {
    if (!result.saved) throw new Error(`seedPositionMemory: saveFact refused a fact: ${result.reason}`);
  }
}

// ─── NPI: a requisition waiting on the `pm` role ────────────────────────────

/**
 * As the seeded engineer, through the copilot's own NPI client: a requisition
 * of 40 x MOD-550 at 320 (12,800 SAR, above the seeded 10,000 floor, so NPI
 * parks it on the `pm` role), submitted, then read back as `PENDING_APPROVAL`.
 */
export async function pendingRequisitionForPm(request: APIRequestContext): Promise<{ id: string; code: string }> {
  const { token } = await npiLogin(request, readSiteEngineerCredentials());
  const npi = createNpiClient({ token, baseUrl: API_BASE });

  const item = readItems(await npi.listItems()).find((i) => i.sku === 'MOD-550');
  if (item === undefined) throw new Error('pendingRequisitionForPm: the seeded item MOD-550 is not in NPI');

  const ref = readEntityRef(
    await npi.createRequisition({
      justification: REQUISITION_JUSTIFICATION,
      neededBy: isoDaysFromToday(10),
      lines: [{ itemId: item.id, qty: 40, estimatedUnitPrice: 320 }],
    }),
  );
  if (ref.code === null) throw new Error('pendingRequisitionForPm: NPI returned no code for the new requisition');
  await npi.submitRequisition(ref.id);

  const pr = await npiRequisition(request, token, ref.id);
  if (pr.status !== 'PENDING_APPROVAL') {
    throw new Error(`pendingRequisitionForPm: expected PENDING_APPROVAL, NPI holds ${pr.status}`);
  }
  return { id: ref.id, code: ref.code };
}

/**
 * The document codes of the chains NPI's own approvals inbox shows `account`
 * (`GET /approvals/inbox`, scoped to the caller's role: for pm2 — a `pm` — it
 * is the oracle for the handover's task list).
 */
export async function npiInboxCodes(request: APIRequestContext, account: SeededAccount): Promise<string[]> {
  const { token } = await npiLogin(request, account);
  return (await npiInbox(request, token)).map((entry) => entry.documentCode);
}

// ─── The handover itself ────────────────────────────────────────────────────

/**
 * The server's own `reassignPosition`, run in the test process: the seeded
 * administrator's NPI token and permissions, the copilot Prisma client, a
 * scripted narrative model and an empty-dictionary pseudonymizer. The scripted
 * model is not the audited client, so it writes no `llm_audit` row; the
 * service's own `position_reassigned` row is the only one.
 */
export async function seedHandover(
  request: APIRequestContext,
  ids: { positionId: string; pm2UserId: string },
): Promise<{ handoverId: string }> {
  const admin = await npiLogin(request, readAdminCredentials());
  const npi = createNpiClient({ token: admin.token, baseUrl: API_BASE });
  const me = readMe(await npi.me());

  const outcome = await reassignPosition(
    {
      db: getClient(),
      npi,
      llm: scriptedLlm(SCRIPTED_NARRATIVE),
      pseudonymizer: async () => new Pseudonymizer([]),
    },
    { npiOrgId: admin.orgId, npiUserId: admin.userId, permissions: me.permissions },
    { positionId: ids.positionId, toUserId: ids.pm2UserId },
  );
  if (outcome.narrativeStatus !== 'written') {
    throw new Error(`seedHandover: the scripted narrative was not written (${outcome.narrativeStatus})`);
  }
  return { handoverId: outcome.handoverId };
}

export interface HandoverRow {
  positionTitleAr: string;
  fromUserId: string | null;
  toUserId: string;
  createdAt: Date;
}

/** The stored columns of one document, for assertions that need the dates and titles the page formats. */
export async function handoverRow(handoverId: string): Promise<HandoverRow> {
  const row = await getClient().handoverDoc.findUniqueOrThrow({
    where: { id: handoverId },
    select: { fromUserId: true, toUserId: true, createdAt: true, position: { select: { titleAr: true } } },
  });
  return { positionTitleAr: row.position.titleAr, fromUserId: row.fromUserId, toUserId: row.toUserId, createdAt: row.createdAt };
}

export interface HandoverAuditRow {
  event: string;
  error: string | null;
}

/** `llm_audit` rows the handover writes for `npiUserId` since `since`: the
 *  model call (`handover_narrative`) and the trust-log row (`position_reassigned`). */
export async function handoverAuditRows(npiUserId: string, since: Date): Promise<HandoverAuditRow[]> {
  return getClient().llmAudit.findMany({
    where: { npiUserId, ts: { gte: since }, event: { in: ['handover_narrative', 'position_reassigned'] } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    select: { event: true, error: true },
  });
}
