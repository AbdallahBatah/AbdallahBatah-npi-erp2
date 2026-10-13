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
    listContracts: jest.fn(async () => []),
    getContract: jest.fn(async () => ({})),
    financeSummary: jest.fn(async () => ({})),
    crmDashboard: jest.fn(async () => ({})),
    permissionCatalog: jest.fn(async () => []),
    getUserPermissions: jest.fn(async () => ({})),
    listDepartmentDirectory: jest.fn(async () => []),
    ...overrides,
  };
}

function ctx(
  npi: FakeNpi,
  queryRaw: jest.Mock = jest.fn(async () => []),
  permissions: string[] = [],
  now?: () => Date,
): ToolContext {
  return {
    now,
    npi: npi as unknown as ToolContext['npi'],
    db: { $queryRaw: queryRaw } as unknown as ToolContext['db'],
    npiOrgId: 'org-1',
    positionId: 'pos-1',
    permissions,
  };
}

function tool(name: string) {
  const found = findReadTool(name);
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

describe('read tools — registry', () => {
  it('exposes exactly the nine read tools (six of the spec plus the three of D-26)', () => {
    expect(READ_TOOLS.map((t) => t.def.name).sort()).toEqual(
      [
        'finance_summary',
        'get_contract',
        'get_customer',
        'get_po',
        'get_user_permissions',
        'list_open_tasks',
        'list_projects',
        'memory_search',
        'search_items',
      ].sort(),
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

  it("filters by the caller's permissions (D-17): they go into the query as parameters", async () => {
    const queryRaw = jest.fn(async (..._args: unknown[]) => []);
    await tool('memory_search').run({ query: 'شروط سداد النخيل' }, ctx(fakeNpi(), queryRaw, ['crm.customer.read']));
    const sql = queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(sql.sql).toContain('"sourcePermission" IS NULL OR "sourcePermission" IN');
    expect(sql.values).toContain('crm.customer.read');

    queryRaw.mockClear();
    await tool('memory_search').run({ query: 'شروط سداد النخيل' }, ctx(fakeNpi(), queryRaw, []));
    const none = queryRaw.mock.calls[0][0] as { sql: string };
    expect(none.sql).toContain('("sourcePermission" IS NULL)');
    expect(none.sql).not.toContain('IN (');
  });

  it('does not touch the database for a query that normalizes to nothing', async () => {
    const queryRaw = jest.fn(async () => []);
    const out = await tool('memory_search').run({ query: '؟؟' }, ctx(fakeNpi(), queryRaw));
    expect(queryRaw).not.toHaveBeenCalled();
    expect(out.memoryNotes).toEqual([]);
  });
});

// ─── D-26 (T-48a): get_contract, finance_summary, get_user_permissions ──────

const NOW = () => new Date('2026-10-13T09:00:00Z');

function contractRow(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `k${i}`,
    code: `CON-0000${i}`,
    contractType: 'EPC',
    status: 'ACTIVE',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    currency: 'SAR',
    totalValue: '1250000.50',
    customer: { id: `c${i}`, code: `CUS-0000${i}`, nameAr: `عميل ${i}`, nameEn: `Client ${i}` },
    _count: { milestones: 3 },
    ...over,
  };
}

describe('get_contract', () => {
  it('lists contracts with the selected fields, dates cut to the day and the value kept as text', async () => {
    const npi = fakeNpi({ listContracts: jest.fn(async () => [contractRow(1), contractRow(2)]) });
    const out = await tool('get_contract').run({}, ctx(npi, undefined, [], NOW));
    expect(out.result).toEqual({
      count: 2,
      contracts: [
        {
          code: 'CON-00001',
          customerNameAr: 'عميل 1',
          customerCode: 'CUS-00001',
          contractType: 'EPC',
          status: 'ACTIVE',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          currency: 'SAR',
          totalValue: '1250000.50',
          milestoneCount: 3,
        },
        expect.objectContaining({ code: 'CON-00002' }),
      ],
    });
    expect(npi.getContract).not.toHaveBeenCalled();
  });

  it('filters by contract code', async () => {
    const npi = fakeNpi({
      listContracts: jest.fn(async () => [contractRow(1), contractRow(2), contractRow(3)]),
      getContract: jest.fn(async () => ({ milestones: [] })),
    });
    const out = await tool('get_contract').run({ query: 'con-00003' }, ctx(npi, undefined, [], NOW));
    const result = out.result as { count: number; contracts: { code: string }[] };
    expect(result.count).toBe(1);
    expect(result.contracts.map((c) => c.code)).toEqual(['CON-00003']);
  });

  it('filters by customer name across Arabic spelling variants and by customer code', async () => {
    const rowsList = [
      contractRow(1, { customer: { id: 'c1', code: 'CUS-00001', nameAr: 'شركة النخيل للمقاولات', nameEn: 'Al Nakheel' } }),
      contractRow(2, { customer: { id: 'c2', code: 'CUS-00002', nameAr: 'مؤسسة الأفق', nameEn: 'Horizon' } }),
    ];
    const npi = fakeNpi({
      listContracts: jest.fn(async () => rowsList),
      getContract: jest.fn(async () => ({ milestones: [] })),
    });
    // Teh marbuta vs heh and a hamza on the alef must still match.
    const byName = await tool('get_contract').run({ query: 'مؤسسه الافق' }, ctx(npi, undefined, [], NOW));
    expect((byName.result as { contracts: { code: string }[] }).contracts.map((c) => c.code)).toEqual(['CON-00002']);
    const byCode = await tool('get_contract').run({ query: 'CUS-00001' }, ctx(npi, undefined, [], NOW));
    expect((byCode.result as { contracts: { code: string }[] }).contracts.map((c) => c.code)).toEqual(['CON-00001']);
  });

  it('caps the list at 10 but reports the full count, and reads no milestones for many matches', async () => {
    const many = Array.from({ length: 14 }, (_, i) => contractRow(i + 1));
    const npi = fakeNpi({ listContracts: jest.fn(async () => many) });
    const out = await tool('get_contract').run({ query: 'CON' }, ctx(npi, undefined, [], NOW));
    const result = out.result as { count: number; contracts: unknown[]; milestones?: unknown };
    expect(result.count).toBe(14);
    expect(result.contracts).toHaveLength(10);
    expect(result.milestones).toBeUndefined();
    expect(npi.getContract).not.toHaveBeenCalled();
  });

  it('adds the milestones only for a single match and flags overdue ones', async () => {
    const npi = fakeNpi({
      listContracts: jest.fn(async () => [contractRow(1), contractRow(2)]),
      getContract: jest.fn(async () => ({
        id: 'k1',
        milestones: [
          { sequence: 1, descriptionAr: 'دفعة مقدمة', triggerType: 'ADVANCE', amount: '100000.00', dueDate: '2026-09-01T00:00:00.000Z', status: 'PENDING' },
          { sequence: 2, descriptionAr: 'دفعة موثقة', triggerType: 'PROGRESS', amount: '50000.00', dueDate: '2026-09-01T00:00:00.000Z', status: 'VERIFIED' },
          { sequence: 3, descriptionAr: 'دفعة قادمة', triggerType: 'PROGRESS', amount: '75000.00', dueDate: '2026-11-01T00:00:00.000Z', status: 'PENDING' },
          { sequence: 4, descriptionAr: 'بلا تاريخ', triggerType: 'FINAL', amount: '25000.00', dueDate: null, status: 'PENDING' },
          { sequence: 5, descriptionAr: 'اليوم', triggerType: 'FINAL', amount: '10.5', dueDate: '2026-10-13T00:00:00.000Z', status: 'PENDING' },
        ],
      })),
    });

    const many = await tool('get_contract').run({}, ctx(npi, undefined, [], NOW));
    expect((many.result as { milestones?: unknown }).milestones).toBeUndefined();
    expect(npi.getContract).not.toHaveBeenCalled();

    const one = await tool('get_contract').run({ query: 'CON-00001' }, ctx(npi, undefined, [], NOW));
    expect(npi.getContract).toHaveBeenCalledWith('k1');
    const milestones = (one.result as { milestones: { sequence: number; amount: string; overdue: boolean; dueDate: string | null }[] })
      .milestones;
    expect(milestones.map((m) => [m.sequence, m.overdue])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(milestones[0].dueDate).toBe('2026-09-01');
    expect(milestones.map((m) => m.amount)).toEqual(['100000.00', '50000.00', '75000.00', '25000.00', '10.5']);
    expect(milestones.every((m) => typeof m.amount === 'string')).toBe(true);
  });

  it('counts "today" on the Riyadh calendar day (a UTC evening is already tomorrow there)', async () => {
    const npi = fakeNpi({
      listContracts: jest.fn(async () => [contractRow(1)]),
      getContract: jest.fn(async () => ({
        milestones: [{ sequence: 1, amount: '1', dueDate: '2026-10-13T00:00:00.000Z', status: 'PENDING' }],
      })),
    });
    const lateUtc = () => new Date('2026-10-13T22:00:00Z'); // 01:00 on the 14th in Riyadh
    const out = await tool('get_contract').run({ query: 'CON-00001' }, ctx(npi, undefined, [], lateUtc));
    expect((out.result as { milestones: { overdue: boolean }[] }).milestones[0].overdue).toBe(true);
  });

  it('declares the customer name as a sensitive field', () => {
    expect(tool('get_contract').sensitiveFields).toEqual({ customerNameAr: 'عميل' });
    expect(tool('get_contract').badgeAr).toBe('العقود');
  });

  it('rejects a query longer than 120 characters without calling NPI', async () => {
    const npi = fakeNpi();
    await expect(tool('get_contract').run({ query: 'ا'.repeat(121) }, ctx(npi))).rejects.toBeInstanceOf(ToolInputError);
    expect(npi.listContracts).not.toHaveBeenCalled();
  });

  it("lets NPI's refusal of the list through untouched", async () => {
    const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden' });
    const npi = fakeNpi({
      listContracts: jest.fn(async () => {
        throw refusal;
      }),
    });
    await expect(tool('get_contract').run({}, ctx(npi))).rejects.toBe(refusal);
  });
});

describe('finance_summary', () => {
  const FINANCE = { issuedInvoices: 12, accountsReceivable: 345678.9, vatOutput: 4500, retentionHeld: 0 };
  const CRM = { openLeads: 7, openOpportunities: 4, totalContracts: 9, activeContracts: 6, pipelineValue: '2500000.00' };

  it('returns both halves, every number as text', async () => {
    const npi = fakeNpi({ financeSummary: jest.fn(async () => FINANCE), crmDashboard: jest.fn(async () => CRM) });
    const out = await tool('finance_summary').run({}, ctx(npi));
    expect(out.result).toEqual({
      finance: { ok: true, issuedInvoices: '12', accountsReceivable: '345678.9', vatOutput: '4500', retentionHeld: '0' },
      crm: {
        ok: true,
        openLeads: '7',
        openOpportunities: '4',
        totalContracts: '9',
        activeContracts: '6',
        pipelineValue: '2500000.00',
      },
    });
    expect(npi.financeSummary).toHaveBeenCalledTimes(1);
    expect(npi.crmDashboard).toHaveBeenCalledTimes(1);
  });

  it('reports a refused finance half and still returns the CRM half, with no retry', async () => {
    const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden' });
    const npi = fakeNpi({
      financeSummary: jest.fn(async () => {
        throw refusal;
      }),
      crmDashboard: jest.fn(async () => CRM),
    });
    const out = await tool('finance_summary').run({}, ctx(npi));
    const result = out.result as { finance: { ok: boolean; messageAr?: string }; crm: { ok: boolean; openLeads?: string } };
    expect(result.finance).toEqual({ ok: false, messageAr: refusal.messageAr });
    expect(result.crm.ok).toBe(true);
    expect(result.crm.openLeads).toBe('7');
    expect(npi.financeSummary).toHaveBeenCalledTimes(1);
    expect(npi.crmDashboard).toHaveBeenCalledTimes(1);
  });

  it('reports a refused CRM half and still returns the finance half', async () => {
    const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden' });
    const npi = fakeNpi({
      financeSummary: jest.fn(async () => FINANCE),
      crmDashboard: jest.fn(async () => {
        throw refusal;
      }),
    });
    const out = await tool('finance_summary').run({}, ctx(npi));
    const result = out.result as { finance: { ok: boolean; issuedInvoices?: string }; crm: { ok: boolean; messageAr?: string } };
    expect(result.finance.ok).toBe(true);
    expect(result.finance.issuedInvoices).toBe('12');
    expect(result.crm).toEqual({ ok: false, messageAr: refusal.messageAr });
  });

  it('lets an error that is not from NPI propagate', async () => {
    const boom = new Error('boom');
    const npi = fakeNpi({
      financeSummary: jest.fn(async () => {
        throw boom;
      }),
    });
    await expect(tool('finance_summary').run({}, ctx(npi))).rejects.toBe(boom);
    expect(npi.crmDashboard).not.toHaveBeenCalled();
  });

  it('has an empty closed schema and the Arabic badge', () => {
    expect(tool('finance_summary').def.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool('finance_summary').badgeAr).toBe('الملخص المالي');
  });
});

describe('get_user_permissions', () => {
  const PEOPLE = [
    { id: 'u1', nameAr: 'أحمد الغامدي', nameEn: 'Ahmed Alghamdi', email: 'ahmed@npi.sa', isActive: true, role: { id: 'r1', key: 'ACCOUNTANT', nameAr: 'محاسب', nameEn: 'Accountant' } },
    { id: 'u2', nameAr: 'أحمد الغامدي الصغير', nameEn: 'Ahmed Jr', email: 'ahmed.jr@npi.sa', isActive: false, role: { id: 'r2', key: 'STORE', nameAr: 'أمين مخزن', nameEn: 'Store' } },
    { id: 'u3', nameAr: 'سارة القحطاني', nameEn: 'Sara', email: 'sara@npi.sa', isActive: true, role: { id: 'r3', key: 'SALES', nameAr: 'مبيعات', nameEn: 'Sales' } },
    { id: 'u4', nameAr: 'محمد العتيبي', nameEn: 'Mohammed', email: 'm.otaibi@npi.sa', isActive: true, role: { id: 'r4', key: 'SALES', nameAr: 'مبيعات', nameEn: 'Sales' } },
    { id: 'u5', nameAr: 'محمد الدوسري', nameEn: 'Mohammed D', email: 'm.dosari@npi.sa', isActive: true, role: { id: 'r4', key: 'SALES', nameAr: 'مبيعات', nameEn: 'Sales' } },
  ];
  const DETAIL = {
    roles: [{ id: 'r3', key: 'SALES', nameAr: 'مبيعات', nameEn: 'Sales', permissions: ['crm.lead.read', 'finance.report.read', 'crm.customer.read'] }],
    overrides: [
      { permission: 'finance.report.read', effect: 'DENY', reason: 'نقل إلى المبيعات', createdAt: '2026-10-01T00:00:00Z', createdBy: { id: 'x', nameAr: 'مدير', nameEn: 'Admin' } },
      { permission: 'unknown.key', effect: 'GRANT', reason: null, createdAt: '2026-10-02T00:00:00Z', createdBy: null },
    ],
    effective: ['crm.lead.read', 'crm.customer.read', 'unknown.key'],
  };
  const CATALOG = [
    { key: 'crm.lead.read', labelAr: 'عرض العملاء المحتملين', screenAr: 'العملاء' },
    { key: 'crm.customer.read', labelAr: 'عرض العملاء', screenAr: 'العملاء' },
    { key: 'finance.report.read', labelAr: 'عرض التقارير المالية', screenAr: 'التقارير المالية' },
  ];

  function npiWith(over: Partial<FakeNpi> = {}) {
    return fakeNpi({
      listDepartmentDirectory: jest.fn(async () => PEOPLE),
      getUserPermissions: jest.fn(async () => DETAIL),
      permissionCatalog: jest.fn(async () => CATALOG),
      ...over,
    });
  }

  it('returns { found: false } when nobody matches, without reading permissions', async () => {
    const npi = npiWith();
    const out = await tool('get_user_permissions').run({ query: 'خالد' }, ctx(npi));
    expect(out.result).toEqual({ found: false });
    expect(npi.getUserPermissions).not.toHaveBeenCalled();
    expect(npi.permissionCatalog).not.toHaveBeenCalled();
  });

  it('returns the candidates (capped at 10) when several users match, and reads no permissions', async () => {
    const npi = npiWith();
    const out = await tool('get_user_permissions').run({ query: 'محمد' }, ctx(npi));
    expect(out.result).toEqual({
      found: false,
      candidates: [
        { nameAr: 'محمد العتيبي', email: 'm.otaibi@npi.sa', roleAr: 'مبيعات', isActive: true },
        { nameAr: 'محمد الدوسري', email: 'm.dosari@npi.sa', roleAr: 'مبيعات', isActive: true },
      ],
    });
    expect(npi.getUserPermissions).not.toHaveBeenCalled();

    const crowd = Array.from({ length: 15 }, (_, i) => ({ id: `p${i}`, nameAr: `موظف ${i}`, email: `p${i}@npi.sa`, role: { nameAr: 'دور' } }));
    const big = npiWith({ listDepartmentDirectory: jest.fn(async () => crowd) });
    const many = await tool('get_user_permissions').run({ query: 'موظف' }, ctx(big));
    expect((many.result as { candidates: unknown[] }).candidates).toHaveLength(10);
  });

  it('prefers the exact name over longer names that merely contain it', async () => {
    const npi = npiWith();
    const out = await tool('get_user_permissions').run({ query: 'أحمد الغامدي' }, ctx(npi));
    expect(npi.getUserPermissions).toHaveBeenCalledTimes(1);
    expect(npi.getUserPermissions).toHaveBeenCalledWith('u1');
    expect((out.result as { found: boolean }).found).toBe(true);
  });

  it('finds a user by e-mail, case-insensitively', async () => {
    const npi = npiWith();
    await tool('get_user_permissions').run({ query: 'SARA@npi.sa' }, ctx(npi));
    expect(npi.getUserPermissions).toHaveBeenCalledWith('u3');
  });

  it('returns role, effective permissions with Arabic labels (sorted by key), overrides and role counts', async () => {
    const npi = npiWith();
    const out = await tool('get_user_permissions').run({ query: 'سارة' }, ctx(npi));
    expect(npi.listDepartmentDirectory).toHaveBeenCalledTimes(1);
    expect(npi.permissionCatalog).toHaveBeenCalledTimes(1);
    expect(out.result).toEqual({
      found: true,
      user: { nameAr: 'سارة القحطاني', email: 'sara@npi.sa', roleAr: 'مبيعات', roleKey: 'SALES', isActive: true },
      effective: [
        { key: 'crm.customer.read', labelAr: 'عرض العملاء' },
        { key: 'crm.lead.read', labelAr: 'عرض العملاء المحتملين' },
        { key: 'unknown.key', labelAr: null },
      ],
      overrides: [
        { key: 'finance.report.read', labelAr: 'عرض التقارير المالية', effect: 'DENY', reason: 'نقل إلى المبيعات' },
        { key: 'unknown.key', labelAr: null, effect: 'GRANT', reason: null },
      ],
      fromRoles: [{ roleAr: 'مبيعات', count: 3 }],
    });
  });

  it('degrades to key-only labels when NPI refuses the catalog', async () => {
    const npi = npiWith({
      permissionCatalog: jest.fn(async () => {
        throw new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden' });
      }),
    });
    const out = await tool('get_user_permissions').run({ query: 'سارة' }, ctx(npi));
    const result = out.result as { found: boolean; effective: { key: string; labelAr: string | null }[] };
    expect(result.found).toBe(true);
    expect(result.effective.map((e) => e.labelAr)).toEqual([null, null, null]);
    expect(result.effective.map((e) => e.key)).toEqual(['crm.customer.read', 'crm.lead.read', 'unknown.key']);
  });

  it("lets NPI's refusal of the permissions read through untouched", async () => {
    const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden' });
    const npi = npiWith({
      getUserPermissions: jest.fn(async () => {
        throw refusal;
      }),
    });
    await expect(tool('get_user_permissions').run({ query: 'سارة' }, ctx(npi))).rejects.toBe(refusal);
  });

  it("lets NPI's refusal of the directory through untouched", async () => {
    const refusal = new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'Forbidden' });
    const npi = npiWith({
      listDepartmentDirectory: jest.fn(async () => {
        throw refusal;
      }),
    });
    await expect(tool('get_user_permissions').run({ query: 'سارة' }, ctx(npi))).rejects.toBe(refusal);
  });

  it.each([[{}], [{ query: '' }], [{ query: 5 }], [null]])('rejects malformed input %p without calling NPI', async (input) => {
    const npi = npiWith();
    await expect(tool('get_user_permissions').run(input, ctx(npi))).rejects.toBeInstanceOf(ToolInputError);
    expect(npi.listDepartmentDirectory).not.toHaveBeenCalled();
  });

  it('declares the name and e-mail as sensitive fields', () => {
    expect(tool('get_user_permissions').sensitiveFields).toEqual({ nameAr: 'موظف', email: 'بريد' });
    expect(tool('get_user_permissions').badgeAr).toBe('الصلاحيات');
  });
});
