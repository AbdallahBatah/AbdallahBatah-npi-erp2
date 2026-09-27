// Home-screen tile data (T-08, spec/madar/03 §2's four tiles).
//
// Every tile is read independently and in parallel: one tile's failure must
// never blank the others, and a bug in one reader must never crash the whole
// home page. NPI's own 403 becomes `forbidden` (the tile shows "no access"),
// any other `NpiError` (network, timeout, 5xx, or a body this file cannot
// make sense of) becomes `error`, and anything that is not an `NpiError` at
// all — a genuine bug — is rethrown rather than swallowed.
import { NpiError } from '@/npi/errors';
import type { NpiClient } from '@/npi/client';

export type TileKey = 'inbox' | 'contracts_draft' | 'pr_pending' | 'bills_unmatched';

export type TileState = { state: 'ok'; count: number } | { state: 'forbidden' } | { state: 'error' };

/**
 * One entry per tile key. The record's own key says which tile a state
 * belongs to, so `TileState` itself carries no separate `key` field.
 */
export type HomeTiles = Record<TileKey, TileState>;

/** The slice of `NpiClient` this file actually calls — kept narrow so a test
 *  fake only has to implement four methods, not the whole client. */
export type HomeNpi = Pick<NpiClient, 'inboxCount' | 'listContracts' | 'listRequisitions' | 'inboxTasks'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Same shape as `src/npi/responses.ts`'s own `unexpected()`: a malformed
 *  body becomes an `NpiError` of kind `unexpected`, so it flows through the
 *  same "any other NpiError → error" bucket as a real NPI-side failure,
 *  rather than crashing the home page as an uncaught bug would. */
function unexpected(detail: string): never {
  throw new NpiError({ status: 0, kind: 'unexpected', npiMessage: null, devDetail: detail });
}

// ─── readers for the two response shapes this file reads ──────────────────

/**
 * `GET /inbox/count` — apps/api/src/modules/inbox/inbox.service.ts, `count()`:
 *   `return { total: tasks.length, actionable: ..., overdue: ... };`
 * The tile is "tasks awaiting YOUR approval", so only `actionable` is read.
 */
function readInboxCount(body: unknown): { actionable: number } {
  if (!isRecord(body) || typeof body.actionable !== 'number') {
    return unexpected('readInboxCount: missing/invalid "actionable"');
  }
  return { actionable: body.actionable };
}

/**
 * `GET /requisitions?status=...&take=1` —
 * apps/api/src/modules/procurement/requisitions.service.ts, `list()`:
 *   `return { total, rows };` (`total` from `count()`, `rows` from `findMany()`).
 * Only `total` is read — the tile counts requisitions, never their rows.
 */
function readRequisitionsTotal(body: unknown): number {
  if (!isRecord(body) || typeof body.total !== 'number') {
    return unexpected('readRequisitionsTotal: missing/invalid "total"');
  }
  return body.total;
}

function readArray(body: unknown, context: string): unknown[] {
  if (!Array.isArray(body)) return unexpected(`${context}: expected an array body`);
  return body;
}

function stateFor(err: unknown): TileState {
  if (err instanceof NpiError) {
    return err.kind === 'forbidden' ? { state: 'forbidden' } : { state: 'error' };
  }
  throw err;
}

// ─── one loader per tile ────────────────────────────────────────────────────

/** Tile 1 — «مهام بانتظار اعتمادك» (`home.tile.inbox`). */
async function loadInbox(npi: HomeNpi): Promise<TileState> {
  try {
    const { actionable } = readInboxCount(await npi.inboxCount());
    return { state: 'ok', count: actionable };
  } catch (err) {
    return stateFor(err);
  }
}

/** Tile 2 — «عقود بانتظار التفعيل» (`home.tile.contracts_draft`): the number
 *  of contracts NPI returns with `status === 'DRAFT'`
 *  (apps/api/src/modules/commercial/contracts.service.ts, `list()` — a bare
 *  array from `findMany`, each row carrying its own `status`). */
async function loadContractsDraft(npi: HomeNpi): Promise<TileState> {
  try {
    const rows = readArray(await npi.listContracts(), 'listContracts');
    const count = rows.filter((row) => isRecord(row) && row.status === 'DRAFT').length;
    return { state: 'ok', count };
  } catch (err) {
    return stateFor(err);
  }
}

/** Tile 3 — «طلبات شراء معلقة» (`home.tile.pr_pending`): `total` of
 *  `GET /requisitions?status=SUBMITTED&take=1` plus `total` of the same call
 *  with `status=PENDING_APPROVAL` — never the rows, and never a client-side
 *  count of a paginated list. Both calls run together; either failing fails
 *  the tile as a whole (a half-counted "pending" figure would be worse than
 *  none). */
async function loadPrPending(npi: HomeNpi): Promise<TileState> {
  try {
    const [submitted, pendingApproval] = await Promise.all([
      npi.listRequisitions({ status: 'SUBMITTED', take: 1 }),
      npi.listRequisitions({ status: 'PENDING_APPROVAL', take: 1 }),
    ]);
    const count = readRequisitionsTotal(submitted) + readRequisitionsTotal(pendingApproval);
    return { state: 'ok', count };
  } catch (err) {
    return stateFor(err);
  }
}

/**
 * Tile 4 — «فواتير موردين بانتظار المطابقة» (`home.tile.bills_unmatched`):
 * the number of `GET /inbox/tasks` rows
 * (apps/api/src/modules/inbox/inbox.service.ts, `tasks()`) with
 * `documentType === 'VendorBill'` and `stateEn === 'Recorded'`.
 *
 * NPI API gaps (both go in the T-08 report, not worked around here):
 *  - NPI has no endpoint that lists vendor bills directly — the inbox task
 *    box is the only surface that carries them, so this reads that instead
 *    of a dedicated bills list.
 *  - The inbox task carries the workflow state's *name* (`stateEn`, e.g.
 *    "Recorded"), not its code — matching on a human-readable label is
 *    fragile (a copy change in NPI's workflow config would silently break
 *    this tile), but there is no `stateCode`/similar field to match on
 *    instead (see `InboxTask` in inbox.service.ts).
 */
async function loadBillsUnmatched(npi: HomeNpi): Promise<TileState> {
  try {
    const rows = readArray(await npi.inboxTasks(), 'inboxTasks');
    const count = rows.filter(
      (row) => isRecord(row) && row.documentType === 'VendorBill' && row.stateEn === 'Recorded',
    ).length;
    return { state: 'ok', count };
  } catch (err) {
    return stateFor(err);
  }
}

/** The four tiles, read in parallel. */
export async function loadHomeTiles(npi: HomeNpi): Promise<HomeTiles> {
  const [inbox, contracts_draft, pr_pending, bills_unmatched] = await Promise.all([
    loadInbox(npi),
    loadContractsDraft(npi),
    loadPrPending(npi),
    loadBillsUnmatched(npi),
  ]);
  return { inbox, contracts_draft, pr_pending, bills_unmatched };
}
