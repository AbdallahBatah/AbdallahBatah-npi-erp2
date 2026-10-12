// Fixtures for e2e/scenarios.spec.ts (T-31, AT-01…AT-06): the pre-state the
// live scenarios start from in the e2e NPI, and the reads of both systems
// they assert against.
//
// WHAT IS WRITTEN, AND BY WHOM. Four kinds of record, all by the seeded
// ADMINISTRATOR (his own token, over HTTP, from the test process):
//  - a project (`POST /contracts/:id/activate`, `POST /projects`) so a site
//    engineer's sentence can name one (AT-03, D-T31-5);
//  - a purchase order taken from DRAFT to SENT (`POST /procurement/purchase-orders`,
//    `…/:id/approve`, `…/:id/send`) so a delivery note or a bill has an order
//    to resolve against (AT-04, AT-05, D-T31-1);
//  - a goods receipt on that order, inspected and accepted
//    (`…/:id/receive`, `/procurement/receipts/:id/inspect|accept`) so a bill
//    has a billable receipt (AT-04);
//  - nothing else. The copilot's own writes (customers, contracts, requisitions,
//    receipts, bills) are made by the product under test, as the logged-in user.
//
// WHY DIRECT CALLS TO NPI'S LIFECYCLE ENDPOINTS ARE LEGITIMATE HERE AND
// NOWHERE IN `src`. The copilot never approves, sends, inspects, accepts or
// activates anything (tests/invariants.spec.ts invariant 5 forbids those
// literals in `src`). The scenarios still need an order that is SENT and a
// receipt that is ACCEPTED before the copilot is asked to receive against or
// bill them, and the only way NPI offers to get there is its own lifecycle
// endpoints. Same precedent as `ensureSecondPm` in `handover.ts`
// (`POST /admin/users` as the administrator): the test process plays the
// people who did those steps in the real world, with their own authority,
// through NPI's own API — never through `src/npi/client.ts`, never through
// NPI's database (08 §E.10). Every call here is a POST or GET; nothing is
// ever deleted: what a run creates stays as the demo databases' own history
// (T-28 D-T28-3), so every fixture is written for a repeat run on the same
// databases (a fresh order and receipt per call, serial numbers unique per
// run — D-T31-8).
//
// The copilot's own database is read through this file's own Prisma client
// (`src/generated/prisma`), closed by `disconnectScenariosDb()` from `afterAll`.
import '../../tests/helpers/load-env';
import type { APIRequestContext } from '@playwright/test';
import {
  expectedBillAmounts,
  partiesFromNpi,
  purchaseOrderDetailFromNpi,
  type PurchaseOrderDetail,
} from '../../src/extract/resolve';
import { PrismaClient } from '../../src/generated/prisma';
import type { CreatedEntity } from '../../src/intake/types';
import { readItems } from '../../src/npi/admin';
import { readVendorsBrief } from '../../src/npi/approvals';
import { readEntityRef, readList } from '../../src/npi/responses';
import { readAdminCredentials, readSeededAccount } from './accounts';
import { API_BASE } from './no-bypass';
import { npiGet, npiLogin, type NpiSession } from './scratch-orgs';

// ─── The copilot's own database ─────────────────────────────────────────────

let client: PrismaClient | undefined;
function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectScenariosDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

// ─── NPI wire helpers (fail loudly, naming what changed) ────────────────────
// Copied from `no-bypass.ts` (not exported there).

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

function text(value: unknown, what: string): string {
  return typeof value === 'string' ? value : shape(what, value);
}

function num(value: unknown, what: string): number {
  return typeof value === 'number' ? value : shape(what, value);
}

/** A Prisma Decimal column: serialised as a string ("850000.00", "10.000"); a plain number is accepted too. */
function decimal(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return shape(what, value);
}

// ─── The administrator, and writes ──────────────────────────────────────────

/** One administrator login per `request` object: each `beforeAll` gets its own, so a token never outlives a describe. */
const adminSessions = new WeakMap<APIRequestContext, Promise<NpiSession>>();

