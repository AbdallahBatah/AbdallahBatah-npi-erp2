// T-29 (F-12, spec/madar/02 §8): the NPI reads the firm's memory is derived
// from, and the loader that makes them. Same discipline as `src/npi/admin.ts`:
// NPI's OpenAPI document does not type these response bodies, so the
// low-level client returns `unknown`, and every field read here is traced back
// to the exact NPI source line that puts it on the wire. A field this file
// cannot trace is not read here.
//
// Money and quantities: NPI serializes Prisma `Decimal` columns as strings
// (`Decimal.toJSON` returns a string) and `DateTime` as an ISO string. The
// readers parse the Decimals to `number` (they are summed or averaged only
// for a remembered sentence, never posted) and keep dates as ISO strings.
//
// The loader reads as the logged-in user: a source the user's permissions do
// not cover is not even requested, and one NPI refuses (403) or fails on is
// reported as skipped, never retried.
import type { NpiClient } from '../npi/client';
import { NpiError } from '../npi/errors';
import {
  NPI_MEMORY_SOURCES,
  PERMISSION_OF_SOURCE,
  type NpiContractRow,
  type NpiCustomerRow,
  type NpiGoodsReceiptRow,
  type NpiMemorySnapshot,
  type NpiMemorySource,
  type NpiProjectRow,
  type NpiPurchaseOrderLine,
  type NpiPurchaseOrderRow,
  type SnapshotLoad,
  type SnapshotSourceOutcome,
} from './npi-facts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unexpected(detail: string): never {
  throw new NpiError({ status: 0, kind: 'unexpected', npiMessage: null, devDetail: detail });
}

/** Decimal on the wire: a numeric string, or a plain number if NPI ever
 *  switches serialization. Anything else is rejected, not coerced to NaN. */
function readAmount(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return unexpected(`${where}: amount is neither a finite number nor a numeric string`);
}

/** DateTime on the wire: an ISO string (returned as is), or null/absent for a
 *  nullable column. Anything else, including a string that is not a date, is
 *  rejected. */
function readDate(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))) return value;
  return unexpected(`${where}: date is neither null nor an ISO date string`);
}

function readString(value: unknown, where: string): string {
  if (typeof value !== 'string') return unexpected(`${where}: missing/invalid string`);
  return value;
}

// ─── GET /customers ──────────────────────────────────────────────────────────

/**
 * `CustomersService.list()` (apps/api/src/modules/crm/customers.service.ts
 * lines 16–32) runs `this.prisma.customer.findMany({ where, orderBy })` with no
 * `select`, so every element is NPI's full `Customer` row
 * (packages/db/prisma/schema.prisma, `model Customer` lines 335–358):
 *  - id               line 336
 *  - code             line 339
 *  - nameAr           line 340
 *  - creditTermsDays  line 345 (`Int @default(0)` → a JSON number)
 * Permission: `crm.customer.read`.
 */
export function readCustomers(body: unknown): NpiCustomerRow[] {
  if (!Array.isArray(body)) return unexpected('readCustomers: body is not an array');
  return body.map((row, index) => {
    const where = `readCustomers[${index}]`;
    if (!isRecord(row)) return unexpected(`${where}: element is not an object`);
    const { id, code, nameAr, creditTermsDays } = row;
    if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
    if (typeof code !== 'string') return unexpected(`${where}: missing/invalid "code"`);
    if (typeof nameAr !== 'string') return unexpected(`${where}: missing/invalid "nameAr"`);
    if (typeof creditTermsDays !== 'number' || !Number.isFinite(creditTermsDays)) {
      return unexpected(`${where}: missing/invalid "creditTermsDays"`);
    }
    return { id, code, nameAr, creditTermsDays };
  });
}

// ─── GET /contracts ──────────────────────────────────────────────────────────

