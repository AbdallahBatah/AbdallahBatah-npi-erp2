import './helpers/load-env';
import { getDb } from '../src/db';
import {
  SOURCES_OF_FLOW,
  deriveNpiFacts,
  isStorableFact,
  latestNpiFactAt,
  refreshNpiMemory,
  shouldRefreshNpiMemory,
} from '../src/memory/extract-npi';
import {
  PERMISSION_OF_KIND,
  PERMISSION_OF_SOURCE,
  type NpiContractRow,
  type NpiCustomerRow,
  type NpiGoodsReceiptRow,
  type NpiMemorySnapshot,
  type NpiProjectRow,
  type NpiPurchaseOrderLine,
  type NpiPurchaseOrderRow,
} from '../src/memory/npi-facts';
import {
  loadNpiMemorySnapshot,
  readContracts,
  readCustomers,
  readProjects,
  readPurchaseOrder,
  readPurchaseOrderList,
  type SnapshotNpi,
} from '../src/memory/npi-snapshot';
import { retrieveFacts } from '../src/memory/retrieve';
import { saveFact } from '../src/memory/store';
import { NpiError } from '../src/npi/errors';
import { normalizeArabic } from '../src/text/normalize';

// The refresh tests run against the real local npi_copilot database. Every row
// written there carries one of this run's organization ids and is deleted in
// afterAll. Everything else uses hand-built snapshots and a fake NPI.
const db = getDb();
const runId = Math.random().toString(36).slice(2, 10);
const orgIds: string[] = [];

function newOrg(name: string): string {
  const id = `test-memory-npi-${runId}-${name}`;
  orgIds.push(id);
  return id;
}

afterAll(async () => {
  await db.memoryFact.deleteMany({ where: { npiOrgId: { in: orgIds } } });
  await db.$disconnect();
});

// ─── Wire fixtures: the shapes NPI's services return (see npi-snapshot.ts) ──

const T0 = '2026-01-01T00:00:00.000Z';

function wireCustomer(o: Record<string, unknown> = {}) {
  return {
    id: 'cus_00001',
    organizationId: 'org_npi',
    code: 'CUS-00001',
    nameAr: 'مصنع الرياض للصناعات',
    nameEn: 'Riyadh Industries Factory',
    customerType: 'CI',
    vatNumber: null,
    crNumber: null,
    creditTermsDays: 30,
    phone: null,
    email: null,
    createdAt: T0,
    updatedAt: T0,
    ...o,
  };
}