function adminSession(request: APIRequestContext): Promise<NpiSession> {
  let session = adminSessions.get(request);
  if (session === undefined) {
    session = npiLogin(request, readAdminCredentials());
    adminSessions.set(request, session);
  }
  return session;
}

/**
 * A POST to NPI as the administrator. Unlike `npiGet` it names NPI's reply on
 * failure (status and the first 300 characters of the body): a refused write
 * is a pre-state problem, and the reviewer needs NPI's own words for it.
 * `data` is omitted for the lifecycle routes that take no body.
 */
async function npiPost(request: APIRequestContext, token: string, apiPath: string, data?: unknown): Promise<unknown> {
  const res = await request.post(`${API_BASE}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(data === undefined ? {} : { data }),
  });
  if (!res.ok()) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`NPI POST ${apiPath} refused: HTTP ${res.status()} ${body}`);
  }
  return res.json();
}

export interface NpiEntityRef {
  id: string;
  code: string;
}

/** `readEntityRef` (the application's own reader) with the code required. */
function entityRef(body: unknown, what: string): NpiEntityRef {
  const ref = readEntityRef(body);
  if (ref.code === null) throw new Error(`${what}: NPI returned no code (got ${JSON.stringify(body).slice(0, 200)})`);
  return { id: ref.id, code: ref.code };
}

// ─── ensureProject (D-T31-5) ────────────────────────────────────────────────

/** The name the fixture gives a project it opens (also how a repeat run finds it again). */
export const PROJECT_NAME_AR = 'مشروع الموقع الشمالي — مَدار';

/**
 * A project the site engineer's sentence can name, as the administrator.
 *
 * An existing project is preferred (the one this fixture named, else the
 * oldest). Otherwise a contract with no project is activated and a project
 * opened from it.
 *
 * Wire shapes:
 *  - `GET /projects` (`projects.service.ts:43-58` `list`) is a bare `findMany`
 *    array of `Project` rows with `contract` and `_count` included, so each row
 *    carries its own scalar columns: `id` (schema.prisma:891), `code` (:894),
 *    `contractId` (:895), `nameAr` (:897);
 *  - `GET /contracts` (`contracts.service.ts:22-31` `list`) is a bare array of
 *    `Contract` rows with ONLY `customer` and `_count.milestones` included:
 *    `id` (schema.prisma:533), `code` (:536), `status` (:546), `createdAt`
 *    (:553). It does NOT say whether a contract has a project — `Contract.project`
 *    (:559) is a relation neither list nor `GET /contracts/:id` (:33-44)
 *    includes — so the contracts that already have one are excluded by the
 *    `contractId`s of `GET /projects`;
 *  - `POST /contracts/:id/activate` (`contracts.controller.ts:39-43`) answers the
 *    updated `Contract` row (`contracts.service.ts:149-168`): DRAFT -> ACTIVE
 *    and no other rule, refused with 400 «Only draft contracts can be activated»;
 *  - `POST /projects` (`projects.controller.ts` `create`, `projects.project.write`)
 *    takes `CreateProjectDto { contractId, nameAr?, … }` (`projects/dto.ts:5-13`)
 *    and answers the created `Project` with its `wbsElements`
 *    (`projects.service.ts:144`), refused unless the contract is ACTIVE and has
 *    no project (`projects.service.ts:81-86`).
 *
 * A DRAFT contract is preferred (D-T31-5); an ACTIVE one with no project is the
 * fallback, which also repairs a run that activated a contract and then failed
 * to open its project. Throws, naming NPI's status and body, when a write fails.
 */
export async function ensureProject(request: APIRequestContext): Promise<NpiEntityRef & { nameAr: string }> {
  const { token } = await adminSession(request);

  const projects = readList(await npiGet(request, token, '/projects')).map((row) => {
    const p = rec(row, 'project row');
    return {
      id: text(p.id, 'project.id'),
      code: text(p.code, 'project.code'),
      nameAr: text(p.nameAr, 'project.nameAr'),
      contractId: text(p.contractId, 'project.contractId'),
    };
  });
  // `list` is ordered newest first; the fixture's own project wins, else the oldest.
  const existing = projects.find((p) => p.nameAr === PROJECT_NAME_AR) ?? projects[projects.length - 1];
  if (existing !== undefined) return { id: existing.id, code: existing.code, nameAr: existing.nameAr };

  const taken = new Set(projects.map((p) => p.contractId));
  const contracts = readList(await npiGet(request, token, '/contracts'))
    .map((row) => {
      const c = rec(row, 'contract row');
      return {
        id: text(c.id, 'contract.id'),
        code: text(c.code, 'contract.code'),
        status: text(c.status, 'contract.status'),
        createdAt: text(c.createdAt, 'contract.createdAt'),
      };
    })
    .filter((c) => !taken.has(c.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const draft = contracts.find((c) => c.status === 'DRAFT');
  const active = contracts.find((c) => c.status === 'ACTIVE');
  const source = draft ?? active;
  if (source === undefined) {
    throw new Error(
      `ensureProject: NPI has no project and no DRAFT or ACTIVE contract without one to open it from (${contracts.length} contract(s) without a project)`,
    );
  }

  if (source.status === 'DRAFT') {
    const activated = rec(await npiPost(request, token, `/contracts/${encodeURIComponent(source.id)}/activate`), 'activated contract');
    if (activated.status !== 'ACTIVE') {
      throw new Error(`ensureProject: ${source.code} is ${String(activated.status)} after activation, expected ACTIVE`);
    }
  }

  const created = await npiPost(request, token, '/projects', { contractId: source.id, nameAr: PROJECT_NAME_AR });
  const ref = entityRef(created, 'ensureProject: POST /projects');
  return { ...ref, nameAr: text(rec(created, 'created project').nameAr, 'created project.nameAr') };
}

// ─── Purchase order, receipt (D-T31-1, D-T31-8) ─────────────────────────────

export interface PoLineSpec {
  sku: string;
  qty: number;
  unitPrice: number;
}

/**
 * `GET /procurement/purchase-orders/:id` as the copilot's own
 * `purchaseOrderDetailFromNpi` reads it (`src/extract/resolve.ts`): the order's
 * `status`, its `lines[{ id, itemId, qty, unitPrice, receivedQty, item { sku,
 * nameAr, isSerialised } }]` and its `goodsReceipts[{ id, code, status, billed,
 * lines[{ purchaseOrderLineId, qty }] }]`. On the wire:
 *  - `procurement.service.ts:144-168` `getPo`: the `PurchaseOrder` row with
 *    `lines` (each with `item: { sku, nameAr, nameEn, isSerialised, uom }`,
 *    :151-152) and `goodsReceipts` (each with `lines`, and
 *    `vendorBills: { id, code, status }[]`, :154-157 — `billed` is "has a
 *    vendor bill"), plus `pendingApproval`;
 *  - decimals (`qty`, `unitPrice`, `receivedQty`) arrive as strings
 *    (schema.prisma:989-992) and `purchaseOrderDetailFromNpi` converts them.
 * Throws when the body is not a purchase order.
 */
export async function npiPurchaseOrderDetail(request: APIRequestContext, token: string, id: string): Promise<PurchaseOrderDetail> {
  const body = await npiGet(request, token, `/procurement/purchase-orders/${encodeURIComponent(id)}`);
  const detail = purchaseOrderDetailFromNpi(body);
  if (detail === null) return shape(`purchase order ${id}`, body);
  return detail;
}

/**
 * A purchase order in the e2e NPI taken DRAFT -> SENT, as the administrator.
 * Vendor `VEN-00001` and each line's item by code (`GET /procurement/vendors`
 * and `GET /items` are bare arrays: `readVendorsBrief` / `readItems`, the
 * application's own readers — `procurement.service.ts:90-96`, `items.service.ts:10-12`).
 *
 * Wire shapes:
 *  - `POST /procurement/purchase-orders` (`procurement.controller.ts:49-53`)
 *    takes `CreatePoDto { vendorId, projectId?, currency?, lines[{ itemId, qty,
 *    unitPrice, wbsElementId? }] }` (`procurement/dto.ts:46-60`; the global
 *    pipe forbids any other key, `main.ts:27-32`) and answers the raw
 *    `PurchaseOrder` row with its lines (`procurement.service.ts:242`): `id`,
 *    `code` (schema.prisma:952,955);
 *  - `POST …/:id/approve` (:55-59, no body): `approvePo` (:260-305) runs the
 *    matrix; since NPI's P1-13 the seeded PURCHASE_ORDER rule runs from 0 SAR
 *    with the executive as its one step, so the answer is
 *    `{ …order, pendingApproval }` (:302) and the order waits in
 *    PENDING_APPROVAL; the seeded executive (`ceo@npi.sa`) then signs it in
 *    NPI's inbox (`GET /approvals/inbox`, `POST /approvals/:id/decide`), and
 *    the last signature takes it to APPROVED. With no rule covering it the
 *    verdict is `cleared` and the one call already approves it;
 *  - `POST …/:id/send` (:62-66, no body): APPROVED -> SENT (:370-388).
 * The order is read back and the call throws unless it is `SENT`.
 * `lineIdBySku` is read from that detail (a PO line's id is not on the create
 * response keyed by SKU).
 */
/**
 * Signs a parked purchase order as the seeded executive, the one step of the
 * seeded PURCHASE_ORDER rule: his inbox row for the order, then his decision.
 * The test process plays the person who signs orders, with his own token,
 * through NPI's API (the same precedent as the administrator's writes here).
 */
async function signAsExecutive(request: APIRequestContext, ref: NpiEntityRef): Promise<void> {
  const executive = await npiLogin(request, readSeededAccount('executive'));
  const inbox = await npiGet(request, executive.token, '/approvals/inbox');
  if (!Array.isArray(inbox)) throw new Error('sentPurchaseOrder: GET /approvals/inbox is not a list');
  const row = inbox
    .map((r) => rec(r, 'inbox row'))
    .find((r) => r.documentType === 'PURCHASE_ORDER' && r.documentId === ref.id);
  if (row === undefined) {
    throw new Error(`sentPurchaseOrder: ${ref.code} waits for approval but is not in the executive's inbox`);
  }
  await npiPost(request, executive.token, `/approvals/${encodeURIComponent(String(row.id))}/decide`, { decision: 'APPROVE' });
}