/**
 * `ContractsService.list()` (apps/api/src/modules/commercial/contracts.service.ts
 * lines 22–31) runs `this.prisma.contract.findMany({ where, include: { customer:
 * { select: { id, code, nameAr, nameEn } }, _count: { select: { milestones:
 * true } } }, orderBy })`, so every element is the full `Contract` row plus two
 * includes (`model Contract`, schema lines 532–565):
 *  - id            line 533
 *  - code          line 536
 *  - contractType  line 545 (`ContractType`: EPC | PPA | OM | LEASE, enum lines 78–83)
 *  - status        line 546 (`ContractStatus`, enum lines 85–91)
 *  - startDate     line 547 (`DateTime?` → ISO string or null)
 *  - endDate       line 548 (`DateTime?`)
 *  - totalValue    line 550 (`Decimal(18,2)` → string)
 *  - retentionPct  line 551 (`Decimal(6,3)` → string)
 *  - advancePct    line 552 (`Decimal(6,3)` → string)
 * `customer.{id,code,nameAr}` come from the `customer` select (service line 26;
 * schema `model Customer` lines 336/339/340) and `_count.milestones` from the
 * `_count` select (service line 27). Permission: `commercial.contract.read`.
 */
export function readContracts(body: unknown): NpiContractRow[] {
  if (!Array.isArray(body)) return unexpected('readContracts: body is not an array');
  return body.map((row, index) => {
    const where = `readContracts[${index}]`;
    if (!isRecord(row)) return unexpected(`${where}: element is not an object`);
    const { id, code, status, contractType, totalValue, retentionPct, advancePct, startDate, endDate, customer, _count } =
      row;
    if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
    if (typeof code !== 'string') return unexpected(`${where}: missing/invalid "code"`);
    if (typeof status !== 'string') return unexpected(`${where}: missing/invalid "status"`);
    if (typeof contractType !== 'string') return unexpected(`${where}: missing/invalid "contractType"`);
    if (!isRecord(customer)) return unexpected(`${where}: missing/invalid "customer"`);
    if (typeof customer.id !== 'string') return unexpected(`${where}: missing/invalid "customer.id"`);
    if (typeof customer.code !== 'string') return unexpected(`${where}: missing/invalid "customer.code"`);
    if (typeof customer.nameAr !== 'string') return unexpected(`${where}: missing/invalid "customer.nameAr"`);
    if (!isRecord(_count) || typeof _count.milestones !== 'number' || !Number.isFinite(_count.milestones)) {
      return unexpected(`${where}: missing/invalid "_count.milestones"`);
    }
    return {
      id,
      code,
      status,
      contractType,
      totalValue: readAmount(totalValue, `${where}.totalValue`),
      retentionPct: readAmount(retentionPct, `${where}.retentionPct`),
      advancePct: readAmount(advancePct, `${where}.advancePct`),
      startDate: readDate(startDate, `${where}.startDate`),
      endDate: readDate(endDate, `${where}.endDate`),
      customer: { id: customer.id, code: customer.code, nameAr: customer.nameAr },
      milestoneCount: _count.milestones,
    };
  });
}

// ─── GET /procurement/purchase-orders ────────────────────────────────────────

export interface NpiPurchaseOrderListRow {
  id: string;
  code: string;
  status: string;
  createdAt: string;
}

/**
 * `ProcurementService.listPos()` (apps/api/src/modules/procurement/procurement.service.ts
 * lines 132–142) runs `this.prisma.purchaseOrder.findMany({ where, include: {
 * vendor: { select: { code, nameAr, nameEn } }, project: { select: { id, code }
 * }, _count: { select: { goodsReceipts: true } } }, orderBy: { createdAt:
 * 'desc' } })`: the full `PurchaseOrder` row (`model PurchaseOrder`, schema
 * lines 951–979) plus includes. Only the scalars the cap needs are read:
 *  - id         line 952
 *  - code       line 955
 *  - status     line 960 (`PoStatus`, enum lines 810–819)
 *  - createdAt  line 967
 * The vendor in a list element has NO id (the select omits it), which is why
 * the vendor comes from `readPurchaseOrder`. Permission: `scm.procurement.read`.
 */
export function readPurchaseOrderList(body: unknown): NpiPurchaseOrderListRow[] {
  if (!Array.isArray(body)) return unexpected('readPurchaseOrderList: body is not an array');
  return body.map((row, index) => {
    const where = `readPurchaseOrderList[${index}]`;
    if (!isRecord(row)) return unexpected(`${where}: element is not an object`);
    const { id, code, status, createdAt } = row;
    if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
    if (typeof code !== 'string') return unexpected(`${where}: missing/invalid "code"`);
    if (typeof status !== 'string') return unexpected(`${where}: missing/invalid "status"`);
    if (typeof createdAt !== 'string') return unexpected(`${where}: missing/invalid "createdAt"`);
    return { id, code, status, createdAt };
  });
}