function wireContract(o: Record<string, unknown> = {}) {
  return {
    id: 'ctr_00001',
    organizationId: 'org_npi',
    code: 'CTR-00001',
    customerId: 'cus_00001',
    opportunityId: null,
    contractType: 'EPC',
    status: 'ACTIVE',
    startDate: '2026-02-01T00:00:00.000Z',
    endDate: null,
    currency: 'SAR',
    totalValue: '1200000',
    retentionPct: '5',
    advancePct: '10',
    createdAt: T0,
    updatedAt: T0,
    customer: { id: 'cus_00001', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh Industries Factory' },
    _count: { milestones: 3 },
    ...o,
  };
}

const WIRE_VENDOR_1 = {
  id: 'ven_00001',
  organizationId: 'org_npi',
  code: 'VEN-00001',
  nameAr: 'شركة الخليج للألواح الشمسية',
  nameEn: 'Gulf Solar Panels',
  vendorType: 'SUPPLIER',
  isManufacturer: false,
  createdAt: T0,
  updatedAt: T0,
};

function wirePoDetail(o: Record<string, unknown> = {}) {
  return {
    id: 'po_00001',
    organizationId: 'org_npi',
    code: 'PO-00001',
    vendorId: 'ven_00001',
    projectId: null,
    status: 'RECEIVED',
    currency: 'SAR',
    subtotal: '50000',
    vatAmount: '7500',
    total: '57500',
    approvedAt: '2026-01-05T00:00:00.000Z',
    approvedById: 'usr_1',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: T0,
    vendor: WIRE_VENDOR_1,
    project: null,
    lines: [
      {
        id: 'pol_1',
        purchaseOrderId: 'po_00001',
        itemId: 'itm_mod_550',
        qty: '100',
        unitPrice: '500',
        lineTotal: '50000',
        receivedQty: '100',
        item: { sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', nameEn: 'Solar Module 550 W', isSerialised: true, uom: 'unit' },
        wbsElement: null,
      },
    ],
    goodsReceipts: [
      { id: 'grn_1', code: 'GRN-00001', status: 'ACCEPTED', receivedAt: '2026-01-15T00:00:00.000Z', lines: [], serialUnits: [], vendorBills: [] },
    ],
    vendorBills: [],
    pendingApproval: null,
    ...o,
  };
}

function wirePoListRow(detail: ReturnType<typeof wirePoDetail>) {
  const { id, code, status, createdAt, approvedAt } = detail;
  return {
    id,
    code,
    status,
    createdAt,
    approvedAt,
    vendor: { code: 'VEN-00001', nameAr: 'شركة الخليج للألواح الشمسية', nameEn: 'Gulf Solar Panels' },
    project: null,
    _count: { goodsReceipts: detail.goodsReceipts.length },
  };
}

function wireProject(o: Record<string, unknown> = {}) {
  return {
    id: 'prj_00003',
    organizationId: 'org_npi',
    code: 'PRJ-00003',
    contractId: 'ctr_00001',
    nameAr: 'محطة مصنع الرياض الشمسية',
    nameEn: 'Riyadh Factory Solar Plant',
    stage: 'EXECUTION',
    siteRef: null,
    capacityKwp: '1250.5',
    plannedStart: null,
    plannedEnd: '2026-11-30T00:00:00.000Z',
    projectManagerId: null,
    createdAt: T0,
    updatedAt: T0,
    contract: {
      code: 'CTR-00001',
      totalValue: '1200000',
      customer: { nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh Industries Factory' },
    },
    _count: { purchaseOrders: 2, serialUnits: 0 },
    ...o,
  };
}

function npiError(status: number): NpiError {
  return new NpiError({ status, kind: status === 403 ? 'forbidden' : 'server', npiMessage: null });
}

/** Runs `fn`, expects an `unexpected` NpiError whose message names `field`. */
function expectUnexpected(fn: () => unknown, field: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(NpiError);
  expect((caught as NpiError).kind).toBe('unexpected');
  expect((caught as NpiError).message).toContain(field);
}

function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

// ─── readers ─────────────────────────────────────────────────────────────────

describe('readCustomers', () => {
  it('reads id, code, nameAr and the credit term off the full Customer row', () => {
    expect(readCustomers([wireCustomer(), wireCustomer({ id: 'cus_00002', code: 'CUS-00002', creditTermsDays: 0 })])).toEqual([
      { id: 'cus_00001', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', creditTermsDays: 30 },
      { id: 'cus_00002', code: 'CUS-00002', nameAr: 'مصنع الرياض للصناعات', creditTermsDays: 0 },
    ]);
  });

  it('rejects a body that is not an array and names the missing field', () => {
    expectUnexpected(() => readCustomers({}), 'readCustomers');
    expectUnexpected(() => readCustomers([null]), 'readCustomers[0]');
    expectUnexpected(() => readCustomers([without(wireCustomer(), 'id')]), '"id"');
    expectUnexpected(() => readCustomers([without(wireCustomer(), 'code')]), '"code"');
    expectUnexpected(() => readCustomers([without(wireCustomer(), 'nameAr')]), '"nameAr"');
    expectUnexpected(() => readCustomers([without(wireCustomer(), 'creditTermsDays')]), '"creditTermsDays"');
    expectUnexpected(() => readCustomers([wireCustomer({ creditTermsDays: '30' })]), '"creditTermsDays"');
  });
});

describe('readContracts', () => {
  it('parses Decimal strings, ISO dates, the customer select and _count.milestones', () => {
    const [row] = readContracts([wireContract({ totalValue: '1250000.5', retentionPct: '12.5', advancePct: '0' })]);
    expect(row).toEqual({
      id: 'ctr_00001',
      code: 'CTR-00001',
      status: 'ACTIVE',
      contractType: 'EPC',
      totalValue: 1250000.5,
      retentionPct: 12.5,
      advancePct: 0,
      startDate: '2026-02-01T00:00:00.000Z',
      endDate: null,
      customer: { id: 'cus_00001', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات' },
      milestoneCount: 3,
    });
  });

  it('rejects a missing field, naming it', () => {
    expectUnexpected(() => readContracts({}), 'readContracts');
    expectUnexpected(() => readContracts([without(wireContract(), 'status')]), '"status"');
    expectUnexpected(() => readContracts([without(wireContract(), 'contractType')]), '"contractType"');
    expectUnexpected(() => readContracts([without(wireContract(), '_count')]), '_count.milestones');
    expectUnexpected(() => readContracts([wireContract({ _count: { milestones: '3' } })]), '_count.milestones');
    expectUnexpected(() => readContracts([without(wireContract(), 'customer')]), '"customer"');
    expectUnexpected(() => readContracts([wireContract({ customer: { id: 'c', code: 'C' } })]), 'customer.nameAr');
    expectUnexpected(() => readContracts([wireContract({ totalValue: 'abc' })]), 'totalValue');
    expectUnexpected(() => readContracts([wireContract({ advancePct: null })]), 'advancePct');
    expectUnexpected(() => readContracts([wireContract({ startDate: 'not a date' })]), 'startDate');
    expectUnexpected(() => readContracts([wireContract({ endDate: 20260101 })]), 'endDate');
  });
});

describe('readPurchaseOrderList and readPurchaseOrder', () => {
  it('the list reader keeps only id, code, status and createdAt', () => {
    expect(readPurchaseOrderList([wirePoListRow(wirePoDetail())])).toEqual([
      { id: 'po_00001', code: 'PO-00001', status: 'RECEIVED', createdAt: '2026-01-02T00:00:00.000Z' },
    ]);
    expectUnexpected(() => readPurchaseOrderList({}), 'readPurchaseOrderList');
    expectUnexpected(() => readPurchaseOrderList([without(wirePoListRow(wirePoDetail()), 'status')]), '"status"');
    expectUnexpected(() => readPurchaseOrderList([without(wirePoListRow(wirePoDetail()), 'createdAt')]), '"createdAt"');
  });

  it('the detail reader takes the vendor row, the lines with their item and the receipts', () => {
    const row = readPurchaseOrder(wirePoDetail({ project: { id: 'prj_00003', code: 'PRJ-00003', nameAr: 'x', nameEn: 'y' } }));
    expect(row).toEqual({
      id: 'po_00001',
      code: 'PO-00001',
      status: 'RECEIVED',
      createdAt: '2026-01-02T00:00:00.000Z',
      approvedAt: '2026-01-05T00:00:00.000Z',
      vendor: { id: 'ven_00001', code: 'VEN-00001', nameAr: 'شركة الخليج للألواح الشمسية' },
      project: { id: 'prj_00003', code: 'PRJ-00003' },
      lines: [{ itemId: 'itm_mod_550', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', uom: 'unit', qty: 100 }],
      goodsReceipts: [{ id: 'grn_1', code: 'GRN-00001', status: 'ACCEPTED', receivedAt: '2026-01-15T00:00:00.000Z' }],
    });
  });

  it('reads a never-approved PO with no project and fractional quantities', () => {
    const detail = wirePoDetail({ approvedAt: null });
    detail.lines[0].qty = '12.5';
    const row = readPurchaseOrder(detail);
    expect(row.approvedAt).toBeNull();
    expect(row.project).toBeNull();
    expect(row.lines[0].qty).toBe(12.5);
  });

  it('rejects a missing field, naming it', () => {
    const base = wirePoDetail();
    expectUnexpected(() => readPurchaseOrder([]) , 'readPurchaseOrder');
    expectUnexpected(() => readPurchaseOrder(null), 'readPurchaseOrder');
    expectUnexpected(() => readPurchaseOrder(without(base, 'vendor')), '"vendor"');
    expectUnexpected(() => readPurchaseOrder({ ...base, vendor: { code: 'V', nameAr: 'n' } }), 'vendor.id');
    expectUnexpected(() => readPurchaseOrder({ ...base, vendor: { id: 'v', code: 'V' } }), 'vendor.nameAr');
    expectUnexpected(() => readPurchaseOrder(without(base, 'lines')), '"lines"');
    expectUnexpected(() => readPurchaseOrder(without(base, 'goodsReceipts')), '"goodsReceipts"');
    expectUnexpected(() => readPurchaseOrder(without(base, 'createdAt')), '"createdAt"');
    expectUnexpected(() => readPurchaseOrder({ ...base, approvedAt: 'yesterday' }), 'approvedAt');
    expectUnexpected(() => readPurchaseOrder({ ...base, lines: [{ itemId: 'i', qty: '1' }] }), 'lines[0]');
    expectUnexpected(() => readPurchaseOrder({ ...base, lines: [{ ...base.lines[0], qty: 'many' }] }), 'qty');
    expectUnexpected(() => readPurchaseOrder({ ...base, lines: [{ ...base.lines[0], item: { sku: 'S', nameAr: 'n' } }] }), 'item.uom');
    expectUnexpected(() => readPurchaseOrder({ ...base, project: { code: 'PRJ' } }), 'project.id');
  });

  it('a goods receipt with no receivedAt is unexpected, not zero days', () => {
    const base = wirePoDetail();
    expectUnexpected(
      () => readPurchaseOrder({ ...base, goodsReceipts: [{ ...base.goodsReceipts[0], receivedAt: null }] }),
      'receivedAt',
    );
    expectUnexpected(
      () => readPurchaseOrder({ ...base, goodsReceipts: [without(base.goodsReceipts[0], 'status')] }),
      'goodsReceipts[0]',
    );
  });
});

describe('readProjects', () => {
  it('parses capacity and planned end, and reaches the customer through the contract', () => {
    expect(readProjects([wireProject(), wireProject({ id: 'prj_2', capacityKwp: null, plannedEnd: null })])).toEqual([
      {
        id: 'prj_00003',
        code: 'PRJ-00003',
        nameAr: 'محطة مصنع الرياض الشمسية',
        stage: 'EXECUTION',
        capacityKwp: 1250.5,
        plannedEnd: '2026-11-30T00:00:00.000Z',
        contract: { code: 'CTR-00001', customer: { nameAr: 'مصنع الرياض للصناعات' } },
      },
      {
        id: 'prj_2',
        code: 'PRJ-00003',
        nameAr: 'محطة مصنع الرياض الشمسية',
        stage: 'EXECUTION',
        capacityKwp: null,
        plannedEnd: null,
        contract: { code: 'CTR-00001', customer: { nameAr: 'مصنع الرياض للصناعات' } },
      },
    ]);
  });

  it('rejects a missing field, naming it', () => {
    expectUnexpected(() => readProjects({}), 'readProjects');
    expectUnexpected(() => readProjects([without(wireProject(), 'stage')]), '"stage"');
    expectUnexpected(() => readProjects([without(wireProject(), 'nameAr')]), '"nameAr"');
    expectUnexpected(() => readProjects([without(wireProject(), 'contract')]), '"contract"');
    expectUnexpected(() => readProjects([wireProject({ contract: { code: 'C', customer: {} } })]), 'contract.customer.nameAr');
    expectUnexpected(() => readProjects([wireProject({ capacityKwp: 'big' })]), 'capacityKwp');
    expectUnexpected(() => readProjects([wireProject({ plannedEnd: 5 })]), 'plannedEnd');
  });
});

// ─── loader ──────────────────────────────────────────────────────────────────

const ALL_PERMISSIONS = Object.values(PERMISSION_OF_SOURCE);

interface Wire {
  customers: unknown;
  contracts: unknown;
  purchaseOrderList: unknown;
  purchaseOrders: Record<string, unknown>;
  projects: unknown;
}

type Fake = SnapshotNpi & {
  listCustomers: jest.Mock;
  listContracts: jest.Mock;
  listPurchaseOrders: jest.Mock;
  getPurchaseOrder: jest.Mock;
  listProjects: jest.Mock;
};

function fakeNpi(wire: Wire): Fake {
  return {
    listCustomers: jest.fn(async () => wire.customers),
    listContracts: jest.fn(async () => wire.contracts),
    listPurchaseOrders: jest.fn(async () => wire.purchaseOrderList),
    getPurchaseOrder: jest.fn(async (id: string) => {
      const body = wire.purchaseOrders[id];
      if (body instanceof Error) throw body;
      if (body === undefined) throw npiError(404);
      return body;
    }),
    listProjects: jest.fn(async () => wire.projects),
  } as Fake;
}

function baseWire(): Wire {
  const po1 = wirePoDetail();
  return {
    customers: [wireCustomer()],
    contracts: [wireContract()],
    purchaseOrderList: [wirePoListRow(po1)],
    purchaseOrders: { [po1.id]: po1 },
    projects: [wireProject()],
  };
}

describe('loadNpiMemorySnapshot', () => {
  it('reads every source for a caller who holds every permission', async () => {
    const npi = fakeNpi(baseWire());
    const load = await loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS });
    expect(load.sources).toEqual({
      customers: { status: 'read', rows: 1 },
      contracts: { status: 'read', rows: 1 },
      purchaseOrders: { status: 'read', rows: 1 },
      projects: { status: 'read', rows: 1 },
    });
    expect(load.snapshot.customers[0].creditTermsDays).toBe(30);
    expect(load.snapshot.purchaseOrders[0].vendor.id).toBe('ven_00001');
    expect(load.skippedPurchaseOrders).toBe(0);
  });

  it('skips a source the caller has no permission for and makes no call for it', async () => {
    const npi = fakeNpi(baseWire());
    const permissions = ALL_PERMISSIONS.filter((p) => p !== 'commercial.contract.read' && p !== 'scm.procurement.read');
    const load = await loadNpiMemorySnapshot(npi, { permissions });
    expect(load.sources.contracts).toEqual({ status: 'skipped', reason: 'no_permission' });
    expect(load.sources.purchaseOrders).toEqual({ status: 'skipped', reason: 'no_permission' });
    expect(load.sources.customers.status).toBe('read');
    expect(npi.listContracts).not.toHaveBeenCalled();
    expect(npi.listPurchaseOrders).not.toHaveBeenCalled();
    expect(npi.getPurchaseOrder).not.toHaveBeenCalled();
    expect(load.snapshot.contracts).toEqual([]);
    expect(load.snapshot.purchaseOrders).toEqual([]);
  });

  it('a caller with no permissions at all makes no NPI call', async () => {
    const npi = fakeNpi(baseWire());
    const load = await loadNpiMemorySnapshot(npi, { permissions: [] });
    expect(Object.values(load.sources).every((s) => s.status === 'skipped')).toBe(true);
    for (const method of [npi.listCustomers, npi.listContracts, npi.listPurchaseOrders, npi.getPurchaseOrder, npi.listProjects]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('403 → npi_refused; any other NpiError (including a reader unexpected) → npi_error; the others still read', async () => {
    const wire = baseWire();
    const npi = fakeNpi(wire);
    npi.listCustomers.mockRejectedValue(npiError(403));
    npi.listContracts.mockRejectedValue(npiError(500));
    wire.projects = { not: 'an array' };
    const load = await loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS });
    expect(load.sources.customers).toEqual({ status: 'skipped', reason: 'npi_refused' });
    expect(load.sources.contracts).toEqual({ status: 'skipped', reason: 'npi_error' });
    expect(load.sources.projects).toEqual({ status: 'skipped', reason: 'npi_error' });
    expect(load.sources.purchaseOrders.status).toBe('read');
    expect(npi.listCustomers).toHaveBeenCalledTimes(1); // never retried
    expect(npi.listContracts).toHaveBeenCalledTimes(1);
  });

  it('a failure that is not an NpiError propagates', async () => {
    const npi = fakeNpi(baseWire());
    npi.listContracts.mockRejectedValue(new TypeError('bug'));
    await expect(loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS })).rejects.toThrow(TypeError);

    const npi2 = fakeNpi(baseWire());
    npi2.getPurchaseOrder.mockRejectedValue(new RangeError('bug in one fetch'));
    await expect(loadNpiMemorySnapshot(npi2, { permissions: ALL_PERMISSIONS })).rejects.toThrow(RangeError);
  });

  it('only: reads the named sources and reports the rest as not_requested', async () => {
    const npi = fakeNpi(baseWire());
    const load = await loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS }, { only: ['customers', 'projects'] });
    expect(load.sources.customers.status).toBe('read');
    expect(load.sources.projects.status).toBe('read');
    expect(load.sources.contracts).toEqual({ status: 'skipped', reason: 'not_requested' });
    expect(load.sources.purchaseOrders).toEqual({ status: 'skipped', reason: 'not_requested' });
    expect(npi.listContracts).not.toHaveBeenCalled();
    expect(npi.listPurchaseOrders).not.toHaveBeenCalled();
  });

  it('only: a requested source the caller cannot read is no_permission, not not_requested', async () => {
    const npi = fakeNpi(baseWire());
    const load = await loadNpiMemorySnapshot(npi, { permissions: [] }, { only: ['customers'] });
    expect(load.sources.customers).toEqual({ status: 'skipped', reason: 'no_permission' });
    expect(load.sources.contracts).toEqual({ status: 'skipped', reason: 'not_requested' });
  });

  describe('purchase orders: the cap and the single fetch', () => {
    function manyOrders(live: number) {
      const wire = baseWire();
      const rows: unknown[] = [];
      const details: Record<string, unknown> = {};
      const mk = (id: string, daysAgo: number, status: string) => {
        const createdAt = new Date(Date.UTC(2026, 5, 1) - daysAgo * 86_400_000).toISOString();
        const detail = wirePoDetail({ id, code: id.toUpperCase().replace('_', '-'), status, createdAt });
        rows.push(wirePoListRow(detail));
        details[id] = detail;
      };
      mk('po_c1', 0, 'CANCELLED'); // the two newest are cancelled
      mk('po_c2', 1, 'CANCELLED');
      for (let i = 0; i < live; i += 1) mk(`po_${String(i).padStart(3, '0')}`, i + 2, 'RECEIVED');
      wire.purchaseOrderList = rows;
      wire.purchaseOrders = details;
      return wire;
    }

    it('drops CANCELLED before the cap, then fetches only the 60 newest, newest first', async () => {
      const npi = fakeNpi(manyOrders(61));
      const load = await loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS });
      const fetched = npi.getPurchaseOrder.mock.calls.map((c) => c[0]);
      expect(fetched).toHaveLength(60);
      expect(fetched[0]).toBe('po_000');
      expect(fetched[59]).toBe('po_059');
      expect(fetched).not.toContain('po_060'); // the 61st live order
      expect(fetched).not.toContain('po_c1');
      expect(fetched).not.toContain('po_c2');
      expect(load.sources.purchaseOrders).toEqual({ status: 'read', rows: 60 });
      expect(load.snapshot.purchaseOrders).toHaveLength(60);
    });

    it('maxPurchaseOrders lowers the cap', async () => {
      const npi = fakeNpi(manyOrders(10));
      const load = await loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS }, { maxPurchaseOrders: 3 });
      expect(npi.getPurchaseOrder).toHaveBeenCalledTimes(3);
      expect(load.snapshot.purchaseOrders.map((p) => p.id)).toEqual(['po_000', 'po_001', 'po_002']);
    });

    it('fetches strictly one at a time', async () => {
      const npi = fakeNpi(manyOrders(6));
      let inFlight = 0;
      let peak = 0;
      const inner = npi.getPurchaseOrder.getMockImplementation()!;
      npi.getPurchaseOrder.mockImplementation(async (id: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          return await inner(id);
        } finally {
          inFlight -= 1;
        }
      });
      await loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS });
      expect(npi.getPurchaseOrder).toHaveBeenCalledTimes(6);
      expect(peak).toBe(1);
    });

    it('one refused, failed or unreadable fetch skips just that order and the source still reads', async () => {
      const wire = manyOrders(5);
      wire.purchaseOrders.po_001 = npiError(403);
      wire.purchaseOrders.po_002 = npiError(500);
      wire.purchaseOrders.po_003 = { id: 'po_003' }; // a reader unexpected
      const npi = fakeNpi(wire);
      const load = await loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS });
      expect(load.snapshot.purchaseOrders.map((p) => p.id)).toEqual(['po_000', 'po_004']);
      expect(load.sources.purchaseOrders).toEqual({ status: 'read', rows: 2 });
      expect(load.skippedPurchaseOrders).toBe(3);
      expect(npi.getPurchaseOrder).toHaveBeenCalledTimes(5); // no retry
    });

    it('a refused list read is npi_refused for the source', async () => {
      const wire = manyOrders(2);
      const npi = fakeNpi(wire);
      npi.listPurchaseOrders.mockRejectedValue(npiError(403));
      const load = await loadNpiMemorySnapshot(npi, { permissions: ALL_PERMISSIONS });
      expect(load.sources.purchaseOrders).toEqual({ status: 'skipped', reason: 'npi_refused' });
      expect(npi.getPurchaseOrder).not.toHaveBeenCalled();
    });
  });
});