export async function sentPurchaseOrder(
  request: APIRequestContext,
  lines: PoLineSpec[],
  projectId?: string,
): Promise<NpiEntityRef & { lineIdBySku: Record<string, string> }> {
  const { token } = await adminSession(request);

  const items = readItems(await npiGet(request, token, '/items'));
  const vendor = readVendorsBrief(await npiGet(request, token, '/procurement/vendors')).find((v) => v.code === 'VEN-00001');
  if (vendor === undefined) throw new Error("sentPurchaseOrder: the seeded vendor VEN-00001 is not in NPI");

  const poLines = lines.map((spec) => {
    const item = items.find((i) => i.sku === spec.sku);
    if (item === undefined) throw new Error(`sentPurchaseOrder: the seeded item ${spec.sku} is not in NPI`);
    return { itemId: item.id, qty: spec.qty, unitPrice: spec.unitPrice };
  });

  const created = await npiPost(request, token, '/procurement/purchase-orders', {
    vendorId: vendor.id,
    ...(projectId === undefined ? {} : { projectId }),
    lines: poLines,
  });
  const ref = entityRef(created, 'sentPurchaseOrder: POST /procurement/purchase-orders');

  const approved = rec(await npiPost(request, token, `/procurement/purchase-orders/${encodeURIComponent(ref.id)}/approve`), 'approved purchase order');
  if (approved.pendingApproval !== undefined && approved.pendingApproval !== null) {
    await signAsExecutive(request, ref);
  }
  await npiPost(request, token, `/procurement/purchase-orders/${encodeURIComponent(ref.id)}/send`);

  const detail = await npiPurchaseOrderDetail(request, token, ref.id);
  if (detail.status !== 'SENT') throw new Error(`sentPurchaseOrder: ${ref.code} is ${String(detail.status)} in NPI, expected SENT`);

  const lineIdBySku: Record<string, string> = {};
  for (const line of detail.lines) {
    if (line.sku !== null) lineIdBySku[line.sku] = line.id;
  }
  for (const spec of lines) {
    if (lineIdBySku[spec.sku] === undefined) throw new Error(`sentPurchaseOrder: ${ref.code} has no line for ${spec.sku}`);
  }
  return { ...ref, lineIdBySku };
}