// ─── GET /procurement/purchase-orders/:id ────────────────────────────────────

function readLine(value: unknown, where: string): NpiPurchaseOrderLine {
  if (!isRecord(value)) return unexpected(`${where}: element is not an object`);
  const { itemId, qty, item } = value;
  if (typeof itemId !== 'string') return unexpected(`${where}: missing/invalid "itemId"`);
  if (!isRecord(item)) return unexpected(`${where}: missing/invalid "item"`);
  return {
    itemId,
    sku: readString(item.sku, `${where}.item.sku`),
    nameAr: readString(item.nameAr, `${where}.item.nameAr`),
    uom: readString(item.uom, `${where}.item.uom`),
    qty: readAmount(qty, `${where}.qty`),
  };
}

function readReceipt(value: unknown, where: string): NpiGoodsReceiptRow {
  if (!isRecord(value)) return unexpected(`${where}: element is not an object`);
  const { id, code, status, receivedAt } = value;
  if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
  if (typeof code !== 'string') return unexpected(`${where}: missing/invalid "code"`);
  if (typeof status !== 'string') return unexpected(`${where}: missing/invalid "status"`);
  const received = readDate(receivedAt, `${where}.receivedAt`);
  if (received === null) return unexpected(`${where}: "receivedAt" is null`);
  return { id, code, status, receivedAt: received };
}

/**
 * `ProcurementService.getPo()` (procurement.service.ts lines 144–168) runs
 * `purchaseOrder.findFirst({ where, include: { vendor: true, project: { select:
 * { id, code, nameAr, nameEn } }, lines: { include: { item: { select: { sku,
 * nameAr, nameEn, isSerialised, uom } }, wbsElement } }, goodsReceipts: {
 * include, orderBy: { receivedAt: 'desc' } }, vendorBills } })` and returns
 * `{ ...po, pendingApproval }`:
 *  - id, code, status, createdAt, approvedAt: `model PurchaseOrder` lines
 *    952 / 955 / 960 / 967 / 965 (`approvedAt DateTime?` → ISO string or null)
 *  - vendor.{id, code, nameAr}: `vendor: true` is the full `Vendor` row
 *    (`model Vendor` lines 862–887: lines 863 / 866 / 867)
 *  - project: `{ id, code }` or null (`projectId String?`, line 958; select at
 *    service line 149)
 *  - lines[].itemId: `model PurchaseOrderLine` (lines 981–997) line 985;
 *    lines[].qty line 989 (`Decimal(14,3)` → string);
 *    lines[].item.{sku, nameAr, uom}: the `item` select at service line 152
 *    (`model Item`, schema lines 413+: sku 417, nameAr 418, uom 421)
 *  - goodsReceipts[].{id, code, status, receivedAt}: `model GoodsReceipt`
 *    (lines 1000–1029) lines 1001 / 1004 / 1010 / 1011 (`receivedAt DateTime
 *    @default(now())`, never null).
 * Permission: `scm.procurement.read`.
 */