// ─── derivation ──────────────────────────────────────────────────────────────

const CUS1: NpiCustomerRow = { id: 'cus_00001', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', creditTermsDays: 30 };
const VEN1 = { id: 'ven_00001', code: 'VEN-00001', nameAr: 'شركة الخليج للألواح الشمسية' };
const VEN2 = { id: 'ven_00002', code: 'VEN-00002', nameAr: 'مؤسسة الواحة للكابلات' };

function empty(over: Partial<NpiMemorySnapshot> = {}): NpiMemorySnapshot {
  return { customers: [], contracts: [], purchaseOrders: [], projects: [], ...over };
}

function contract(over: Partial<NpiContractRow> = {}): NpiContractRow {
  return {
    id: 'ctr_00001',
    code: 'CTR-00001',
    status: 'ACTIVE',
    contractType: 'EPC',
    totalValue: 1_200_000,
    retentionPct: 5,
    advancePct: 10,
    startDate: '2026-02-01T00:00:00.000Z',
    endDate: null,
    customer: { id: CUS1.id, code: CUS1.code, nameAr: CUS1.nameAr },
    milestoneCount: 3,
    ...over,
  };
}

function line(over: Partial<NpiPurchaseOrderLine> = {}): NpiPurchaseOrderLine {
  return { itemId: 'itm_mod_550', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', uom: 'unit', qty: 100, ...over };
}

function receipt(receivedAt: string, id = 'grn_1'): NpiGoodsReceiptRow {
  return { id, code: id.toUpperCase().replace('_', '-'), status: 'ACCEPTED', receivedAt };
}

function po(over: Partial<NpiPurchaseOrderRow> = {}): NpiPurchaseOrderRow {
  return {
    id: 'po_00001',
    code: 'PO-00001',
    status: 'RECEIVED',
    createdAt: '2026-01-02T00:00:00.000Z',
    approvedAt: '2026-01-05T00:00:00.000Z',
    vendor: VEN1,
    project: null,
    lines: [line()],
    goodsReceipts: [receipt('2026-01-15T00:00:00.000Z')],
    ...over,
  };
}

function project(over: Partial<NpiProjectRow> = {}): NpiProjectRow {
  return {
    id: 'prj_00003',
    code: 'PRJ-00003',
    nameAr: 'محطة مصنع الرياض الشمسية',
    stage: 'EXECUTION',
    capacityKwp: 1250.5,
    plannedEnd: '2026-11-30T00:00:00.000Z',
    contract: { code: 'CTR-00001', customer: { nameAr: 'مصنع الرياض للصناعات' } },
    ...over,
  };
}

function only(snapshot: NpiMemorySnapshot, kind: string) {
  return deriveNpiFacts(snapshot).filter((f) => f.kind === kind);
}

describe('deriveNpiFacts: customer_credit_terms', () => {
  it('writes the exact sentence for the seed customer (30 days)', () => {
    const [fact] = only(empty({ customers: [CUS1] }), 'customer_credit_terms');
    expect(fact.factAr).toBe('أجل سداد العميل مصنع الرياض للصناعات (CUS-00001) 30 يوماً من تاريخ الفاتورة.');
    expect(fact).toMatchObject({
      key: 'customer_credit_terms:cus_00001',
      entityType: 'customer',
      npiEntityId: 'cus_00001',
      confidence: 1,
      valueJson: {
        kind: 'customer_credit_terms',
        key: 'customer_credit_terms:cus_00001',
        customerId: 'cus_00001',
        code: 'CUS-00001',
        creditTermsDays: 30,
      },
    });
  });

  it.each([
    [1, 'يوم واحد'],
    [2, 'يومان'],
    [3, '3 أيام'],
    [10, '10 أيام'],
    [11, '11 يوماً'],
    [45, '45 يوماً'],
    [120, '120 يوماً'],
  ])('%i days is written «%s»', (days, words) => {
    const [fact] = only(empty({ customers: [{ ...CUS1, creditTermsDays: days }] }), 'customer_credit_terms');
    expect(fact.factAr).toBe(`أجل سداد العميل مصنع الرياض للصناعات (CUS-00001) ${words} من تاريخ الفاتورة.`);
  });

  it('omits a customer with no credit term, and one with no name', () => {
    const facts = only(
      empty({
        customers: [
          { ...CUS1, id: 'c0', creditTermsDays: 0 },
          { ...CUS1, id: 'c1', nameAr: '  ' },
          { ...CUS1, id: 'c2', creditTermsDays: 15 },
        ],
      }),
      'customer_credit_terms',
    );
    expect(facts.map((f) => f.key)).toEqual(['customer_credit_terms:c2']);
  });
});

describe('deriveNpiFacts: contract_payment_terms', () => {
  it('writes the exact sentence for an active EPC contract', () => {
    const [fact] = only(empty({ contracts: [contract()] }), 'contract_payment_terms');
    expect(fact.factAr).toBe(
      'شروط عقد CTR-00001 مع العميل مصنع الرياض للصناعات (CUS-00001): دفعة مقدمة 10%، محتجزات 5%، 3 دفعات مرحلية، القيمة 1,200,000 ريال، النوع تصميم وتوريد وتركيب، الحالة ساري.',
    );
    expect(fact).toMatchObject({
      key: 'contract_payment_terms:ctr_00001',
      entityType: 'customer',
      npiEntityId: 'cus_00001',
      confidence: 1,
      valueJson: {
        kind: 'contract_payment_terms',
        key: 'contract_payment_terms:ctr_00001',
        contractId: 'ctr_00001',
        contractCode: 'CTR-00001',
        customerId: 'cus_00001',
        customerCode: 'CUS-00001',
        advancePct: 10,
        retentionPct: 5,
        milestoneCount: 3,
        totalValue: 1_200_000,
        contractType: 'EPC',
        status: 'ACTIVE',
        startDate: '2026-02-01T00:00:00.000Z',
        endDate: null,
      },
    });
  });

  it('a draft PPA contract with 12.5% retention, a fractional value and no milestones; confidence 0.8', () => {
    const [fact] = only(
      empty({
        contracts: [
          contract({ id: 'c2', code: 'CTR-00002', status: 'DRAFT', contractType: 'PPA', advancePct: 0, retentionPct: 12.5, totalValue: 450_000.5, milestoneCount: 0 }),
        ],
      }),
      'contract_payment_terms',
    );
    expect(fact.factAr).toBe(
      'شروط عقد CTR-00002 مع العميل مصنع الرياض للصناعات (CUS-00001): دفعة مقدمة 0%، محتجزات 12.5%، بلا دفعات مرحلية، القيمة 450,000.5 ريال، النوع بيع طاقة، الحالة مسودة.',
    );
    expect(fact.confidence).toBe(0.8);
  });

  it('a value with float noise is rounded to two decimals', () => {
    const [fact] = only(empty({ contracts: [contract({ totalValue: 100.1 + 0.2 })] }), 'contract_payment_terms');
    expect(fact.factAr).toContain('القيمة 100.3 ريال');
  });

  it.each([
    [1, 'دفعة مرحلية واحدة'],
    [2, 'دفعتان مرحليتان'],
    [6, '6 دفعات مرحلية'],
    [12, '12 دفعة مرحلية'],
  ])('%i milestones is written «%s»', (n, words) => {
    const [fact] = only(empty({ contracts: [contract({ milestoneCount: n })] }), 'contract_payment_terms');
    expect(fact.factAr).toContain(`محتجزات 5%، ${words}، القيمة`);
  });

  it.each([
    ['OM', 'SUSPENDED', 'تشغيل وصيانة', 'موقوف', 0.9],
    ['LEASE', 'CLOSED', 'تأجير', 'مقفل', 0.9],
  ])('type %s / status %s is written in Arabic with confidence %s', (type, status, typeAr, statusAr, confidence) => {
    const [fact] = only(empty({ contracts: [contract({ contractType: type, status })] }), 'contract_payment_terms');
    expect(fact.factAr).toContain(`النوع ${typeAr}، الحالة ${statusAr}.`);
    expect(fact.confidence).toBe(confidence);
  });

  it('an unknown type or status is written as NPI sends it', () => {
    const [fact] = only(empty({ contracts: [contract({ contractType: 'XYZ', status: 'ODD' })] }), 'contract_payment_terms');
    expect(fact.factAr).toContain('النوع XYZ، الحالة ODD.');
  });

  it('omits a CANCELLED contract', () => {
    expect(only(empty({ contracts: [contract({ status: 'CANCELLED' })] }), 'contract_payment_terms')).toEqual([]);
  });
});

describe('deriveNpiFacts: vendor_lead_time', () => {
  it('writes the exact sentence for a vendor with 2 purchase orders (the first receipt counts)', () => {
    const facts = only(
      empty({
        purchaseOrders: [
          // 2026-01-05 → first receipt 2026-01-15 (the later one is listed first on purpose) = 10 days
          po({ goodsReceipts: [receipt('2026-01-20T00:00:00.000Z', 'grn_2'), receipt('2026-01-15T00:00:00.000Z', 'grn_1')] }),
          // 2026-02-03 → 2026-02-17 = 14 days
          po({
            id: 'po_00002',
            code: 'PO-00002',
            createdAt: '2026-02-01T00:00:00.000Z',
            approvedAt: '2026-02-03T00:00:00.000Z',
            goodsReceipts: [receipt('2026-02-17T00:00:00.000Z', 'grn_3')],
          }),
        ],
      }),
      'vendor_lead_time',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].factAr).toBe(
      'مدة توريد المورّد شركة الخليج للألواح الشمسية (VEN-00001) نحو 12 يوماً من اعتماد أمر الشراء إلى أول استلام، بحسب أمري شراء.',
    );
    expect(facts[0]).toMatchObject({
      key: 'vendor_lead_time:ven_00001',
      entityType: 'vendor',
      npiEntityId: 'ven_00001',
      confidence: 0.8,
      valueJson: {
        kind: 'vendor_lead_time',
        key: 'vendor_lead_time:ven_00001',
        vendorId: 'ven_00001',
        vendorCode: 'VEN-00001',
        avgDays: 12,
        sampleSize: 2,
        poCodes: ['PO-00001', 'PO-00002'],
      },
    });
  });

  it('three orders: 3 «أوامر شراء», confidence 0.9, average rounded', () => {
    const orders = [
      po({ id: 'a', code: 'PO-00031', approvedAt: '2026-01-01T00:00:00.000Z', goodsReceipts: [receipt('2026-01-11T00:00:00.000Z')] }), // 10
      po({ id: 'b', code: 'PO-00030', approvedAt: '2026-01-01T00:00:00.000Z', goodsReceipts: [receipt('2026-01-15T00:00:00.000Z')] }), // 14
      po({ id: 'c', code: 'PO-00032', approvedAt: '2026-01-01T00:00:00.000Z', goodsReceipts: [receipt('2026-01-07T00:00:00.000Z')] }), // 6
    ];
    const [fact] = only(empty({ purchaseOrders: orders }), 'vendor_lead_time');
    expect(fact.factAr).toBe(
      'مدة توريد المورّد شركة الخليج للألواح الشمسية (VEN-00001) نحو 10 أيام من اعتماد أمر الشراء إلى أول استلام، بحسب 3 أوامر شراء.',
    );
    expect(fact.confidence).toBe(0.9);
    expect(fact.valueJson.poCodes).toEqual(['PO-00030', 'PO-00031', 'PO-00032']);
  });

  it('a never-approved order is measured from its creation; one order gives confidence 0.6', () => {
    const [fact] = only(
      empty({
        purchaseOrders: [
          po({ vendor: VEN2, approvedAt: null, createdAt: '2026-03-01T00:00:00.000Z', goodsReceipts: [receipt('2026-03-11T00:00:00.000Z')] }),
        ],
      }),
      'vendor_lead_time',
    );
    expect(fact.factAr).toBe(
      'مدة توريد المورّد مؤسسة الواحة للكابلات (VEN-00002) نحو 10 أيام من اعتماد أمر الشراء إلى أول استلام، بحسب أمر شراء واحد.',
    );
    expect(fact.confidence).toBe(0.6);
  });

  it('a receipt dated before the approval counts as 0 days', () => {
    const [fact] = only(
      empty({ purchaseOrders: [po({ approvedAt: '2026-04-05T00:00:00.000Z', goodsReceipts: [receipt('2026-04-03T00:00:00.000Z')] })] }),
      'vendor_lead_time',
    );
    expect(fact.valueJson.avgDays).toBe(0);
    expect(fact.factAr).toContain(') أقل من يوم من اعتماد');
    expect(fact.factAr).not.toContain('نحو');
  });

  it('a PO with no receipt, a CANCELLED PO and a PO with no lines behave', () => {
    const facts = only(
      empty({
        purchaseOrders: [
          po({ id: 'norcpt', code: 'PO-00040', goodsReceipts: [] }),
          po({ id: 'cancelled', code: 'PO-00041', status: 'CANCELLED', vendor: VEN2 }),
          po({ id: 'nolines', code: 'PO-00042', lines: [] }), // still a measurable lead time
        ],
      }),
      'vendor_lead_time',
    );
    expect(facts.map((f) => f.key)).toEqual(['vendor_lead_time:ven_00001']);
    expect(facts[0].valueJson.sampleSize).toBe(1);
    expect(facts[0].valueJson.poCodes).toEqual(['PO-00042']);
  });
});

describe('deriveNpiFacts: recurring_item', () => {
  const orders = [
    po({ id: 'po_a', code: 'PO-00011', createdAt: '2026-01-10T00:00:00.000Z', vendor: VEN1, lines: [line({ qty: 100 }), line({ itemId: 'itm_cab_lv6', sku: 'CAB-LV6', nameAr: 'كابل جهد منخفض', uom: 'm', qty: 12.5 })] }),
    po({
      id: 'po_b',
      code: 'PO-00012',
      createdAt: '2026-02-10T00:00:00.000Z',
      vendor: VEN2,
      lines: [line({ qty: 60 }), line({ itemId: 'itm_cab_lv6', sku: 'CAB-LV6', nameAr: 'كابل جهد منخفض', uom: 'm', qty: 10 }), line({ itemId: 'itm_bos', sku: 'BOS-KIT', nameAr: 'طقم مكونات مساعدة', uom: 'set', qty: 1 })],
    }),
    po({ id: 'po_c', code: 'PO-00013', createdAt: '2026-03-10T00:00:00.000Z', vendor: VEN1, lines: [line({ itemId: 'itm_cab_lv6', sku: 'CAB-LV6', nameAr: 'كابل جهد منخفض', uom: 'm', qty: 5 })] }),
    po({ id: 'po_d', code: 'PO-00014', status: 'CANCELLED', createdAt: '2026-04-10T00:00:00.000Z', vendor: VEN2, lines: [line({ itemId: 'itm_bos', sku: 'BOS-KIT', nameAr: 'طقم مكونات مساعدة', uom: 'set', qty: 4 })] }),
  ].map((p) => ({ ...p, goodsReceipts: [] }));

  it('writes the exact sentences; the latest order names the vendor; a one-order and a cancelled-only item are not recurring', () => {
    const facts = only(empty({ purchaseOrders: orders }), 'recurring_item');
    expect(facts.map((f) => f.key)).toEqual(['recurring_item:itm_cab_lv6', 'recurring_item:itm_mod_550']);
    expect(facts[0].factAr).toBe(
      'الصنف كابل جهد منخفض (CAB-LV6) يُطلب بانتظام: ورد في 3 أوامر شراء بإجمالي 27.5 متر، آخرها من المورّد شركة الخليج للألواح الشمسية.',
    );
    expect(facts[1].factAr).toBe(
      'الصنف لوح شمسي 550 واط (MOD-550) يُطلب بانتظام: ورد في أمري شراء بإجمالي 160 وحدة، آخرها من المورّد مؤسسة الواحة للكابلات.',
    );
    expect(facts[1]).toMatchObject({
      entityType: 'item',
      npiEntityId: 'itm_mod_550',
      confidence: 0.9,
      valueJson: {
        kind: 'recurring_item',
        key: 'recurring_item:itm_mod_550',
        itemId: 'itm_mod_550',
        sku: 'MOD-550',
        poCount: 2,
        totalQty: 160,
        uom: 'unit',
        vendorIds: ['ven_00001', 'ven_00002'],
        lastVendorId: 'ven_00002',
      },
    });
  });

  it('the same item twice on one order is one order, not a recurrence', () => {
    const facts = only(empty({ purchaseOrders: [po({ lines: [line(), line()] })] }), 'recurring_item');
    expect(facts).toEqual([]);
  });

  it('does not depend on the order of the list', () => {
    const forward = only(empty({ purchaseOrders: orders }), 'recurring_item').map((f) => f.factAr);
    const backward = only(empty({ purchaseOrders: [...orders].reverse() }), 'recurring_item').map((f) => f.factAr);
    expect(backward).toEqual(forward);
  });

  it('a unit of measure outside the mapping is written as NPI sends it', () => {
    const two = [po({ id: 'x', lines: [line({ uom: 'roll', qty: 2 })] }), po({ id: 'y', code: 'PO-00002', lines: [line({ uom: 'roll', qty: 3 })] })];
    const [fact] = only(empty({ purchaseOrders: two }), 'recurring_item');
    expect(fact.factAr).toContain('بإجمالي 5 roll،');
  });
});

describe('deriveNpiFacts: active_project', () => {
  it('writes the exact sentence with capacity and planned end', () => {
    const [fact] = only(empty({ projects: [project()] }), 'active_project');
    expect(fact.factAr).toBe(
      'المشروع محطة مصنع الرياض الشمسية (PRJ-00003) للعميل مصنع الرياض للصناعات ضمن العقد CTR-00001 في مرحلة التنفيذ، بقدرة 1,250.5 كيلوواط ذروة، ونهايته المخططة 2026-11-30.',
    );
    expect(fact).toMatchObject({
      key: 'active_project:prj_00003',
      entityType: 'project',
      npiEntityId: 'prj_00003',
      confidence: 1,
      valueJson: {
        kind: 'active_project',
        key: 'active_project:prj_00003',
        projectId: 'prj_00003',
        code: 'PRJ-00003',
        stage: 'EXECUTION',
        customerNameAr: 'مصنع الرياض للصناعات',
        contractCode: 'CTR-00001',
        capacityKwp: 1250.5,
        plannedEnd: '2026-11-30T00:00:00.000Z',
      },
    });
  });

  it('leaves out the capacity and end clauses when they are missing (or zero)', () => {
    const [none] = only(empty({ projects: [project({ stage: 'PLANNING', capacityKwp: null, plannedEnd: null })] }), 'active_project');
    expect(none.factAr).toBe('المشروع محطة مصنع الرياض الشمسية (PRJ-00003) للعميل مصنع الرياض للصناعات ضمن العقد CTR-00001 في مرحلة التخطيط.');
    const [zero] = only(empty({ projects: [project({ stage: 'COMMISSIONING', capacityKwp: 0 })] }), 'active_project');
    expect(zero.factAr).toBe(
      'المشروع محطة مصنع الرياض الشمسية (PRJ-00003) للعميل مصنع الرياض للصناعات ضمن العقد CTR-00001 في مرحلة التشغيل التجريبي، ونهايته المخططة 2026-11-30.',
    );
    const [capOnly] = only(empty({ projects: [project({ stage: 'PROCUREMENT', plannedEnd: null, capacityKwp: 500 })] }), 'active_project');
    expect(capOnly.factAr).toBe(
      'المشروع محطة مصنع الرياض الشمسية (PRJ-00003) للعميل مصنع الرياض للصناعات ضمن العقد CTR-00001 في مرحلة التوريد، بقدرة 500 كيلوواط ذروة.',
    );
  });

  it('omits a CLOSED project', () => {
    expect(only(empty({ projects: [project({ stage: 'CLOSED' })] }), 'active_project')).toEqual([]);
  });
});

describe('deriveNpiFacts: the whole output', () => {
  const full: NpiMemorySnapshot = {
    customers: [
      CUS1,
      { id: 'cus_00002', code: 'CUS-00002', nameAr: 'شركة النخيل للمقاولات', creditTermsDays: 45 },
      { id: 'cus_00003', code: 'CUS-00003', nameAr: 'مؤسسة بلا أجل', creditTermsDays: 0 },
    ],
    contracts: [
      contract(),
      contract({ id: 'ctr_00002', code: 'CTR-00002', status: 'DRAFT', contractType: 'OM', milestoneCount: 0 }),
      contract({ id: 'ctr_00003', code: 'CTR-00003', status: 'CANCELLED' }),
    ],
    purchaseOrders: [
      po({ lines: [line(), line({ itemId: 'itm_cab_lv6', sku: 'CAB-LV6', nameAr: 'كابل جهد منخفض', uom: 'm', qty: 12.5 }), line({ itemId: 'itm_bos', sku: 'BOS-KIT', nameAr: 'طقم مكونات مساعدة', uom: 'set', qty: 3 })] }),
      po({
        id: 'po_00002',
        code: 'PO-00002',
        createdAt: '2026-02-01T00:00:00.000Z',
        approvedAt: null,
        vendor: VEN2,
        lines: [line({ qty: 40 }), line({ itemId: 'itm_bos', sku: 'BOS-KIT', nameAr: 'طقم مكونات مساعدة', uom: 'set', qty: 2 })],
        goodsReceipts: [receipt('2026-02-11T00:00:00.000Z', 'grn_9')],
      }),
      po({ id: 'po_00003', code: 'PO-00003', status: 'CANCELLED', lines: [] }),
    ],
    projects: [
      project(),
      project({ id: 'prj_00004', code: 'PRJ-00004', stage: 'PLANNING', capacityKwp: null, plannedEnd: null }),
      project({ id: 'prj_00005', code: 'PRJ-00005', stage: 'CLOSED' }),
    ],
  };

  it('covers all five kinds, sorted by key, keys unique and equal to valueJson.key', () => {
    const facts = deriveNpiFacts(full);
    const keys = facts.map((f) => f.key);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(facts.map((f) => f.kind))).toEqual(
      new Set(['customer_credit_terms', 'contract_payment_terms', 'vendor_lead_time', 'recurring_item', 'active_project']),
    );
    for (const f of facts) {
      expect(f.valueJson.key).toBe(f.key);
      expect(f.valueJson.kind).toBe(f.kind);
      expect(f.key.startsWith(`${f.kind}:`)).toBe(true);
    }
    // 2 credit terms + 2 contracts + 2 vendors + 2 items (MOD-550, BOS-KIT) + 2 projects
    expect(facts).toHaveLength(10);
  });

  it('every sentence is storable, ends with a full stop and has no double space', () => {
    for (const f of deriveNpiFacts(full)) {
      expect(isStorableFact(f)).toBe(true);
      expect(f.factAr.endsWith('.')).toBe(true);
      expect(f.factAr).not.toMatch(/\s{2,}/);
      expect(f.factAr).toBe(f.factAr.trim());
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('has no Latin letters outside document codes and SKUs', () => {
    const skus = new Set(['MOD-550', 'CAB-LV6', 'BOS-KIT']);
    for (const f of deriveNpiFacts(full)) {
      let text = f.factAr.replaceAll(/[A-Z]{2,4}-\d{3,5}/g, '');
      for (const token of text.match(/[A-Z0-9-]+/g) ?? []) {
        if (skus.has(token)) text = text.replace(token, '');
      }
      expect(text).not.toMatch(/[A-Za-z]/);
    }
  });

  it('is pure: the same snapshot gives the same facts and the input is not changed', () => {
    const before = JSON.stringify(full);
    expect(deriveNpiFacts(full)).toEqual(deriveNpiFacts(full));
    expect(JSON.stringify(full)).toBe(before);
  });

  it('never throws on odd data: empty snapshot, rows with no names, unreadable dates, duplicate ids', () => {
    expect(deriveNpiFacts(empty())).toEqual([]);
    const odd = empty({
      customers: [{ ...CUS1, nameAr: '' }, CUS1, CUS1],
      contracts: [contract({ customer: { id: 'c', code: 'C', nameAr: ' ' } })],
      purchaseOrders: [
        po({ goodsReceipts: [receipt('garbage')] }),
        po({ id: 'p2', approvedAt: 'garbage', goodsReceipts: [receipt('2026-01-15T00:00:00.000Z')] }),
        po({ id: 'p3', lines: [], goodsReceipts: [] }),
      ],
      projects: [project({ nameAr: '' }), project({ contract: { code: 'C', customer: { nameAr: '' } } })],
    });
    const facts = deriveNpiFacts(odd);
    // The three odd orders all carry MOD-550, so the item is (rightly) recurring;
    // no lead time derives (one receipt date and one approval date are unreadable,
    // the third order has no receipt) and every nameless row is skipped.
    expect(facts.map((f) => f.key)).toEqual(['customer_credit_terms:cus_00001', 'recurring_item:itm_mod_550']);
  });
});

// ─── policy ──────────────────────────────────────────────────────────────────

describe('shouldRefreshNpiMemory', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it.each([
    ['no facts and no attempt', null, null, true],
    ['facts 25 h old and no attempt', ago(25), null, true],
    ['facts 25 h old, last attempt 2 h ago', ago(25), ago(2), true],
    ['facts 25 h old, last attempt 30 min ago', ago(25), ago(0.5), false],
    ['facts 23 h old and no attempt', ago(23), null, false],
    ['facts 23 h old, last attempt 2 h ago', ago(23), ago(2), false],
    ['no facts, last attempt 30 min ago', null, ago(0.5), false],
    ['facts exactly 24 h old', ago(24), null, true],
    ['attempt exactly 1 h ago', null, ago(1), true],
  ])('%s → %s', (_name, lastNpiFactAt, lastAttemptAt, expected) => {
    expect(shouldRefreshNpiMemory({ lastNpiFactAt, lastAttemptAt, now })).toBe(expected);
  });
});

describe('SOURCES_OF_FLOW', () => {
  it('maps each executed flow to the sources it can have changed', () => {
    expect(SOURCES_OF_FLOW).toEqual({
      customer_contract: ['customers', 'contracts'],
      pr: [],
      po: ['purchaseOrders'],
      grn: ['purchaseOrders'],
      vendor_bill: ['purchaseOrders'],
      user_permissions: [],
    });
  });
});

describe('isStorableFact', () => {
  it('applies the rules saveFact applies', () => {
    expect(isStorableFact({ factAr: 'جملة سليمة.', confidence: 0.5 })).toBe(true);
    expect(isStorableFact({ factAr: '   ', confidence: 0.5 })).toBe(false);
    expect(isStorableFact({ factAr: 'ا'.repeat(501), confidence: 0.5 })).toBe(false);
    expect(isStorableFact({ factAr: 'جملة', confidence: 1.2 })).toBe(false);
    expect(isStorableFact({ factAr: 'جملة', confidence: Number.NaN })).toBe(false);
    expect(isStorableFact({ factAr: 'مين أكفأ مهندس في الفريق؟', confidence: 1 })).toBe(false);
  });
});

// ─── refresh on the real database ────────────────────────────────────────────

/** Two POs with receipts from VEN-00001 sharing MOD-550 → 1 lead-time fact and
 *  1 recurring item; CAB-DC6 appears once, so it is not recurring. */
function refreshWire(): Wire {
  const po1 = wirePoDetail();
  const po2 = wirePoDetail({
    id: 'po_00002',
    code: 'PO-00002',
    createdAt: '2026-02-01T00:00:00.000Z',
    approvedAt: '2026-02-03T00:00:00.000Z',
    goodsReceipts: [{ id: 'grn_2', code: 'GRN-00002', status: 'ACCEPTED', receivedAt: '2026-02-17T00:00:00.000Z' }],
  });
  po2.lines = [
    { ...po1.lines[0], id: 'pol_2', purchaseOrderId: 'po_00002', qty: '60' },
    {
      ...po1.lines[0],
      id: 'pol_3',
      purchaseOrderId: 'po_00002',
      itemId: 'itm_cab_dc6',
      qty: '500',
      item: { sku: 'CAB-DC6', nameAr: 'كابل DC 6مم', nameEn: 'DC Cable 6mm', isSerialised: false, uom: 'm' },
    },
  ];
  return {
    customers: [wireCustomer()],
    contracts: [wireContract()],
    purchaseOrderList: [wirePoListRow(po2), wirePoListRow(po1)],
    purchaseOrders: { po_00001: po1, po_00002: po2 },
    projects: [
      wireProject(),
      wireProject({ id: 'prj_00004', code: 'PRJ-00004', nameAr: 'مستودع الدمام الشمسي', stage: 'PLANNING', capacityKwp: null, plannedEnd: null }),
    ],
  };
}

const REFRESH_FACTS = 6; // 1 credit term + 1 contract + 1 vendor + 1 item + 2 projects

async function npiRows(npiOrgId: string) {
  return db.memoryFact.findMany({ where: { npiOrgId, sourceType: 'npi' }, orderBy: { id: 'asc' } });
}

describe('refreshNpiMemory (real database)', () => {
  it('creates the facts, then a second run with the same data writes nothing and keeps the row ids', async () => {
    const npiOrgId = newOrg('idempotent');
    const npi = fakeNpi(refreshWire());
    const caller = { npiOrgId, permissions: ALL_PERMISSIONS };

    const first = await refreshNpiMemory({ db, npi }, caller);
    expect(first).toMatchObject({ derived: REFRESH_FACTS, created: REFRESH_FACTS, updated: 0, unchanged: 0, removed: 0 });
    expect(Object.values(first.sources).every((s) => s.status === 'read')).toBe(true);

    const rows = await npiRows(npiOrgId);
    expect(rows).toHaveLength(REFRESH_FACTS);
    for (const row of rows) {
      expect(row.scope).toBe('company');
      expect(row.positionId).toBeNull();
      expect(row.sourceType).toBe('npi');
      expect(row.searchText).toBe(normalizeArabic(row.factAr));
      expect((row.valueJson as { key: string }).key).toMatch(/^(customer_credit_terms|contract_payment_terms|vendor_lead_time|recurring_item|active_project):/);
    }
    const customerRow = rows.find((r) => (r.valueJson as { key: string }).key === 'customer_credit_terms:cus_00001')!;
    expect(customerRow.factAr).toBe('أجل سداد العميل مصنع الرياض للصناعات (CUS-00001) 30 يوماً من تاريخ الفاتورة.');
    expect(customerRow).toMatchObject({ entityType: 'customer', npiEntityId: 'cus_00001', confidence: 1 });

    const second = await refreshNpiMemory({ db, npi }, caller);
    expect(second).toMatchObject({ derived: REFRESH_FACTS, created: 0, updated: 0, unchanged: REFRESH_FACTS, removed: 0 });
    const again = await npiRows(npiOrgId);
    expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    // Text and valueJson untouched, but `updatedAt` advances: the daily gate
    // (`latestNpiFactAt`) must see an unchanged refresh as today's refresh.
    expect(again.map((r) => r.factAr)).toEqual(rows.map((r) => r.factAr));
    for (const [i, row] of again.entries()) {
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(rows[i].updatedAt.getTime());
    }
    expect(await latestNpiFactAt(db, npiOrgId)).not.toBeNull();
  });

  it('a changed credit term updates the same row in place and keeps its use history', async () => {
    const npiOrgId = newOrg('update');
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    const caller = { npiOrgId, permissions: ALL_PERMISSIONS };
    await refreshNpiMemory({ db, npi }, caller);

    const before = await db.memoryFact.findFirstOrThrow({
      where: { npiOrgId, valueJson: { path: ['key'], equals: 'customer_credit_terms:cus_00001' } },
    });
    await db.memoryFact.update({ where: { id: before.id }, data: { useCount: 4, lastUsedAt: new Date('2026-10-01T00:00:00.000Z') } });

    wire.customers = [wireCustomer({ creditTermsDays: 45 })];
    const outcome = await refreshNpiMemory({ db, npi }, caller);
    expect(outcome).toMatchObject({ derived: REFRESH_FACTS, created: 0, updated: 1, unchanged: REFRESH_FACTS - 1, removed: 0 });

    const after = await db.memoryFact.findFirstOrThrow({
      where: { npiOrgId, valueJson: { path: ['key'], equals: 'customer_credit_terms:cus_00001' } },
    });
    expect(after.id).toBe(before.id);
    expect(after.factAr).toBe('أجل سداد العميل مصنع الرياض للصناعات (CUS-00001) 45 يوماً من تاريخ الفاتورة.');
    expect(after.searchText).toBe(normalizeArabic(after.factAr));
    expect(after.searchText).not.toBe(before.searchText);
    expect((after.valueJson as { creditTermsDays: number }).creditTermsDays).toBe(45);
    expect(after.useCount).toBe(4);
    expect(after.lastUsedAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(await npiRows(npiOrgId)).toHaveLength(REFRESH_FACTS); // replaced, not piled up
  });

  it('a project that turns CLOSED is removed', async () => {
    const npiOrgId = newOrg('sweep');
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    const caller = { npiOrgId, permissions: ALL_PERMISSIONS };
    await refreshNpiMemory({ db, npi }, caller);

    wire.projects = [wireProject(), wireProject({ id: 'prj_00004', code: 'PRJ-00004', stage: 'CLOSED' })];
    const outcome = await refreshNpiMemory({ db, npi }, caller);
    expect(outcome).toMatchObject({ derived: REFRESH_FACTS - 1, created: 0, updated: 0, unchanged: REFRESH_FACTS - 1, removed: 1 });
    const keys = (await npiRows(npiOrgId)).map((r) => (r.valueJson as { key: string }).key);
    expect(keys).not.toContain('active_project:prj_00004');
    expect(keys).toContain('active_project:prj_00003');
  });

  it('a cancelled contract and a vendor whose receipts vanished are removed too', async () => {
    const npiOrgId = newOrg('sweep2');
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    const caller = { npiOrgId, permissions: ALL_PERMISSIONS };
    await refreshNpiMemory({ db, npi }, caller);

    wire.contracts = [wireContract({ status: 'CANCELLED' })];
    wire.purchaseOrders = {};
    wire.purchaseOrderList = [];
    const outcome = await refreshNpiMemory({ db, npi }, caller);
    // contract + vendor lead time + recurring item
    expect(outcome).toMatchObject({ derived: 3, created: 0, updated: 0, unchanged: 3, removed: 3 });
  });

  it('a source that was skipped leaves its rows alone, and nothing is swept for it', async () => {
    const npiOrgId = newOrg('skipped');
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });

    wire.projects = []; // as if every project were gone...
    const noProjects = ALL_PERMISSIONS.filter((p) => p !== 'projects.project.read');
    const outcome = await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: noProjects });
    expect(outcome.sources.projects).toEqual({ status: 'skipped', reason: 'no_permission' });
    expect(outcome).toMatchObject({ derived: REFRESH_FACTS - 2, created: 0, updated: 0, unchanged: REFRESH_FACTS - 2, removed: 0 });
    expect(npi.listProjects).toHaveBeenCalledTimes(1); // only the first, permitted run
    expect(await npiRows(npiOrgId)).toHaveLength(REFRESH_FACTS);

    // ...and the next caller who can read them sweeps.
    const later = await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    expect(later.removed).toBe(2);
    expect(await npiRows(npiOrgId)).toHaveLength(REFRESH_FACTS - 2);
  });

  it('a refused or failing source is skipped, not swept', async () => {
    const npiOrgId = newOrg('refused');
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });

    npi.listContracts.mockRejectedValue(npiError(403));
    npi.listPurchaseOrders.mockRejectedValue(npiError(500));
    const outcome = await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    expect(outcome.sources.contracts).toEqual({ status: 'skipped', reason: 'npi_refused' });
    expect(outcome.sources.purchaseOrders).toEqual({ status: 'skipped', reason: 'npi_error' });
    expect(outcome.removed).toBe(0);
    expect(await npiRows(npiOrgId)).toHaveLength(REFRESH_FACTS);
  });

  it('only: refreshes just the named sources', async () => {
    const npiOrgId = newOrg('only');
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    npi.listContracts.mockClear();

    wire.customers = [wireCustomer({ creditTermsDays: 60 })];
    wire.contracts = [];
    const outcome = await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS }, { only: ['customers'] });
    expect(outcome).toMatchObject({ derived: 1, updated: 1, unchanged: 0, removed: 0 });
    expect(npi.listContracts).not.toHaveBeenCalled();
    expect(await npiRows(npiOrgId)).toHaveLength(REFRESH_FACTS);
  });

  it('never touches a chat fact, nor an npi row it did not write', async () => {
    const npiOrgId = newOrg('chat');
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    const saved = await saveFact(db, {
      npiOrgId,
      scope: 'company',
      entityType: 'customer',
      factAr: 'شروط سداد مصنع الرياض للصناعات 30 يوماً بحسب كلام المحاسب',
      sourceType: 'chat',
      confidence: 0.7,
    });
    expect(saved).toMatchObject({ saved: true });
    const foreign = await saveFact(db, {
      npiOrgId,
      scope: 'company',
      entityType: 'vendor',
      factAr: 'ملاحظة قديمة بلا مفتاح من مصدر npi',
      sourceType: 'npi',
      confidence: 0.5,
    });
    const chatBefore = await db.memoryFact.findFirstOrThrow({ where: { npiOrgId, sourceType: 'chat' } });

    await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    wire.customers = [];
    wire.contracts = [];
    wire.projects = [];
    wire.purchaseOrders = {};
    wire.purchaseOrderList = [];
    const sweep = await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    expect(sweep.removed).toBe(REFRESH_FACTS);

    const chatAfter = await db.memoryFact.findFirstOrThrow({ where: { npiOrgId, sourceType: 'chat' } });
    expect(chatAfter).toEqual(chatBefore);
    expect(foreign).toMatchObject({ saved: true });
    expect(await db.memoryFact.count({ where: { npiOrgId } })).toBe(2); // the chat fact and the keyless npi row
  });

  it('an organization is never touched by another one\'s refresh', async () => {
    const orgA = newOrg('iso-a');
    const orgB = newOrg('iso-b');
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    await refreshNpiMemory({ db, npi }, { npiOrgId: orgA, permissions: ALL_PERMISSIONS });
    await refreshNpiMemory({ db, npi }, { npiOrgId: orgB, permissions: ALL_PERMISSIONS });
    wire.projects = [];
    await refreshNpiMemory({ db, npi }, { npiOrgId: orgB, permissions: ALL_PERMISSIONS });
    expect(await npiRows(orgA)).toHaveLength(REFRESH_FACTS);
    expect(await npiRows(orgB)).toHaveLength(REFRESH_FACTS - 2);
  });

  it('latestNpiFactAt is null for an empty organization, then the newest write', async () => {
    const npiOrgId = newOrg('latest');
    expect(await latestNpiFactAt(db, npiOrgId)).toBeNull();
    const wire = refreshWire();
    const npi = fakeNpi(wire);
    await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    const rows = await npiRows(npiOrgId);
    const newest = Math.max(...rows.map((r) => r.updatedAt.getTime()));
    expect((await latestNpiFactAt(db, npiOrgId))?.getTime()).toBe(newest);
  });

  it('the stored rows are found through retrieveFacts by the customer name', async () => {
    const npiOrgId = newOrg('retrieve');
    const wire = refreshWire();
    wire.customers = [wireCustomer(), wireCustomer({ id: 'cus_00002', code: 'CUS-00002', nameAr: 'شركة النخيل للمقاولات', creditTermsDays: 15 })];
    wire.contracts = [];
    wire.projects = [];
    wire.purchaseOrders = {};
    wire.purchaseOrderList = [];
    await refreshNpiMemory({ db, npi: fakeNpi(wire) }, { npiOrgId, permissions: ALL_PERMISSIONS });

    const hits = await retrieveFacts(db, { npiOrgId, positionId: null, permissions: ALL_PERMISSIONS, query: 'شروط سداد مصنع الرياض للصناعات', countUse: false });
    expect(hits.map((h) => (h.valueJson as { key: string }).key)).toEqual(['customer_credit_terms:cus_00001']);
    expect(hits[0].sourceType).toBe('npi');
    expect(hits[0].scope).toBe('company');
    expect(hits[0].factAr).toContain('30 يوماً');
  });

  it("D-17: every npi row carries the permission of its kind's source", async () => {
    const npiOrgId = newOrg('perm-column');
    await refreshNpiMemory({ db, npi: fakeNpi(refreshWire()) }, { npiOrgId, permissions: ALL_PERMISSIONS });
    const rows = await npiRows(npiOrgId);
    expect(rows).toHaveLength(REFRESH_FACTS);
    for (const row of rows) {
      const kind = (row.valueJson as { kind: keyof typeof PERMISSION_OF_KIND }).kind;
      expect(row.sourcePermission).toBe(PERMISSION_OF_KIND[kind]);
    }
    expect(new Set(rows.map((r) => r.sourcePermission))).toEqual(new Set(ALL_PERMISSIONS));
  });

  it('D-17: a row written before 0008 (sourcePermission null) is repaired as an update, then stays unchanged', async () => {
    const npiOrgId = newOrg('perm-repair');
    const npi = fakeNpi(refreshWire());
    await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    const before = await npiRows(npiOrgId);
    await db.memoryFact.updateMany({ where: { npiOrgId, sourceType: 'npi' }, data: { sourcePermission: null } });
    const one = before.find((r) => (r.valueJson as { kind: string }).kind === 'contract_payment_terms');
    if (!one) throw new Error('no contract fact');
    await db.memoryFact.updateMany({ where: { npiOrgId, id: { not: one.id } }, data: { sourcePermission: 'x.stale' } });

    const repaired = await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    expect(repaired).toMatchObject({ derived: REFRESH_FACTS, created: 0, updated: REFRESH_FACTS, unchanged: 0, removed: 0 });
    const after = await npiRows(npiOrgId);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id)); // same rows, repaired in place
    for (const row of after) {
      expect(row.sourcePermission).toBe(PERMISSION_OF_KIND[(row.valueJson as { kind: keyof typeof PERMISSION_OF_KIND }).kind]);
    }
    const again = await refreshNpiMemory({ db, npi }, { npiOrgId, permissions: ALL_PERMISSIONS });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: REFRESH_FACTS });
  });

  it('D-17: a site-engineer-like caller does not get the customer credit terms from memory; a customer-reader does; the vendor fact reaches both', async () => {
    const npiOrgId = newOrg('perm-retrieve');
    await refreshNpiMemory({ db, npi: fakeNpi(refreshWire()) }, { npiOrgId, permissions: ALL_PERMISSIONS });
    const engineer = ['scm.procurement.read', 'projects.project.read'];
    const customerReader = ['crm.customer.read'];
    const keys = async (permissions: string[], query: string) =>
      (await retrieveFacts(db, { npiOrgId, positionId: null, permissions, query, countUse: false })).map(
        (h) => (h.valueJson as { key: string }).key,
      );

    const creditQuestion = 'شروط سداد مصنع الرياض للصناعات';
    // the engineer may still get the project facts about the same name: only the credit terms are gated
    expect((await keys(engineer, creditQuestion)).filter((k) => k.startsWith('customer_credit_terms:'))).toEqual([]);
    expect(await keys(customerReader, creditQuestion)).toContain('customer_credit_terms:cus_00001');

    const contractQuestion = 'شروط عقد مصنع الرياض للصناعات الدفعة المقدمة';
    expect((await keys(engineer, contractQuestion)).filter((k) => k.startsWith('contract_payment_terms:'))).toEqual([]);
    expect((await keys(ALL_PERMISSIONS, contractQuestion)).filter((k) => k.startsWith('contract_payment_terms:'))).toHaveLength(1);

    const vendorQuestion = 'مدة توريد المورد شركة الخليج للألواح الشمسية';
    expect(await keys(engineer, vendorQuestion)).toContain('vendor_lead_time:ven_00001');
    expect(await keys(['scm.procurement.read'], vendorQuestion)).toContain('vendor_lead_time:ven_00001');
  });

  it('the full demo-sized set answers «شروط سداد {customer}» with the customer fact among the hits', async () => {
    const npiOrgId = newOrg('retrieve-full');
    await refreshNpiMemory({ db, npi: fakeNpi(refreshWire()) }, { npiOrgId, permissions: ALL_PERMISSIONS });
    const hits = await retrieveFacts(db, { npiOrgId, positionId: null, permissions: ALL_PERMISSIONS, query: 'شروط سداد مصنع الرياض للصناعات', countUse: false });
    const keys = hits.map((h) => (h.valueJson as { key: string }).key);
    expect(keys).toContain('customer_credit_terms:cus_00001');
  });
});
