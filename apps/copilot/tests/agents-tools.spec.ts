import { READ_TOOLS, ToolInputError, findReadTool, type ToolContext } from '../src/agents/tools/read';
import { NpiError } from '../src/npi/errors';

type FakeNpi = { [K in keyof ToolContext['npi']]: jest.Mock };

function fakeNpi(overrides: Partial<FakeNpi> = {}): FakeNpi {
  return {
    listCustomers: jest.fn(async () => []),
    listProjects: jest.fn(async () => []),
    inboxTasks: jest.fn(async () => []),
    listPurchaseOrders: jest.fn(async () => []),
    getPurchaseOrder: jest.fn(async () => ({})),
    listItems: jest.fn(async () => []),
    ...overrides,
  };
}

function ctx(npi: FakeNpi, queryRaw: jest.Mock = jest.fn(async () => [])): ToolContext {
  return {
    npi: npi as unknown as ToolContext['npi'],
    db: { $queryRaw: queryRaw } as unknown as ToolContext['db'],
    npiOrgId: 'org-1',
    positionId: 'pos-1',
  };
}

function tool(name: string) {
  const found = findReadTool(name);
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

describe('read tools — registry', () => {
  it('exposes exactly the six read tools of the spec', () => {
    expect(READ_TOOLS.map((t) => t.def.name).sort()).toEqual(
      ['get_customer', 'get_po', 'list_open_tasks', 'list_projects', 'memory_search', 'search_items'].sort(),
    );
  });

  it('has no tool that writes, approves, rejects or deletes', () => {
    const forbidden = /(create|update|delete|remove|approve|reject|return|submit|post|pay|cancel)/i;
    for (const t of READ_TOOLS) expect(t.def.name).not.toMatch(forbidden);
  });

  it('every tool has a closed input schema and an Arabic badge', () => {
    for (const t of READ_TOOLS) {
      expect(t.def.inputSchema.type).toBe('object');
      expect(t.def.inputSchema.additionalProperties).toBe(false);
      expect(t.badgeAr).toMatch(/[؀-ۿ]/);
      expect(t.badgeAr).not.toMatch(/[A-Za-z]/);
    }
  });

  it('findReadTool returns undefined for an unknown name', () => {
    expect(findReadTool('approve_requisition')).toBeUndefined();
  });
});

describe('get_customer', () => {
  it('passes the query to NPI and returns only the selected fields', async () => {
    const npi = fakeNpi({
      listCustomers: jest.fn(async () => [
        {
          id: 'c1',
          organizationId: 'org-1',
          code: 'CUS-00001',
          nameAr: 'شركة النخيل للمقاولات',
          nameEn: 'Al Nakheel',
          vatNumber: '300000000000003',
          creditTermsDays: 30,
          phone: '0500000000',
          email: 'a@example.sa',
        },
      ]),
    });
    const out = await tool('get_customer').run({ query: 'النخيل' }, ctx(npi));
    expect(npi.listCustomers).toHaveBeenCalledWith('النخيل');
    expect(out.result).toEqual({
      count: 1,
      customers: [
        {
          code: 'CUS-00001',
          nameAr: 'شركة النخيل للمقاولات',
          vatNumber: '300000000000003',
          creditTermsDays: 30,
          phone: '0500000000',
          email: 'a@example.sa',
        },
      ],
    });
  });

  it('caps the result at 10 rows', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ code: `CUS-${i}`, nameAr: `عميل ${i}` }));
    const npi = fakeNpi({ listCustomers: jest.fn(async () => many) });
    const out = await tool('get_customer').run({ query: 'عميل' }, ctx(npi));
    expect((out.result as { customers: unknown[] }).customers).toHaveLength(10);
  });

  it.each([[{}], [{ query: '' }], [{ query: 5 }], [null], ['النخيل']])(
    'rejects malformed input %p without calling NPI',
    async (input) => {
      const npi = fakeNpi();
      await expect(tool('get_customer').run(input, ctx(npi))).rejects.toBeInstanceOf(ToolInputError);
      expect(npi.listCustomers).not.toHaveBeenCalled();
    },
  );

  it("lets NPI's refusal through untouched (no workaround for a 403)", async () => {
    const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden' });
    const npi = fakeNpi({
      listCustomers: jest.fn(async () => {
        throw refusal;
      }),
    });
    await expect(tool('get_customer').run({ query: 'x' }, ctx(npi))).rejects.toBe(refusal);
  });
});