export function readPurchaseOrder(body: unknown): NpiPurchaseOrderRow {
  const where = 'readPurchaseOrder';
  if (!isRecord(body)) return unexpected(`${where}: body is not an object`);
  const { id, code, status, createdAt, approvedAt, vendor, project, lines, goodsReceipts } = body;
  if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
  if (typeof code !== 'string') return unexpected(`${where}: missing/invalid "code"`);
  if (typeof status !== 'string') return unexpected(`${where}: missing/invalid "status"`);
  if (typeof createdAt !== 'string') return unexpected(`${where}: missing/invalid "createdAt"`);
  if (!isRecord(vendor)) return unexpected(`${where}: missing/invalid "vendor"`);
  if (typeof vendor.id !== 'string') return unexpected(`${where}: missing/invalid "vendor.id"`);
  if (typeof vendor.code !== 'string') return unexpected(`${where}: missing/invalid "vendor.code"`);
  if (typeof vendor.nameAr !== 'string') return unexpected(`${where}: missing/invalid "vendor.nameAr"`);
  if (!Array.isArray(lines)) return unexpected(`${where}: missing/invalid "lines"`);
  if (!Array.isArray(goodsReceipts)) return unexpected(`${where}: missing/invalid "goodsReceipts"`);

  let projectRow: NpiPurchaseOrderRow['project'] = null;
  if (project !== null && project !== undefined) {
    if (!isRecord(project)) return unexpected(`${where}: missing/invalid "project"`);
    if (typeof project.id !== 'string') return unexpected(`${where}: missing/invalid "project.id"`);
    if (typeof project.code !== 'string') return unexpected(`${where}: missing/invalid "project.code"`);
    projectRow = { id: project.id, code: project.code };
  }

  return {
    id,
    code,
    status,
    createdAt,
    approvedAt: readDate(approvedAt, `${where}.approvedAt`),
    vendor: { id: vendor.id, code: vendor.code, nameAr: vendor.nameAr },
    project: projectRow,
    lines: lines.map((line, index) => readLine(line, `${where}.lines[${index}]`)),
    goodsReceipts: goodsReceipts.map((receipt, index) => readReceipt(receipt, `${where}.goodsReceipts[${index}]`)),
  };
}

// ─── GET /projects ───────────────────────────────────────────────────────────

/**
 * `ProjectsService.list()` (apps/api/src/modules/projects/projects.service.ts
 * lines 43–58) runs `this.prisma.project.findMany({ where, include: { contract:
 * { select: { code, totalValue, customer: { select: { nameAr, nameEn } } } },
 * _count }, orderBy })`: the full `Project` row (`model Project`, schema lines
 * 890–925) plus includes:
 *  - id           line 891
 *  - code         line 894
 *  - nameAr       line 897
 *  - stage        line 899 (`ProjectStage`, enum lines 791–797)
 *  - capacityKwp  line 901 (`Decimal(12,3)?` → string or null)
 *  - plannedEnd   line 903 (`DateTime?` → ISO string or null)
 * `contract.code` and `contract.customer.nameAr` come from the `contract`
 * select (service lines 47–52). Permission: `projects.project.read`.
 */
export function readProjects(body: unknown): NpiProjectRow[] {
  if (!Array.isArray(body)) return unexpected('readProjects: body is not an array');
  return body.map((row, index) => {
    const where = `readProjects[${index}]`;
    if (!isRecord(row)) return unexpected(`${where}: element is not an object`);
    const { id, code, nameAr, stage, capacityKwp, plannedEnd, contract } = row;
    if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
    if (typeof code !== 'string') return unexpected(`${where}: missing/invalid "code"`);
    if (typeof nameAr !== 'string') return unexpected(`${where}: missing/invalid "nameAr"`);
    if (typeof stage !== 'string') return unexpected(`${where}: missing/invalid "stage"`);
    if (!isRecord(contract)) return unexpected(`${where}: missing/invalid "contract"`);
    if (typeof contract.code !== 'string') return unexpected(`${where}: missing/invalid "contract.code"`);
    if (!isRecord(contract.customer) || typeof contract.customer.nameAr !== 'string') {
      return unexpected(`${where}: missing/invalid "contract.customer.nameAr"`);
    }
    return {
      id,
      code,
      nameAr,
      stage,
      capacityKwp:
        capacityKwp === null || capacityKwp === undefined ? null : readAmount(capacityKwp, `${where}.capacityKwp`),
      plannedEnd: readDate(plannedEnd, `${where}.plannedEnd`),
      contract: { code: contract.code, customer: { nameAr: contract.customer.nameAr } },
    };
  });
}

// ─── The loader ──────────────────────────────────────────────────────────────

/** The five NPI reads a snapshot needs; every one returns `unknown`. */
export type SnapshotNpi = Pick<
  NpiClient,
  'listCustomers' | 'listContracts' | 'listPurchaseOrders' | 'getPurchaseOrder' | 'listProjects'
>;

const DEFAULT_MAX_PURCHASE_ORDERS = 60;