export interface ReceiptLineSpec {
  sku: string;
  qty: number;
}

/**
 * A receipt on `po` taken DRAFT -> INSPECTED -> ACCEPTED, as the administrator.
 * A serialised line carries serials `E2E-<runId>-<SKU>-<nnn>` (D-T31-8:
 * NPI keeps serial units unique per item, schema.prisma:1075, so a repeat run
 * never collides); whether a line is serialised is read from the PO detail's
 * `item.isSerialised`, never hard-coded by SKU. Use one `runId` per receipt of
 * the same SKU in a run.
 *
 * Wire shapes:
 *  - `POST /procurement/purchase-orders/:id/receive` (`procurement.controller.ts:68-72`)
 *    takes `ReceiveDto { lines[{ poLineId, qty, serials?, batchNo? }], notes?,
 *    locationId? }` (`procurement/dto.ts:62-77`) and answers the created
 *    `GoodsReceipt` row with its `lines` (`procurement.service.ts:495`
 *    `tx.goodsReceipt.findUnique(… include: { lines: true })`): `id`, `code`,
 *    `status` `DRAFT` (schema.prisma:1001,1004,1010). The order must be
 *    `SENT` or `PARTIALLY_RECEIVED`, a serialised line needs exactly `qty`
 *    distinct serials (:421-446);
 *  - `POST /procurement/receipts/:id/inspect` (:76-84) answers the receipt row,
 *    now `INSPECTED` (:515);
 *  - `POST /procurement/receipts/:id/accept` (:86-94) answers the receipt with
 *    `lines` and `serialUnits` (:685), now `ACCEPTED`; it books stock, creates
 *    the serial units, and moves the ORDER to `PARTIALLY_RECEIVED` or
 *    `RECEIVED` (:659-664).
 *  - Both lifecycle routes take `WorkflowActionDto` (`procurement/requisitions.dto.ts:63-66`),
 *    whose `action` is a REQUIRED string (1-40 characters) although neither
 *    service method reads it (`inspectGrn(user, id, dto.comment)`, :500): an
 *    empty body is a 400. The fixture sends the action's own code.
 * The PO detail is read back and the call throws unless that receipt is
 * `ACCEPTED` and `billed === false`.
 */