describe('list_projects', () => {
  const projects = [
    {
      code: 'PRJ-00012',
      nameAr: 'محطة الرياض الشمسية',
      nameEn: 'Riyadh plant',
      stage: 'EXECUTION',
      contract: { code: 'CON-00007', totalValue: '850000.00', customer: { nameAr: 'شركة النخيل' } },
    },
    { code: 'PRJ-00013', nameAr: 'مستودع جدة', nameEn: 'Jeddah', stage: 'PLANNING', contract: null },
  ];

  it('returns all projects when no query is given', async () => {
    const npi = fakeNpi({ listProjects: jest.fn(async () => projects) });
    const out = await tool('list_projects').run({}, ctx(npi));
    expect((out.result as { count: number }).count).toBe(2);
  });

  it('filters by code, case-insensitively', async () => {
    const npi = fakeNpi({ listProjects: jest.fn(async () => projects) });
    const out = await tool('list_projects').run({ query: 'prj-00012' }, ctx(npi));
    expect(out.result).toEqual({
      count: 1,
      projects: [
        {
          code: 'PRJ-00012',
          nameAr: 'محطة الرياض الشمسية',
          stage: 'EXECUTION',
          contractCode: 'CON-00007',
          customerNameAr: 'شركة النخيل',
        },
      ],
    });
  });

  it('filters by Arabic name regardless of letter variants', async () => {
    const npi = fakeNpi({ listProjects: jest.fn(async () => projects) });
    const out = await tool('list_projects').run({ query: 'جدّه' }, ctx(npi));
    expect((out.result as { projects: { code: string }[] }).projects.map((p) => p.code)).toEqual([
      'PRJ-00013',
    ]);
  });

  it('tolerates a project with no contract', async () => {
    const npi = fakeNpi({ listProjects: jest.fn(async () => projects) });
    const out = await tool('list_projects').run({ query: 'PRJ-00013' }, ctx(npi));
    expect((out.result as { projects: { contractCode: unknown }[] }).projects[0].contractCode).toBeNull();
  });
});

describe('list_open_tasks', () => {
  it("returns the caller's inbox as NPI scoped it, without ids or links", async () => {
    const npi = fakeNpi({
      inboxTasks: jest.fn(async () => [
        {
          source: 'APPROVAL',
          id: 'req-1',
          documentType: 'PURCHASE_REQUISITION',
          documentId: 'pr-1',
          documentCode: 'PR-00012',
          titleAr: 'طلب شراء PR-00012 — بانتظار اعتمادك',
          stateAr: 'الخطوة 1 من 2',
          amount: 14500,
          ageHours: 5.5,
          overdue: false,
          actionable: true,
          linkPath: '/approvals',
        },
      ]),
    });
    const out = await tool('list_open_tasks').run({}, ctx(npi));
    expect(out.result).toEqual({
      count: 1,
      tasks: [
        {
          documentType: 'PURCHASE_REQUISITION',
          documentCode: 'PR-00012',
          titleAr: 'طلب شراء PR-00012 — بانتظار اعتمادك',
          stateAr: 'الخطوة 1 من 2',
          amount: '14500',
          ageHours: 5.5,
          overdue: false,
          actionable: true,
        },
      ],
    });
  });

  it('reports the full count even when the list is capped at 20', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ documentCode: `PR-${i}` }));
    const npi = fakeNpi({ inboxTasks: jest.fn(async () => many) });
    const out = await tool('list_open_tasks').run({}, ctx(npi));
    const result = out.result as { count: number; tasks: unknown[] };
    expect(result.count).toBe(30);
    expect(result.tasks).toHaveLength(20);
  });
});