export interface SnapshotLoadOptions {
  /** Read only these sources; the others are reported as `not_requested`. */
  only?: readonly NpiMemorySource[];
  /** Cap on purchase orders fetched one by one (default 60, newest first). */
  maxPurchaseOrders?: number;
}

/** A `SnapshotLoad` plus how many single purchase-order fetches were skipped
 *  (refused, failed or unreadable) — the contract type has no slot for it. */
export interface SnapshotLoadDetail extends SnapshotLoad {
  skippedPurchaseOrders: number;
}

function createdAtMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

interface PurchaseOrdersRead {
  rows: NpiPurchaseOrderRow[];
  skipped: number;
}

async function readPurchaseOrders(npi: SnapshotNpi, maxPurchaseOrders: number): Promise<PurchaseOrdersRead> {
  const list = readPurchaseOrderList(await npi.listPurchaseOrders());
  // The list endpoint already orders by `createdAt desc`; a stable re-sort
  // keeps "the most recent" true even if that ever changes.
  const recent = list
    .filter((po) => po.status !== 'CANCELLED')
    .map((po, index) => ({ po, index }))
    .sort((a, b) => createdAtMs(b.po.createdAt) - createdAtMs(a.po.createdAt) || a.index - b.index)
    .slice(0, Math.max(0, maxPurchaseOrders))
    .map((entry) => entry.po);

  const rows: NpiPurchaseOrderRow[] = [];
  let skipped = 0;
  for (const po of recent) {
    try {
      rows.push(readPurchaseOrder(await npi.getPurchaseOrder(po.id)));
    } catch (err) {
      if (err instanceof NpiError) {
        skipped += 1;
        continue;
      }
      throw err; // a bug must not be swallowed
    }
  }
  return { rows, skipped };
}

/**
 * Loads the snapshot the derivation reads, as the logged-in user. Per source:
 * not requested → skipped; the user lacks the NPI permission → skipped without
 * a call; NPI answers 403 → `npi_refused`; any other `NpiError` (a network
 * failure, a 5xx, a reader's `unexpected`) → `npi_error`; anything that is not
 * an `NpiError` propagates. Nothing is retried.
 */
export async function loadNpiMemorySnapshot(
  npi: SnapshotNpi,
  caller: { permissions: readonly string[] },
  opts: SnapshotLoadOptions = {},
): Promise<SnapshotLoadDetail> {
  const snapshot: NpiMemorySnapshot = { customers: [], contracts: [], purchaseOrders: [], projects: [] };
  const sources = {} as Record<NpiMemorySource, SnapshotSourceOutcome>;
  let skippedPurchaseOrders = 0;

  for (const source of NPI_MEMORY_SOURCES) {
    if (opts.only && !opts.only.includes(source)) {
      sources[source] = { status: 'skipped', reason: 'not_requested' };
      continue;
    }
    if (!caller.permissions.includes(PERMISSION_OF_SOURCE[source])) {
      sources[source] = { status: 'skipped', reason: 'no_permission' };
      continue;
    }
    try {
      switch (source) {
        case 'customers':
          snapshot.customers = readCustomers(await npi.listCustomers());
          sources[source] = { status: 'read', rows: snapshot.customers.length };
          break;
        case 'contracts':
          snapshot.contracts = readContracts(await npi.listContracts());
          sources[source] = { status: 'read', rows: snapshot.contracts.length };
          break;
        case 'purchaseOrders': {
          const read = await readPurchaseOrders(npi, opts.maxPurchaseOrders ?? DEFAULT_MAX_PURCHASE_ORDERS);
          snapshot.purchaseOrders = read.rows;
          skippedPurchaseOrders += read.skipped;
          sources[source] = { status: 'read', rows: read.rows.length };
          break;
        }
        case 'projects':
          snapshot.projects = readProjects(await npi.listProjects());
          sources[source] = { status: 'read', rows: snapshot.projects.length };
          break;
      }
    } catch (err) {
      if (!(err instanceof NpiError)) throw err;
      sources[source] = { status: 'skipped', reason: err.status === 403 ? 'npi_refused' : 'npi_error' };
    }
  }

  return { snapshot, sources, skippedPurchaseOrders };
}