export async function acceptedReceipt(
  request: APIRequestContext,
  po: { id: string; lineIdBySku: Record<string, string> },
  lines: ReceiptLineSpec[],
  runId: string,
): Promise<NpiEntityRef> {
  const { token } = await adminSession(request);
  const before = await npiPurchaseOrderDetail(request, token, po.id);

  const receiveLines = lines.map((spec) => {
    const poLineId = po.lineIdBySku[spec.sku];
    if (poLineId === undefined) throw new Error(`acceptedReceipt: ${before.code} has no line for ${spec.sku}`);
    const poLine = before.lines.find((l) => l.id === poLineId);
    if (poLine === undefined) throw new Error(`acceptedReceipt: line ${poLineId} is not on ${before.code}`);
    if (!poLine.isSerialised) return { poLineId, qty: spec.qty };
    if (!Number.isInteger(spec.qty)) throw new Error(`acceptedReceipt: ${spec.sku} is serialised, so ${spec.qty} is not a whole quantity`);
    const serials = Array.from({ length: spec.qty }, (_, i) => `E2E-${runId}-${spec.sku}-${String(i + 1).padStart(3, '0')}`);
    return { poLineId, qty: spec.qty, serials };
  });

  const received = await npiPost(request, token, `/procurement/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
    lines: receiveLines,
    notes: `e2e T-31 fixture receipt ${runId}`,
  });
  const ref = entityRef(received, 'acceptedReceipt: POST …/receive');

  await npiPost(request, token, `/procurement/receipts/${encodeURIComponent(ref.id)}/inspect`, { action: 'INSPECT' });
  await npiPost(request, token, `/procurement/receipts/${encodeURIComponent(ref.id)}/accept`, { action: 'ACCEPT' });

  const after = await npiPurchaseOrderDetail(request, token, po.id);
  const receipt = after.goodsReceipts.find((g) => g.id === ref.id);
  if (receipt === undefined) throw new Error(`acceptedReceipt: ${ref.code} is not on ${after.code} after acceptance`);
  if (receipt.status !== 'ACCEPTED') throw new Error(`acceptedReceipt: ${ref.code} is ${String(receipt.status)} in NPI, expected ACCEPTED`);
  if (receipt.billed) throw new Error(`acceptedReceipt: ${ref.code} is already billed`);
  return ref;
}

/**
 * The lines `bill-01.jpg` prints (`eval/extract/vendor_bill/expected.json`,
 * `lines.0…2`). Over a FULL receipt the application's own `expectedBillAmounts`
 * (`src/extract/resolve.ts`: sum of receipt qty x PO unit price, VAT on top at
 * 15 %) gives subtotal 21,460 (12,800 + 6,500 + 2,160), VAT 3,219 and total
 * 24,679 — the bill's printed figures; `billPrestate` computes them from NPI's
 * own PO detail and checks the subtotal against these lines.
 */
export const BILL_01_LINES: PoLineSpec[] = [
  { sku: 'MOD-550', qty: 40, unitPrice: 320 },
  { sku: 'INV-50K', qty: 1, unitPrice: 6500 },
  { sku: 'MNT-RAIL', qty: 120, unitPrice: 18 },
];

/** An order large enough for `grn-01.jpg`'s partial delivery (8 / 1 / 120 against 40 / 1 / 120). */
export const GRN_01_PO_LINES: PoLineSpec[] = BILL_01_LINES.map((line) => ({ ...line }));

/**
 * AT-04's pre-state: a SENT order of `BILL_01_LINES` and an ACCEPTED, unbilled
 * receipt of the whole order, plus the amounts NPI will bill for it — the
 * application's own `expectedBillAmounts(receipt, detail)` over the PO detail
 * read back from NPI. Throws when the subtotal is not the sum of the lines.
 */
export async function billPrestate(
  request: APIRequestContext,
  runId: string,
): Promise<{ po: NpiEntityRef; receipt: NpiEntityRef; expected: { subtotal: number; vatAmount: number; total: number } }> {
  const po = await sentPurchaseOrder(request, BILL_01_LINES);
  const receipt = await acceptedReceipt(
    request,
    po,
    BILL_01_LINES.map((l) => ({ sku: l.sku, qty: l.qty })),
    runId,
  );

  const { token } = await adminSession(request);
  const detail = await npiPurchaseOrderDetail(request, token, po.id);
  const ref = detail.goodsReceipts.find((g) => g.id === receipt.id);
  if (ref === undefined) throw new Error(`billPrestate: ${receipt.code} is not on ${po.code}`);
  const expected = expectedBillAmounts(ref, detail);

  const linesTotal = BILL_01_LINES.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  if (Math.abs(expected.subtotal - linesTotal) > 0.005) {
    throw new Error(`billPrestate: NPI's receipt subtotal ${expected.subtotal} is not the lines' ${linesTotal}`);
  }
  return { po: { id: po.id, code: po.code }, receipt, expected };
}

/** AT-05's pre-state: a SENT order (no receipt) the delivery note is received against. */
export async function grnPrestate(request: APIRequestContext): Promise<{ po: NpiEntityRef & { lineIdBySku: Record<string, string> } }> {
  return { po: await sentPurchaseOrder(request, GRN_01_PO_LINES) };
}

// ─── NPI reads (as a given user, over HTTP) ─────────────────────────────────

/**
 * The NPI customer whose VAT number is `vat` (digits compared, as
 * `npiCustomerNameByVat` in `no-bypass.ts`), through the application's own
 * `partiesFromNpi`; `null` when there is none. `GET /customers` is a bare
 * `findMany` array of `Customer` rows (`customers.service.ts:16-17`; `id` schema.prisma:336, `nameAr` :340,
 * `vatNumber` :343).
 */
export async function npiCustomerIdByVat(
  request: APIRequestContext,
  token: string,
  vat: string,
): Promise<{ id: string; nameAr: string } | null> {
  const digits = (value: string) => value.replaceAll(/\D/g, '');
  const found = partiesFromNpi(await npiGet(request, token, '/customers')).find(
    (p) => p.vatNumber !== null && digits(p.vatNumber) === digits(vat),
  );
  return found === undefined ? null : { id: found.id, nameAr: found.nameAr };
}

export interface NpiContract {
  id: string;
  code: string;
  status: string;
  customerId: string;
  totalValue: number;
  retentionPct: number | null;
  milestones: { sequence: number; amount: number; percent: number | null }[];
}

/**
 * `GET /contracts/:id` (`commercial.contract.read`): `contracts.service.ts:33-44`
 * `get` returns the `Contract` row with `customer`, `opportunity`,
 * `proposalRevision` and `milestones` ordered by `sequence`. Fields:
 *  - `id` (schema.prisma:533), `code` (:536), `customerId` (:537), `status`
 *    (:546, `DRAFT` until activated);
 *  - `totalValue` (:550, Decimal(18,2)) and `retentionPct` (:551, Decimal(6,3),
 *    NOT NULL, default 0) arrive as strings: `Number(...)`;
 *  - `milestones[]` are `ContractMilestone` rows: `sequence` (:571, Int),
 *    `amount` (:575, Decimal -> string).
 * `percent` is ALWAYS null here: `ContractMilestone` has no percentage column
 * and `MilestoneInputDto` (`commercial/dto.ts`) takes none — the card's
 * per-milestone percent exists only in the copilot's extraction and preview,
 * never in NPI.
 */
export async function npiContract(request: APIRequestContext, token: string, id: string): Promise<NpiContract> {
  const c = rec(await npiGet(request, token, `/contracts/${encodeURIComponent(id)}`), 'contract');
  const milestones = arr(c.milestones, 'contract.milestones').map((row) => {
    const m = rec(row, 'contract.milestones row');
    return { sequence: num(m.sequence, 'milestone.sequence'), amount: decimal(m.amount, 'milestone.amount'), percent: null };
  });
  return {
    id: text(c.id, 'contract.id'),
    code: text(c.code, 'contract.code'),
    status: text(c.status, 'contract.status'),
    customerId: text(c.customerId, 'contract.customerId'),
    totalValue: decimal(c.totalValue, 'contract.totalValue'),
    retentionPct: c.retentionPct === null ? null : decimal(c.retentionPct, 'contract.retentionPct'),
    milestones,
  };
}

/**
 * `GET /attachments/contract/:id` (`platform.attachment.read` and, for a
 * contract, `commercial.contract.read`: `attachments.controller.ts:44-52`,
 * `attachments.service.ts:32-37,54-58,71-77`): a bare `findMany` array of
 * `Attachment` rows, newest first. The file name is `fileName` (schema.prisma:1839 —
 * the original upload name); the content type is `mimeType` (:1840, not `mime`)
 * and the size `sizeBytes` (:1841), neither read here.
 */
export async function npiAttachmentNames(request: APIRequestContext, token: string, entityType: 'contract', entityId: string): Promise<string[]> {
  return arr(await npiGet(request, token, `/attachments/${entityType}/${encodeURIComponent(entityId)}`), 'attachments').map((row) =>
    text(rec(row, 'attachment row').fileName, 'attachment.fileName'),
  );
}

export interface InboxWorkflowTask {
  documentType: string;
  documentCode: string;
  stateEn: string;
}

/**
 * `GET /inbox/tasks` (`inbox.controller.ts:25-28`, `@SkipPermissions`, scoped to
 * the caller's own role): a BARE array of `InboxTask`
 * (`inbox.service.ts:5-24,43-98`) — the approval rows (`source: 'APPROVAL'`)
 * then the workflow tasks (`source: 'WORKFLOW'`), oldest first. Each row
 * carries `documentType`, `documentCode` and `stateEn` (the workflow state's
 * English NAME: «Recorded» for a vendor bill still in DRAFT, seed.ts:691 —
 * the same filter the home tile counts with, `src/queries/home.ts:140-142`).
 * A bill created by the copilot parks its workflow instance on the caller's
 * own role (`procurement.service.ts` `createBill`, `assigneeRoleId: user.roleId`).
 */
export async function npiInboxTasks(request: APIRequestContext, token: string): Promise<InboxWorkflowTask[]> {
  return arr(await npiGet(request, token, '/inbox/tasks'), 'inbox tasks').map((row) => {
    const t = rec(row, 'inbox task');
    return {
      documentType: text(t.documentType, 'task.documentType'),
      documentCode: text(t.documentCode, 'task.documentCode'),
      stateEn: text(t.stateEn, 'task.stateEn'),
    };
  });
}

// ─── The copilot's audit and jobs (its own database) ────────────────────────

export interface AuditRowSince {
  event: string;
  modelId: string | null;
  imageSent: boolean;
  consentEventId: string | null;
  outboundRedactedText: string | null;
  intakeJobId: string | null;
  documentId: string | null;
  error: string | null;
}

/**
 * `llm_audit` rows (`model LlmAudit`, `prisma/schema.prisma:386-409`) written
 * for `npiUserId` at or after `since`, oldest first. Callers pass a `since`
 * taken a few seconds before the step (clock margin — D-T31-9); the whole
 * table is never read.
 */
export async function auditRowsSince(npiUserId: string, since: Date): Promise<AuditRowSince[]> {
  return getClient().llmAudit.findMany({
    where: { npiUserId, ts: { gte: since } },
    orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    select: {
      event: true,
      modelId: true,
      imageSent: true,
      consentEventId: true,
      outboundRedactedText: true,
      intakeJobId: true,
      documentId: true,
      error: true,
    },
  });
}

/**
 * `intake_jobs` (`model IntakeJob`, `prisma/schema.prisma:302-326`) created for
 * `npiUserId` at or after `since`, oldest first. `npiEntityRefs` is the JSON
 * column the executor writes (`src/execute/run.ts`): a list of `CreatedEntity`,
 * or null before execution.
 */
export async function intakeJobsSince(
  npiUserId: string,
  since: Date,
): Promise<{ id: string; flowType: string; status: string; npiEntityRefs: CreatedEntity[] | null }[]> {
  const rows = await getClient().intakeJob.findMany({
    where: { npiUserId, createdAt: { gte: since } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, flowType: true, status: true, npiEntityRefs: true },
  });
  return rows.map((row) => ({
    id: row.id,
    flowType: row.flowType,
    status: row.status,
    npiEntityRefs: Array.isArray(row.npiEntityRefs) ? (row.npiEntityRefs as unknown as CreatedEntity[]) : null,
  }));
}

/** One id per run: serial numbers and receipt notes carry it (D-T31-8). */
export function newRunId(): string {
  return Date.now().toString(36);
}