describe('get_po', () => {
  it('finds the order by code and keeps money as strings', async () => {
    const npi = fakeNpi({
      listPurchaseOrders: jest.fn(async () => [
        { id: 'po-1', code: 'PO-00041' },
        { id: 'po-2', code: 'PO-00042' },
      ]),
      getPurchaseOrder: jest.fn(async () => ({
        id: 'po-2',
        code: 'PO-00042',
        status: 'SENT',
        currency: 'SAR',
        subtotal: '100000.10',
        vatAmount: '15000.02',
        total: '115000.12',
        vendor: { nameAr: 'مصنع الخليج للألواح' },
        project: { code: 'PRJ-00012' },
        lines: [
          {
            qty: '40.000',
            receivedQty: '10.000',
            unitPrice: '2500.00',
            lineTotal: '100000.00',
            item: { sku: 'PNL-550', nameAr: 'لوح 550 واط', uom: 'unit' },
          },
        ],
        goodsReceipts: [{ code: 'GRN-00009', status: 'ACCEPTED' }],
        vendorBills: [{ code: 'BILL-00003', status: 'DRAFT', total: '28750.00' }],
      })),
    });
    const out = await tool('get_po').run({ code: 'po-00042' }, ctx(npi));
    expect(npi.getPurchaseOrder).toHaveBeenCalledWith('po-2');
    expect(out.result).toEqual({
      found: true,
      code: 'PO-00042',
      status: 'SENT',
      vendorNameAr: 'مصنع الخليج للألواح',
      projectCode: 'PRJ-00012',
      currency: 'SAR',
      subtotal: '100000.10',
      vatAmount: '15000.02',
      total: '115000.12',
      lines: [
        {
          sku: 'PNL-550',
          itemNameAr: 'لوح 550 واط',
          uom: 'unit',
          qty: '40.000',
          receivedQty: '10.000',
          unitPrice: '2500.00',
          lineTotal: '100000.00',
        },
      ],
      goodsReceipts: [{ code: 'GRN-00009', status: 'ACCEPTED' }],
      vendorBills: [{ code: 'BILL-00003', status: 'DRAFT', total: '28750.00' }],
    });
  });

  it('answers found:false for an unknown code and reads nothing further', async () => {
    const npi = fakeNpi({ listPurchaseOrders: jest.fn(async () => [{ id: 'po-1', code: 'PO-00041' }]) });
    const out = await tool('get_po').run({ code: 'PO-99999' }, ctx(npi));
    expect(out.result).toEqual({ found: false, code: 'PO-99999' });
    expect(npi.getPurchaseOrder).not.toHaveBeenCalled();
  });
});

describe('search_items', () => {
  it('returns catalogue rows with the unit cost as a string', async () => {
    const npi = fakeNpi({
      listItems: jest.fn(async () => [
        { sku: 'PNL-550', nameAr: 'لوح 550 واط', uom: 'unit', itemCategory: 'MODULE', unitCost: '2500.00' },
      ]),
    });
    const out = await tool('search_items').run({ query: 'لوح' }, ctx(npi));
    expect(out.result).toEqual({
      count: 1,
      items: [{ sku: 'PNL-550', nameAr: 'لوح 550 واط', uom: 'unit', category: 'MODULE', unitCost: '2500.00' }],
    });
  });
});

describe('memory_search', () => {
  it('returns facts to the model and the same facts as notes for the user', async () => {
    const queryRaw = jest.fn(async () => [
      {
        id: 'fact-1',
        factAr: 'شروط سداد شركة النخيل 30 يوماً',
        scope: 'company',
        entityType: 'customer',
        npiEntityId: 'c1',
        valueJson: { creditTermsDays: 30 },
        sourceType: 'npi',
        confidence: 1,
        score: 1.2,
      },
    ]);
    const out = await tool('memory_search').run({ query: 'شروط سداد النخيل' }, ctx(fakeNpi(), queryRaw));
    expect(out.result).toEqual({
      count: 1,
      facts: [{ fact: 'شروط سداد شركة النخيل 30 يوماً', about: 'customer', source: 'npi', confidence: 1 }],
    });
    expect(out.memoryNotes).toEqual([
      { id: 'fact-1', factAr: 'شروط سداد شركة النخيل 30 يوماً', sourceType: 'npi' },
    ]);
  });

  it('does not touch the database for a query that normalizes to nothing', async () => {
    const queryRaw = jest.fn(async () => []);
    const out = await tool('memory_search').run({ query: '؟؟' }, ctx(fakeNpi(), queryRaw));
    expect(queryRaw).not.toHaveBeenCalled();
    expect(out.memoryNotes).toEqual([]);
  });
});
