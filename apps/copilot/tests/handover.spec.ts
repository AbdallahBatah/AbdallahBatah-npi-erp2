// T-30 (F-13): the handover document — NPI readers, the pure `waitingOnRole`,
// `buildHandoverBody` against a fake database and a fake NPI, the plain-text
// rendering, the chat excerpt, and the advanced-tier narrative against a fake
// model. No database, no network, no real model. The reassignment service and
// the access rules are in handover-reassign.spec.ts (real database).
import path from 'node:path';

process.env.COPILOT_PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

import { formatDate } from '../src/i18n/format';
import { LlmError } from '../src/llm/client';
import type { ModelResponse, RedactedRequest } from '../src/llm/provider';
import { NpiError } from '../src/npi/errors';
import { readApprovalHistory, readVendorsBrief, waitingOnRole, type NpiApprovalChain } from '../src/npi/approvals';
import {
  buildHandoverBody,
  handoverGuidanceAr,
  hasStrayLatin,
  renderHandoverAr,
  writeNarrative,
  type HandoverCaller,
  type HandoverDb,
  type HandoverNpi,
} from '../src/positions/handover';
import { HANDOVER_PERMISSION, type HandoverBody } from '../src/positions/handover-types';
import { Pseudonymizer } from '../src/privacy/pseudonymizer';

// ─── Wire fixtures (ApprovalRequestView, apps/api/src/common/approval.service.ts:64-84) ──

const T = (iso: string) => `${iso}T12:00:00.000Z`;

function wireStep(sequence: number, roleId: string, o: Record<string, unknown> = {}) {
  return {
    sequence,
    status: 'PENDING',
    role: { id: roleId, nameAr: `دور ${roleId}`, nameEn: roleId },
    decidedBy: null,
    decidedAt: null,
    note: null,
    escalatedAt: null,
    ...o,
  };
}

function wireChain(o: Record<string, unknown> = {}) {
  return {
    id: 'apr_1',
    documentType: 'PURCHASE_REQUISITION',
    documentId: 'doc_1',
    documentCode: 'PR-00025',
    amount: 12800,
    status: 'PENDING',
    currentStep: 1,
    currentStepAt: T('2026-09-20'),
    createdAt: T('2026-09-19'),
    closedAt: null,
    raisedBy: { id: 'u_eng', nameAr: 'خالد العتيبي', nameEn: 'Khaled' },
    steps: [wireStep(1, 'role_pm'), wireStep(2, 'role_admin')],
    ...o,
  };
}

function chain(o: Partial<NpiApprovalChain> = {}): NpiApprovalChain {
  return {
    id: 'apr_1',
    documentType: 'PURCHASE_REQUISITION',
    documentCode: 'PR-00025',
    amount: 12800,
    status: 'PENDING',
    currentStep: 1,
    currentStepAt: T('2026-09-20'),
    raisedBy: null,
    steps: [
      { sequence: 1, status: 'PENDING', roleId: 'role_pm', roleNameAr: 'م', escalatedAt: null },
      { sequence: 2, status: 'PENDING', roleId: 'role_admin', roleNameAr: 'م', escalatedAt: null },
    ],
    ...o,
  };
}

// ─── src/npi/approvals.ts ───────────────────────────────────────────────────

describe('readApprovalHistory', () => {
  it('reads a wire-shaped body: number amount, ISO dates, raisedBy null, nested role', () => {
    const body = {
      total: 2,
      rows: [
        wireChain(),
        wireChain({ id: 'apr_2', raisedBy: null, steps: [wireStep(1, 'role_pm', { escalatedAt: T('2026-09-25') })] }),
      ],
    };
    const read = readApprovalHistory(body);
    expect(read.total).toBe(2);
    expect(read.rows).toHaveLength(2);
    expect(read.rows[0]).toEqual({
      id: 'apr_1',
      documentType: 'PURCHASE_REQUISITION',
      documentCode: 'PR-00025',
      amount: 12800,
      status: 'PENDING',
      currentStep: 1,
      currentStepAt: T('2026-09-20'),
      raisedBy: { id: 'u_eng', nameAr: 'خالد العتيبي' },
      steps: [
        { sequence: 1, status: 'PENDING', roleId: 'role_pm', roleNameAr: 'دور role_pm', escalatedAt: null },
        { sequence: 2, status: 'PENDING', roleId: 'role_admin', roleNameAr: 'دور role_admin', escalatedAt: null },
      ],
    });
    expect(read.rows[1].raisedBy).toBeNull();
    expect(read.rows[1].steps[0].escalatedAt).toBe(T('2026-09-25'));
  });

  it('accepts an empty page', () => {
    expect(readApprovalHistory({ total: 0, rows: [] })).toEqual({ total: 0, rows: [] });
  });

  const bad: Array<[string, unknown, RegExp]> = [
    ['a body that is not an object', [], /body is not an object/],
    ['a missing total', { rows: [] }, /"total"/],
    ['rows that are not an array', { total: 0, rows: {} }, /"rows"/],
    ['a string amount (NPI sends a number)', { total: 1, rows: [wireChain({ amount: '12800.00' })] }, /"amount"/],
    ['a non-finite amount', { total: 1, rows: [wireChain({ amount: Number.POSITIVE_INFINITY })] }, /"amount"/],
    ['a missing documentCode', { total: 1, rows: [wireChain({ documentCode: undefined })] }, /"documentCode"/],
    ['a currentStepAt that is not a date', { total: 1, rows: [wireChain({ currentStepAt: 'not a date' })] }, /currentStepAt/],
    ['a missing currentStep', { total: 1, rows: [wireChain({ currentStep: undefined })] }, /"currentStep"/],
    ['steps that are not an array', { total: 1, rows: [wireChain({ steps: null })] }, /"steps"/],
    [
      'a step with no role',
      { total: 1, rows: [wireChain({ steps: [{ ...wireStep(1, 'r'), role: undefined }] })] },
      /"role"/,
    ],
    [
      'an escalatedAt that is not a date',
      { total: 1, rows: [wireChain({ steps: [wireStep(1, 'r', { escalatedAt: 'x' })] })] },
      /escalatedAt/,
    ],
    ['a raisedBy that is not { id, nameAr }', { total: 1, rows: [wireChain({ raisedBy: { id: 1 } })] }, /"raisedBy"/],
  ];
  it.each(bad)('is "unexpected" for %s, naming the field', (_label, body, detail) => {
    let thrown: unknown;
    try {
      readApprovalHistory(body);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NpiError);
    expect((thrown as NpiError).kind).toBe('unexpected');
    expect((thrown as NpiError).message).toMatch(detail);
  });
});

describe('readVendorsBrief', () => {
  it('reads the bare array NPI returns (id, code, nameAr; the rest is ignored)', () => {
    const body = [
      { id: 'ven_1', code: 'VEN-00001', nameAr: 'شركة الخليج', nameEn: 'Gulf', vendorType: 'SUPPLIER', _count: { purchaseOrders: 3 } },
    ];
    expect(readVendorsBrief(body)).toEqual([{ id: 'ven_1', code: 'VEN-00001', nameAr: 'شركة الخليج' }]);
  });

  it('is "unexpected" for an envelope, or a row missing a field', () => {
    expect(() => readVendorsBrief({ rows: [], total: 0 })).toThrow(NpiError);
    expect(() => readVendorsBrief([{ id: 'v', code: 'VEN-00001' }])).toThrow(/"nameAr"/);
    expect(() => readVendorsBrief([{ id: 'v', nameAr: 'x' }])).toThrow(/"code"/);
    expect(() => readVendorsBrief(['x'])).toThrow(NpiError);
  });
});

describe('waitingOnRole', () => {
  it('lists a PENDING chain whose current step is on the role', () => {
    expect(waitingOnRole([chain()], 'role_pm').map((c) => c.id)).toEqual(['apr_1']);
  });

  it('does not list a chain whose current step is on another role, even if a later step is the role\'s', () => {
    const later = chain({
      id: 'apr_2',
      currentStep: 1,
      steps: [
        { sequence: 1, status: 'PENDING', roleId: 'role_acc', roleNameAr: 'م', escalatedAt: null },
        { sequence: 2, status: 'PENDING', roleId: 'role_pm', roleNameAr: 'م', escalatedAt: null },
      ],
    });
    expect(waitingOnRole([later], 'role_pm')).toEqual([]);
  });

  it('lists the chain once its turn comes (current step 2 on the role, step 1 already approved)', () => {
    const second = chain({
      id: 'apr_3',
      currentStep: 2,
      steps: [
        { sequence: 1, status: 'APPROVED', roleId: 'role_acc', roleNameAr: 'م', escalatedAt: null },
        { sequence: 2, status: 'PENDING', roleId: 'role_pm', roleNameAr: 'م', escalatedAt: null },
      ],
    });
    expect(waitingOnRole([second], 'role_pm').map((c) => c.id)).toEqual(['apr_3']);
  });

  it('does not list a PENDING chain whose current step is already APPROVED', () => {
    const stale = chain({
      id: 'apr_4',
      steps: [{ sequence: 1, status: 'APPROVED', roleId: 'role_pm', roleNameAr: 'م', escalatedAt: null }],
    });
    expect(waitingOnRole([stale], 'role_pm')).toEqual([]);
  });

  it('does not list a chain that is not PENDING, nor one whose current step does not exist', () => {
    expect(waitingOnRole([chain({ id: 'a', status: 'APPROVED' }), chain({ id: 'b', status: 'REJECTED' })], 'role_pm')).toEqual([]);
    expect(waitingOnRole([chain({ id: 'c', currentStep: 5 })], 'role_pm')).toEqual([]);
  });
});

// ─── buildHandoverBody ──────────────────────────────────────────────────────

const ORG = 'org_1';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const POSITION = {
  id: 'pos_pm',
  npiOrgId: ORG,
  roleKey: 'pm',
  departmentId: null as string | null,
  titleAr: 'مدير المشاريع',
};

interface FakeFact {
  id: string;
  npiOrgId: string;
  scope: 'company' | 'position';
  positionId: string | null;
  entityType: string;
  npiEntityId: string | null;
  factAr: string;
  valueJson: unknown;
  sourceType: 'npi' | 'chat';
  sourcePermission: string | null;
  useCount: number;
  updatedAt: Date;
}

let factSeq = 0;
function fact(o: Partial<FakeFact> & { factAr: string }): FakeFact {
  factSeq += 1;
  return {
    id: `fact_${factSeq}`,
    npiOrgId: ORG,
    scope: 'company',
    positionId: null,
    entityType: 'vendor',
    npiEntityId: null,
    valueJson: null,
    sourceType: 'chat',
    sourcePermission: null,
    useCount: 0,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...o,
  };
}

/** Just enough of Prisma's `where` for the four reads `buildHandoverBody` makes
 *  (`OR`, `AND`, `valueJson.path`, `{ in: [...] }` and plain equality). */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Record<string, unknown>[]).some((sub) => matches(row, sub));
    if (key === 'AND') return (value as Record<string, unknown>[]).every((sub) => matches(row, sub));
    if (key === 'valueJson') {
      const { path: p, equals } = value as { path: string[]; equals: unknown };
      const json = row.valueJson as Record<string, unknown> | null;
      return json !== null && typeof json === 'object' && json[p[0]] === equals;
    }
    if (value !== null && typeof value === 'object' && 'in' in value) {
      return (value as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === value;
  });
}

function fakeDb(facts: FakeFact[], positions: Array<typeof POSITION> = [POSITION]): HandoverDb {
  return {
    position: {
      findFirst: async ({ where }: { where: { id: string; npiOrgId: string } }) =>
        positions.find((p) => p.id === where.id && p.npiOrgId === where.npiOrgId) ?? null,
    },
    positionAssignment: {},
    memoryFact: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        facts
          .filter((f) => matches(f as unknown as Record<string, unknown>, where))
          .sort((a, b) => b.useCount - a.useCount || b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, take ?? facts.length),
    },
  } as unknown as HandoverDb;
}

const ROLES_WIRE = [
  { id: 'role_pm', key: 'pm', nameAr: 'مدير المشاريع', nameEn: 'PM', permissions: [] },
  { id: 'role_acc', key: 'accountant', nameAr: 'المحاسب', nameEn: 'Acc', permissions: [] },
];
const DIRECTORY_WIRE = [
  { id: 'u_pm1', nameAr: 'سعد الحربي', isActive: true, role: { key: 'pm' }, departmentId: 'dep_1' },
  { id: 'u_pm2', nameAr: 'ماجد القحطاني', isActive: true, role: { key: 'pm' }, departmentId: null },
];
const DEPARTMENTS_WIRE = [{ id: 'dep_1', code: 'PRJ', nameAr: 'المشاريع', isActive: true }];
const VENDORS_WIRE = [
  { id: 'ven_1', code: 'VEN-00001', nameAr: 'شركة الخليج للألواح الشمسية' },
  { id: 'ven_2', code: 'VEN-00002', nameAr: 'مصنع النور للكابلات' },
];

function fakeNpi(o: Partial<Record<keyof HandoverNpi, () => Promise<unknown>>> = {}) {
  return {
    listApprovalHistory: jest.fn(o.listApprovalHistory ?? (async () => ({ total: 0, rows: [] }))),
    listRoles: jest.fn(o.listRoles ?? (async () => ROLES_WIRE)),
    listDepartments: jest.fn(o.listDepartments ?? (async () => DEPARTMENTS_WIRE)),
    listDepartmentDirectory: jest.fn(o.listDepartmentDirectory ?? (async () => DIRECTORY_WIRE)),
    listVendors: jest.fn(o.listVendors ?? (async () => VENDORS_WIRE)),
  };
}

const ALL_PERMISSIONS = Object.values(HANDOVER_PERMISSION);
const ADMIN: HandoverCaller = { npiOrgId: ORG, npiUserId: 'u_admin', permissions: ALL_PERMISSIONS };
const INPUT: {
  positionId: string;
  successor: { npiUserId: string };
  predecessor: { npiUserId: string; since: Date } | null;
} = {
  positionId: POSITION.id,
  successor: { npiUserId: 'u_pm2' },
  predecessor: { npiUserId: 'u_pm1', since: new Date('2026-03-02T12:00:00.000Z') },
};

function build(
  npi: ReturnType<typeof fakeNpi>,
  facts: FakeFact[] = [],
  caller: HandoverCaller = ADMIN,
  input = INPUT,
  positions: Array<typeof POSITION> = [POSITION],
) {
  return buildHandoverBody({ db: fakeDb(facts, positions), npi: npi as unknown as HandoverNpi, now: () => NOW }, caller, input);
}

describe('buildHandoverBody: the header and the people', () => {
  it('names the position, the predecessor with the date they started, and the successor', async () => {
    const body = await build(fakeNpi());
    expect(body.version).toBe(1);
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.position).toEqual({
      id: 'pos_pm',
      roleKey: 'pm',
      roleNameAr: 'مدير المشاريع',
      departmentId: null,
      departmentNameAr: null,
      titleAr: 'مدير المشاريع',
    });
    expect(body.predecessor).toEqual({ npiUserId: 'u_pm1', nameAr: 'سعد الحربي', since: '2026-03-02T12:00:00.000Z' });
    expect(body.successor).toEqual({ npiUserId: 'u_pm2', nameAr: 'ماجد القحطاني' });
    expect(body.narrative).toEqual({ status: 'skipped' });
  });

  it('has a null predecessor when the position had no holder', async () => {
    const body = await build(fakeNpi(), [], ADMIN, { ...INPUT, predecessor: null });
    expect(body.predecessor).toBeNull();
  });

  it('reads the department name only when the position has a department', async () => {
    const noDept = fakeNpi();
    await build(noDept);
    expect(noDept.listDepartments).not.toHaveBeenCalled();

    const withDept = fakeNpi();
    const body = await build(withDept, [], ADMIN, INPUT, [{ ...POSITION, departmentId: 'dep_1' }]);
    expect(withDept.listDepartments).toHaveBeenCalledTimes(1);
    expect(body.position.departmentId).toBe('dep_1');
    expect(body.position.departmentNameAr).toBe('المشاريع');
  });

  it('refuses a position of another organization (the backstop)', async () => {
    await expect(build(fakeNpi(), [], { ...ADMIN, npiOrgId: 'org_other' })).rejects.toThrow('position not found');
    await expect(build(fakeNpi(), [], ADMIN, { ...INPUT, positionId: 'pos_missing' })).rejects.toThrow('position not found');
  });

  it('leaves a name null when the directory does not list the user', async () => {
    const body = await build(fakeNpi(), [], ADMIN, { ...INPUT, successor: { npiUserId: 'u_unknown' } });
    expect(body.successor.nameAr).toBeNull();
  });
});

describe('buildHandoverBody: each NPI read is gated by its permission (08 §E.10)', () => {
  it('a caller with no permission makes no NPI call at all and gets a skipped section', async () => {
    const npi = fakeNpi();
    const facts = [fact({ factAr: 'المورد مصنع النور يسلّم خلال 10 أيام.', npiEntityId: 'ven_1' })];
    const body = await build(npi, facts, { ...ADMIN, permissions: [] });
    expect(body.tasks).toEqual({ status: 'skipped', reason: 'no_permission' });
    for (const call of Object.values(npi)) expect(call).not.toHaveBeenCalled();
    expect(body.position.roleNameAr).toBeNull();
    expect(body.predecessor?.nameAr).toBeNull();
    expect(body.successor.nameAr).toBeNull();
    expect(body.vendors[0].nameAr).toBeNull();
    expect(body.vendors[0].code).toBeNull();
  });

  it('with only the approvals permission the tasks are skipped and neither the roles nor the history are read', async () => {
    const npi = fakeNpi();
    const body = await build(npi, [], { ...ADMIN, permissions: [HANDOVER_PERMISSION.approvals] });
    expect(body.tasks).toEqual({ status: 'skipped', reason: 'no_permission' });
    expect(npi.listRoles).not.toHaveBeenCalled();
    expect(npi.listApprovalHistory).not.toHaveBeenCalled();
  });

  it('with only the roles permission the role is named but the history is not read', async () => {
    const npi = fakeNpi();
    const body = await build(npi, [], { ...ADMIN, permissions: [HANDOVER_PERMISSION.roles] });
    expect(body.tasks).toEqual({ status: 'skipped', reason: 'no_permission' });
    expect(npi.listRoles).toHaveBeenCalledTimes(1);
    expect(npi.listApprovalHistory).not.toHaveBeenCalled();
    expect(body.position.roleNameAr).toBe('مدير المشاريع');
  });

  it('without the directory permission neither the directory nor the departments are read', async () => {
    const npi = fakeNpi();
    const permissions = ALL_PERMISSIONS.filter((p) => p !== HANDOVER_PERMISSION.directory);
    const body = await build(npi, [], { ...ADMIN, permissions }, INPUT, [{ ...POSITION, departmentId: 'dep_1' }]);
    expect(npi.listDepartmentDirectory).not.toHaveBeenCalled();
    expect(npi.listDepartments).not.toHaveBeenCalled();
    expect(body.successor.nameAr).toBeNull();
    expect(body.position.departmentNameAr).toBeNull();
  });

  it('without the vendors permission the vendor list is not read', async () => {
    const npi = fakeNpi();
    const permissions = ALL_PERMISSIONS.filter((p) => p !== HANDOVER_PERMISSION.vendors);
    await build(npi, [fact({ factAr: 'x', npiEntityId: 'ven_1' })], { ...ADMIN, permissions });
    expect(npi.listVendors).not.toHaveBeenCalled();
  });

  it('does not read the vendor list when no vendor fact carries an NPI id', async () => {
    const npi = fakeNpi();
    await build(npi, [fact({ factAr: 'المورد مصنع النور يشترط دفعة مقدمة.' })]);
    expect(npi.listVendors).not.toHaveBeenCalled();
  });
});

describe('buildHandoverBody: a failed read is named, never "nothing is waiting"', () => {
  const forbidden = () => Promise.reject(new NpiError({ status: 403, kind: 'forbidden', npiMessage: null }));
  const timeout = () => Promise.reject(new NpiError({ status: 0, kind: 'timeout', npiMessage: null }));

  it('403 on the history → tasks skipped npi_refused', async () => {
    const body = await build(fakeNpi({ listApprovalHistory: forbidden }));
    expect(body.tasks).toEqual({ status: 'skipped', reason: 'npi_refused' });
  });

  it('another NpiError on the history → npi_error', async () => {
    const body = await build(fakeNpi({ listApprovalHistory: timeout }));
    expect(body.tasks).toEqual({ status: 'skipped', reason: 'npi_error' });
  });

  it('a history body the reader rejects → npi_error', async () => {
    const body = await build(fakeNpi({ listApprovalHistory: async () => ({ total: 1, rows: [wireChain({ amount: 'x' })] }) }));
    expect(body.tasks).toEqual({ status: 'skipped', reason: 'npi_error' });
  });

  it('403 on the roles → the tasks cannot be filtered, so skipped npi_refused; the history is not read', async () => {
    const npi = fakeNpi({ listRoles: forbidden });
    const body = await build(npi);
    expect(body.tasks).toEqual({ status: 'skipped', reason: 'npi_refused' });
    expect(npi.listApprovalHistory).not.toHaveBeenCalled();
    expect(body.position.roleNameAr).toBeNull();
  });

  it('an unreadable directory or department list leaves the names null and never fails the build', async () => {
    const body = await build(fakeNpi({ listDepartmentDirectory: timeout, listDepartments: forbidden }), [], ADMIN, INPUT, [
      { ...POSITION, departmentId: 'dep_1' },
    ]);
    expect(body.predecessor?.nameAr).toBeNull();
    expect(body.successor.nameAr).toBeNull();
    expect(body.position.departmentNameAr).toBeNull();
    expect(body.tasks.status).toBe('read');
  });

  it('an unreadable vendor list leaves name and code null', async () => {
    const body = await build(fakeNpi({ listVendors: forbidden }), [fact({ factAr: 'يسلّم خلال 10 أيام.', npiEntityId: 'ven_1' })]);
    expect(body.vendors).toEqual([{ npiVendorId: 'ven_1', nameAr: null, code: null, factsAr: ['يسلّم خلال 10 أيام.'] }]);
  });

  it('a non-NpiError is a bug and propagates', async () => {
    const boom = () => Promise.reject(new TypeError('boom'));
    await expect(build(fakeNpi({ listApprovalHistory: boom }))).rejects.toThrow('boom');
    await expect(build(fakeNpi({ listRoles: boom }))).rejects.toThrow('boom');
    await expect(build(fakeNpi({ listDepartmentDirectory: boom }))).rejects.toThrow('boom');
    await expect(
      build(fakeNpi({ listVendors: boom }), [fact({ factAr: 'x', npiEntityId: 'ven_1' })]),
    ).rejects.toThrow('boom');
  });
});

describe('buildHandoverBody: tasks', () => {
  it('asks NPI for the pending chains, 200 at a time', async () => {
    const npi = fakeNpi();
    await build(npi);
    expect(npi.listApprovalHistory).toHaveBeenCalledWith({ status: 'PENDING', take: 200 });
  });

  it('lists only the chains waiting on the position\'s role, oldest first, with the step, the escalation and who raised it', async () => {
    const rows = [
      wireChain({ id: 'apr_new', documentCode: 'PR-00030', currentStepAt: T('2026-10-01') }),
      wireChain({
        id: 'apr_old',
        documentType: 'PURCHASE_ORDER',
        documentCode: 'PO-00007',
        amount: 98500.5,
        currentStep: 2,
        currentStepAt: T('2026-09-10'),
        raisedBy: null,
        steps: [
          wireStep(1, 'role_acc', { status: 'APPROVED' }),
          wireStep(2, 'role_pm', { escalatedAt: T('2026-09-15') }),
          wireStep(3, 'role_admin'),
        ],
      }),
      wireChain({ id: 'apr_acc', documentCode: 'PR-00031', steps: [wireStep(1, 'role_acc')] }),
      wireChain({ id: 'apr_done', documentCode: 'PR-00032', status: 'APPROVED', steps: [wireStep(1, 'role_pm', { status: 'APPROVED' })] }),
    ];
    const body = await build(fakeNpi({ listApprovalHistory: async () => ({ total: 4, rows }) }));
    expect(body.tasks).toEqual({
      status: 'read',
      items: [
        {
          id: 'apr_old',
          documentType: 'PURCHASE_ORDER',
          documentCode: 'PO-00007',
          amount: 98500.5,
          currentStep: 2,
          stepCount: 3,
          waitingSince: T('2026-09-10'),
          raisedByNameAr: null,
          escalated: true,
        },
        {
          id: 'apr_new',
          documentType: 'PURCHASE_REQUISITION',
          documentCode: 'PR-00030',
          amount: 12800,
          currentStep: 1,
          stepCount: 2,
          waitingSince: T('2026-10-01'),
          raisedByNameAr: 'خالد العتيبي',
          escalated: false,
        },
      ],
    });
  });

  it('keeps at most 50, the oldest', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      wireChain({
        id: `apr_${i}`,
        documentCode: `PR-${String(i + 1).padStart(5, '0')}`,
        // Newest first, as NPI returns the history.
        currentStepAt: new Date(Date.UTC(2026, 8, 1) + (60 - i) * 3_600_000).toISOString(),
      }),
    );
    const body = await build(fakeNpi({ listApprovalHistory: async () => ({ total: 60, rows }) }));
    if (body.tasks.status !== 'read') throw new Error('expected a read section');
    expect(body.tasks.items).toHaveLength(50);
    const times = body.tasks.items.map((task) => Date.parse(task.waitingSince));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // The ten newest chains are the ones cut.
    expect(body.tasks.items[0].id).toBe('apr_59');
    expect(body.tasks.items.map((task) => task.id)).not.toContain('apr_0');
  });

  it('is an empty read section (not a skipped one) when the role has nothing waiting', async () => {
    const body = await build(fakeNpi());
    expect(body.tasks).toEqual({ status: 'read', items: [] });
  });

  it('is an empty read section when NPI no longer lists the position\'s role', async () => {
    const npi = fakeNpi({ listRoles: async () => [ROLES_WIRE[1]] });
    const body = await build(npi);
    expect(body.tasks).toEqual({ status: 'read', items: [] });
    expect(npi.listApprovalHistory).not.toHaveBeenCalled();
  });
});

describe('buildHandoverBody: vendors', () => {
  const T0 = new Date('2026-09-01T00:00:00.000Z');

  it('groups per D-T30-6: one group per vendor id, one per recurring item\'s last vendor, one per id-less sentence', async () => {
    const facts = [
      fact({
        factAr: 'يسلّم المورد شركة الخليج خلال 10 أيام.',
        npiEntityId: 'ven_1',
        sourceType: 'npi',
        useCount: 2,
        valueJson: { kind: 'vendor_lead_time', key: 'vendor_lead_time:ven_1', vendorId: 'ven_1' },
      }),
      fact({ factAr: 'المورد شركة الخليج يفضّل التواصل بالبريد.', npiEntityId: 'ven_1', useCount: 5 }),
      fact({
        factAr: 'يتكرر طلب اللوح الشمسي 550 واط.',
        entityType: 'item',
        npiEntityId: 'itm_1',
        sourceType: 'npi',
        useCount: 3,
        valueJson: { kind: 'recurring_item', key: 'recurring_item:itm_1', lastVendorId: 'ven_2', vendorIds: ['ven_2'] },
      }),
      fact({ factAr: 'المورد مصنع الصحراء يشترط دفعة مقدمة 50%.', useCount: 1 }),
      fact({ factAr: 'مورد المحولات يسلّم من المستودع.', scope: 'position', positionId: 'pos_pm', npiEntityId: 'ven_3' }),
      // Not this position's, not this organization's, not about a vendor.
      fact({ factAr: 'مورد آخر منصب آخر.', scope: 'position', positionId: 'pos_other', npiEntityId: 'ven_9', useCount: 99 }),
      fact({ factAr: 'مورد منشأة أخرى.', npiOrgId: 'org_other', npiEntityId: 'ven_8', useCount: 99 }),
      fact({ factAr: 'عميل لا مورد.', entityType: 'customer', npiEntityId: 'cus_1', useCount: 99 }),
    ];
    const body = await build(fakeNpi(), facts);

    expect(body.vendors).toEqual([
      {
        npiVendorId: 'ven_1',
        nameAr: 'شركة الخليج للألواح الشمسية',
        code: 'VEN-00001',
        // Most used first: the chat sentence (5) before the NPI lead time (2).
        factsAr: ['المورد شركة الخليج يفضّل التواصل بالبريد.', 'يسلّم المورد شركة الخليج خلال 10 أيام.'],
      },
      {
        npiVendorId: 'ven_2',
        nameAr: 'مصنع النور للكابلات',
        code: 'VEN-00002',
        factsAr: ['يتكرر طلب اللوح الشمسي 550 واط.'],
      },
      { npiVendorId: null, nameAr: null, code: null, factsAr: ['المورد مصنع الصحراء يشترط دفعة مقدمة 50%.'] },
      { npiVendorId: 'ven_3', nameAr: null, code: null, factsAr: ['مورد المحولات يسلّم من المستودع.'] },
    ]);
  });

  it('a vendor_lead_time fact and a chat fact on the same vendor id are one group with two sentences', async () => {
    const facts = [
      fact({ factAr: 'المدة 10 أيام.', npiEntityId: 'ven_1', sourceType: 'npi', valueJson: { kind: 'vendor_lead_time', key: 'k', vendorId: 'ven_1' } }),
      fact({ factAr: 'يشترط دفعة مقدمة.', npiEntityId: 'ven_1' }),
    ];
    const body = await build(fakeNpi(), facts);
    expect(body.vendors).toHaveLength(1);
    expect(body.vendors[0].factsAr).toHaveLength(2);
  });

  it('puts a recurring item under its last vendor even when that vendor has no vendor fact, and ignores one with no last vendor', async () => {
    const facts = [
      fact({ factAr: 'بند متكرر أ.', entityType: 'item', npiEntityId: 'itm_1', valueJson: { kind: 'recurring_item', key: 'a', lastVendorId: 'ven_1' } }),
      fact({ factAr: 'بند متكرر ب.', entityType: 'item', npiEntityId: 'itm_2', valueJson: { kind: 'recurring_item', key: 'b' } }),
    ];
    const body = await build(fakeNpi(), facts);
    expect(body.vendors).toEqual([
      { npiVendorId: 'ven_1', nameAr: 'شركة الخليج للألواح الشمسية', code: 'VEN-00001', factsAr: ['بند متكرر أ.'] },
    ]);
  });

  it('gives an id-less sentence its own group per distinct (normalized) sentence', async () => {
    const facts = [
      fact({ factAr: 'المورد النور يسلّم بسرعة.' }),
      fact({ factAr: 'المورد الصحراء يسلّم ببطء.' }),
    ];
    const body = await build(fakeNpi(), facts);
    expect(body.vendors).toHaveLength(2);
    expect(body.vendors.every((v) => v.npiVendorId === null && v.factsAr.length === 1)).toBe(true);
  });

  it('merges an id-less chat sentence into the NPI-named vendor whose name it contains (one vendor, one entry)', async () => {
    const facts = [
      fact({
        factAr: 'مدة توريد المورّد شركة الخليج للألواح الشمسية (VEN-00001) نحو 10 أيام.',
        npiEntityId: 'ven_1',
        sourceType: 'npi',
        useCount: 1,
        valueJson: { kind: 'vendor_lead_time', key: 'vendor_lead_time:ven_1', vendorId: 'ven_1' },
      }),
      // The chat stores the sentence only (no NPI id); the name inside it is the join.
      fact({ factAr: 'المورد شركة الخليج للألواح الشمسية يسلّم خلال 10 أيام من الاعتماد.', useCount: 4 }),
      // Names no vendor NPI lists: stays a group of its own.
      fact({ factAr: 'المورد مصنع الصحراء يشترط دفعة مقدمة 50%.', useCount: 2 }),
    ];
    const body = await build(fakeNpi(), facts);
    expect(body.vendors.map((v) => v.nameAr)).toEqual(['شركة الخليج للألواح الشمسية', null]);
    expect(body.vendors[0].factsAr).toEqual([
      'المورد شركة الخليج للألواح الشمسية يسلّم خلال 10 أيام من الاعتماد.',
      'مدة توريد المورّد شركة الخليج للألواح الشمسية (VEN-00001) نحو 10 أيام.',
    ]);
    expect(body.vendors[1].factsAr).toEqual(['المورد مصنع الصحراء يشترط دفعة مقدمة 50%.']);
  });

  it('orders groups by total use then name, keeps at most 20, and facts by use then recency', async () => {
    const facts = Array.from({ length: 25 }, (_, i) => fact({ factAr: `المورد رقم ${i + 1} جيد.`, useCount: i }));
    const body = await build(fakeNpi(), facts);
    expect(body.vendors).toHaveLength(20);
    expect(body.vendors[0].factsAr).toEqual(['المورد رقم 25 جيد.']);

    const tie = [
      fact({ factAr: 'قديم.', npiEntityId: 'ven_1', useCount: 1, updatedAt: T0 }),
      fact({ factAr: 'جديد.', npiEntityId: 'ven_1', useCount: 1, updatedAt: new Date('2026-09-30T00:00:00.000Z') }),
    ];
    const grouped = await build(fakeNpi(), tie);
    expect(grouped.vendors[0].factsAr).toEqual(['جديد.', 'قديم.']);
  });
});

describe('buildHandoverBody: routines and company facts', () => {
  it('routines are this position\'s own facts, most used first then newest, at most 30', async () => {
    const facts = [
      ...Array.from({ length: 35 }, (_, i) =>
        fact({ factAr: `إجراء ${i}.`, scope: 'position', positionId: 'pos_pm', entityType: 'position', useCount: i }),
      ),
      fact({ factAr: 'إجراء منصب آخر.', scope: 'position', positionId: 'pos_other', entityType: 'position', useCount: 100 }),
      fact({ factAr: 'حقيقة شركة.', entityType: 'project', useCount: 100 }),
    ];
    const body = await build(fakeNpi(), facts);
    expect(body.routines).toHaveLength(30);
    expect(body.routines[0].factAr).toBe('إجراء 34.');
    expect(body.routines.map((r) => r.factAr)).not.toContain('إجراء منصب آخر.');
    expect(body.routines[0]).toEqual({ factId: expect.any(String), factAr: 'إجراء 34.', sourceType: 'chat' });

    const tie = [
      fact({ factAr: 'أقدم.', scope: 'position', positionId: 'pos_pm', entityType: 'position', useCount: 2, updatedAt: new Date('2026-08-01T00:00:00.000Z') }),
      fact({ factAr: 'أحدث.', scope: 'position', positionId: 'pos_pm', entityType: 'position', useCount: 2, updatedAt: new Date('2026-09-01T00:00:00.000Z') }),
    ];
    expect((await build(fakeNpi(), tie)).routines.map((r) => r.factAr)).toEqual(['أحدث.', 'أقدم.']);
  });

  it('company facts are only the three newcomer kinds, most used first, at most 15', async () => {
    const kinds = ['customer_credit_terms', 'contract_payment_terms', 'active_project'];
    const facts = [
      ...Array.from({ length: 20 }, (_, i) =>
        fact({
          factAr: `حقيقة ${i}.`,
          entityType: 'customer',
          sourceType: 'npi',
          useCount: i,
          valueJson: { kind: kinds[i % 3], key: `${kinds[i % 3]}:${i}` },
        }),
      ),
      fact({ factAr: 'مدة التوريد.', entityType: 'vendor', sourceType: 'npi', useCount: 500, valueJson: { kind: 'vendor_lead_time', key: 'k', vendorId: 'v' } }),
      fact({ factAr: 'كلام محادثة عن عميل.', entityType: 'customer', useCount: 500 }),
      fact({ factAr: 'من منصب.', scope: 'position', positionId: 'pos_pm', entityType: 'project', useCount: 500, valueJson: { kind: 'active_project', key: 'z' } }),
    ];
    const body = await build(fakeNpi(), facts);
    expect(body.companyFacts).toHaveLength(15);
    expect(body.companyFacts[0].factAr).toBe('حقيقة 19.');
    expect(body.companyFacts.every((f) => f.sourceType === 'npi')).toBe(true);
    const texts = body.companyFacts.map((f) => f.factAr);
    expect(texts).not.toContain('مدة التوريد.');
    expect(texts).not.toContain('كلام محادثة عن عميل.');
    expect(texts).not.toContain('من منصب.');
  });

  it('D-17: a company fact whose source permission the caller lacks is left out (contract terms need commercial.contract.read)', async () => {
    const facts = [
      fact({
        factAr: 'شروط عقد CTR-00008.',
        entityType: 'customer',
        sourceType: 'npi',
        sourcePermission: 'commercial.contract.read',
        valueJson: { kind: 'contract_payment_terms', key: 'contract_payment_terms:c8' },
      }),
      fact({
        factAr: 'أجل سداد عميل.',
        entityType: 'customer',
        sourceType: 'npi',
        sourcePermission: 'crm.customer.read',
        valueJson: { kind: 'customer_credit_terms', key: 'customer_credit_terms:u1' },
      }),
      fact({
        factAr: 'مشروع بلا صلاحية مصدر.',
        entityType: 'project',
        sourceType: 'npi',
        valueJson: { kind: 'active_project', key: 'active_project:p1' },
      }),
    ];
    const withoutContract = await build(fakeNpi(), facts, { ...ADMIN, permissions: [...ALL_PERMISSIONS, 'crm.customer.read'] });
    expect(withoutContract.companyFacts.map((f) => f.factAr).sort()).toEqual(['أجل سداد عميل.', 'مشروع بلا صلاحية مصدر.'].sort());

    const none = await build(fakeNpi(), facts, { ...ADMIN, permissions: [] });
    expect(none.companyFacts.map((f) => f.factAr)).toEqual(['مشروع بلا صلاحية مصدر.']);

    const withContract = await build(fakeNpi(), facts, { ...ADMIN, permissions: [...ALL_PERMISSIONS, 'commercial.contract.read'] });
    expect(withContract.companyFacts.map((f) => f.factAr)).toContain('شروط عقد CTR-00008.');
  });

  it('D-17: the vendor read is filtered the same way (a vendor lead-time fact needs scm.procurement.read; a chat fact needs nothing)', async () => {
    const facts = [
      fact({
        factAr: 'مدة توريد المورد.',
        entityType: 'vendor',
        sourceType: 'npi',
        sourcePermission: 'scm.procurement.read',
        valueJson: { kind: 'vendor_lead_time', key: 'vendor_lead_time:v1', vendorId: 'ven_1' },
      }),
      fact({ factAr: 'ملاحظة محادثة عن المورد.', entityType: 'vendor' }),
    ];
    const sentences = (body: HandoverBody) => body.vendors.flatMap((v) => v.factsAr);
    const lacking = await build(fakeNpi(), facts, { ...ADMIN, permissions: [] });
    expect(sentences(lacking)).toEqual(['ملاحظة محادثة عن المورد.']);
    const holding = await build(fakeNpi(), facts, { ...ADMIN, permissions: ['scm.procurement.read'] });
    expect(sentences(holding).sort()).toEqual(['ملاحظة محادثة عن المورد.', 'مدة توريد المورد.'].sort());
  });
});

// ─── renderHandoverAr ───────────────────────────────────────────────────────

function representativeBody(): HandoverBody {
  return {
    version: 1,
    generatedAt: T('2026-10-06'),
    position: {
      id: 'pos_pm',
      roleKey: 'pm',
      roleNameAr: 'مدير المشاريع',
      departmentId: 'dep_1',
      departmentNameAr: 'المشاريع',
      titleAr: 'مدير المشاريع — المشاريع',
    },
    predecessor: { npiUserId: 'u_pm1', nameAr: 'سعد الحربي', since: T('2026-03-02') },
    successor: { npiUserId: 'u_pm2', nameAr: 'ماجد القحطاني' },
    tasks: {
      status: 'read',
      items: [
        {
          id: 'apr_1',
          documentType: 'PURCHASE_REQUISITION',
          documentCode: 'PR-00025',
          amount: 12800,
          currentStep: 2,
          stepCount: 3,
          waitingSince: T('2026-09-20'),
          raisedByNameAr: 'خالد العتيبي',
          escalated: true,
        },
        {
          id: 'apr_2',
          documentType: 'PURCHASE_ORDER',
          documentCode: 'PO-00007',
          amount: 98500.5,
          currentStep: 1,
          stepCount: 2,
          waitingSince: T('2026-09-28'),
          raisedByNameAr: null,
          escalated: false,
        },
        {
          id: 'apr_3',
          documentType: 'FUTURE_TYPE',
          documentCode: 'FT-00001',
          amount: 500,
          currentStep: 1,
          stepCount: 1,
          waitingSince: T('2026-10-02'),
          raisedByNameAr: null,
          escalated: false,
        },
      ],
    },
    vendors: [
      {
        npiVendorId: 'ven_1',
        nameAr: 'شركة الخليج للألواح الشمسية',
        code: 'VEN-00001',
        factsAr: ['يسلّم خلال 10 أيام من الاعتماد.', 'يفضّل التواصل بالبريد.'],
      },
      { npiVendorId: null, nameAr: null, code: null, factsAr: ['المورد مصنع النور للكابلات يشترط دفعة مقدمة 50%.'] },
    ],
    routines: [
      { factId: 'f1', factAr: 'يُراجع مدير المشاريع طلبات الشراء المعلقة كل يوم أحد.', sourceType: 'chat' },
    ],
    companyFacts: [
      { factId: 'f2', factAr: 'شروط الدفع للعميل شركة الرياض: 30 يوماً.', sourceType: 'npi' },
    ],
    narrative: {
      status: 'written',
      summaryAr: 'يتولى هذا المنصب متابعة طلبات الشراء المعلقة والتنسيق مع الموردين.',
      firstWeekAr: ['ابدأ بالطلب PR-00025 فهو الأقدم.', 'تعرّف على المورد شركة الخليج للألواح الشمسية.'],
      cautionsAr: ['الاعتماد والرفض في صندوق وارد NPI فقط.'],
      modelId: 'test-model',
      writtenAt: T('2026-10-06'),
    },
  };
}

const D = (iso: string) => formatDate(T(iso));

describe('renderHandoverAr', () => {
  it('renders the representative document exactly', () => {
    const expected = [
      'دليل استلام المنصب: مدير المشاريع — المشاريع',
      `من: سعد الحربي (منذ ${D('2026-03-02')})`,
      'إلى: ماجد القحطاني',
      `أُنشئ في ${D('2026-10-06')}`,
      '',
      'المهام المفتوحة في NPI',
      `- طلب شراء PR-00025 بمبلغ 12,800 ريال، الخطوة 2 من 3، بانتظار منذ ${D('2026-09-20')}، متأخرة، رفعها خالد العتيبي`,
      `- أمر شراء PO-00007 بمبلغ 98,500.5 ريال، الخطوة 1 من 2، بانتظار منذ ${D('2026-09-28')}`,
      `- FUTURE_TYPE FT-00001 بمبلغ 500 ريال، الخطوة 1 من 1، بانتظار منذ ${D('2026-10-02')}`,
      '',
      'الموردون المتعامل معهم',
      '- شركة الخليج للألواح الشمسية (VEN-00001)',
      '  · يسلّم خلال 10 أيام من الاعتماد.',
      '  · يفضّل التواصل بالبريد.',
      '- المورد مصنع النور للكابلات يشترط دفعة مقدمة 50%.',
      '',
      'الإجراءات المعتادة',
      '- يُراجع مدير المشاريع طلبات الشراء المعلقة كل يوم أحد.',
      '',
      'حقائق عن الشركة',
      '- شروط الدفع للعميل شركة الرياض: 30 يوماً.',
      '',
      'ملخص الاستلام',
      'يتولى هذا المنصب متابعة طلبات الشراء المعلقة والتنسيق مع الموردين.',
      'الأسبوع الأول:',
      '- ابدأ بالطلب PR-00025 فهو الأقدم.',
      '- تعرّف على المورد شركة الخليج للألواح الشمسية.',
      'تنبيهات:',
      '- الاعتماد والرفض في صندوق وارد NPI فقط.',
      '',
    ].join('\n');
    expect(renderHandoverAr(representativeBody())).toBe(expected);
  });

  it('is well formed: ends with a newline, no double spaces, sections apart by exactly one blank line', () => {
    const text = renderHandoverAr(representativeBody());
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toMatch(/\n{3,}/);
    // Indented fact lines start with two spaces on purpose; no other run of spaces.
    expect(text.replaceAll(/^ {2}· /gm, '· ')).not.toMatch(/ {2,}/);
  });

  it('has no Latin letters outside document codes, item codes and NPI', () => {
    for (const line of renderHandoverAr(representativeBody()).split('\n')) {
      // FUTURE_TYPE is a raw, unknown NPI document type shown as is (the brief's fallback).
      if (line.includes('FUTURE_TYPE')) continue;
      expect(hasStrayLatin(line)).toBe(false);
    }
  });

  it('omits the «من:» line when there was no predecessor', () => {
    const text = renderHandoverAr({ ...representativeBody(), predecessor: null });
    expect(text).not.toContain('من:');
    expect(text.split('\n').slice(0, 3)).toEqual([
      'دليل استلام المنصب: مدير المشاريع — المشاريع',
      'إلى: ماجد القحطاني',
      `أُنشئ في ${D('2026-10-06')}`,
    ]);
  });

  it('says «غير معروف» for a name it could not read', () => {
    const body = representativeBody();
    const text = renderHandoverAr({
      ...body,
      predecessor: { npiUserId: 'a', nameAr: null, since: T('2026-03-02') },
      successor: { npiUserId: 'b', nameAr: null },
    });
    expect(text).toContain(`من: غير معروف (منذ ${D('2026-03-02')})`);
    expect(text).toContain('إلى: غير معروف');
  });

  it('empty variants: no tasks, no vendors, no routines, no company facts (section omitted), no narrative', () => {
    const text = renderHandoverAr({
      ...representativeBody(),
      tasks: { status: 'read', items: [] },
      vendors: [],
      routines: [],
      companyFacts: [],
      narrative: { status: 'skipped' },
    });
    expect(text).toBe(
      [
        'دليل استلام المنصب: مدير المشاريع — المشاريع',
        `من: سعد الحربي (منذ ${D('2026-03-02')})`,
        'إلى: ماجد القحطاني',
        `أُنشئ في ${D('2026-10-06')}`,
        '',
        'المهام المفتوحة في NPI',
        'لا مهام مفتوحة بانتظار هذا المنصب في NPI.',
        '',
        'الموردون المتعامل معهم',
        'لا موردون مسجّلون في الذاكرة لهذا المنصب.',
        '',
        'الإجراءات المعتادة',
        'لا إجراءات مسجّلة في ذاكرة المنصب بعد.',
        '',
      ].join('\n'),
    );
    expect(text).not.toContain('حقائق عن الشركة');
    expect(text).not.toContain('ملخص الاستلام');
  });

  it.each([
    ['no_permission', 'لا تملك صلاحية قراءة سجل الاعتمادات'],
    ['npi_refused', 'رفض NPI القراءة'],
    ['npi_error', 'تعذر الوصول إلى NPI'],
  ] as const)('a skipped task section (%s) says why and is not "no tasks"', (reason, ar) => {
    const text = renderHandoverAr({ ...representativeBody(), tasks: { status: 'skipped', reason } });
    expect(text).toContain(`تعذر قراءة المهام من NPI: ${ar}`);
    expect(text).not.toContain('لا مهام مفتوحة');
  });

  it('shows no narrative section when it failed', () => {
    const text = renderHandoverAr({
      ...representativeBody(),
      narrative: { status: 'failed', reason: 'timeout', failedAt: T('2026-10-06') },
    });
    expect(text).not.toContain('ملخص الاستلام');
  });

  it('omits an empty «الأسبوع الأول:» or «تنبيهات:» block of a written narrative', () => {
    const body = representativeBody();
    if (body.narrative.status !== 'written') throw new Error('fixture');
    const text = renderHandoverAr({ ...body, narrative: { ...body.narrative, firstWeekAr: [], cautionsAr: [] } });
    expect(text).toContain('ملخص الاستلام');
    expect(text).not.toContain('الأسبوع الأول:');
    expect(text).not.toContain('تنبيهات:');
  });

  it('collapses whitespace and newlines inside a stored sentence into one line', () => {
    const body = representativeBody();
    const text = renderHandoverAr({
      ...body,
      routines: [{ factId: 'f', factAr: 'يراجع   الطلبات\nكل  أحد.', sourceType: 'chat' }],
    });
    expect(text).toContain('- يراجع الطلبات كل أحد.');
  });
});

// ─── handoverGuidanceAr ─────────────────────────────────────────────────────

const CLOSING = 'دليل الاستلام الكامل في صفحة «دليل الاستلام».';

describe('handoverGuidanceAr', () => {
  it('carries who took over what and when, the summary, the first week, the task count, the vendors and the pointer', () => {
    expect(handoverGuidanceAr(representativeBody())).toBe(
      [
        `استلم هذا الموظف منصب مدير المشاريع — المشاريع في ${D('2026-10-06')} خلفاً لـ سعد الحربي.`,
        'يتولى هذا المنصب متابعة طلبات الشراء المعلقة والتنسيق مع الموردين.',
        'الأسبوع الأول:',
        '- ابدأ بالطلب PR-00025 فهو الأقدم.',
        '- تعرّف على المورد شركة الخليج للألواح الشمسية.',
        'المهام المفتوحة في NPI: 3',
        'الموردون: شركة الخليج للألواح الشمسية',
        CLOSING,
      ].join('\n'),
    );
  });

  it('without a written narrative or a known predecessor it is still complete', () => {
    const text = handoverGuidanceAr({
      ...representativeBody(),
      predecessor: null,
      vendors: [],
      tasks: { status: 'read', items: [] },
      narrative: { status: 'failed', reason: 'timeout', failedAt: T('2026-10-06') },
    });
    expect(text).toBe(
      [
        `استلم هذا الموظف منصب مدير المشاريع — المشاريع في ${D('2026-10-06')}.`,
        'المهام المفتوحة في NPI: 0',
        CLOSING,
      ].join('\n'),
    );
  });

  it('says why when the tasks could not be read, and names a vendor by its code when it has no name', () => {
    const text = handoverGuidanceAr({
      ...representativeBody(),
      predecessor: { npiUserId: 'a', nameAr: null, since: T('2026-03-02') },
      tasks: { status: 'skipped', reason: 'npi_refused' },
      vendors: [
        { npiVendorId: 'v1', nameAr: null, code: 'VEN-00005', factsAr: ['x'] },
        { npiVendorId: null, nameAr: null, code: null, factsAr: ['sentence only'] },
      ],
    });
    expect(text).toContain('المهام المفتوحة في NPI: رفض NPI القراءة');
    expect(text).toContain('الموردون: VEN-00005');
    expect(text).not.toContain('خلفاً');
  });

  it('never exceeds 1,500 characters, cuts at a line boundary with «…», and always keeps the pointer', () => {
    const body = representativeBody();
    if (body.narrative.status !== 'written') throw new Error('fixture');
    const long = 'سطر طويل جداً في دليل الاستلام يصف عملاً يجب إنجازه '.repeat(8).trim();
    const heavy: HandoverBody = {
      ...body,
      narrative: { ...body.narrative, summaryAr: long, firstWeekAr: Array.from({ length: 7 }, (_, i) => `${long} ${i}`) },
    };
    const text = handoverGuidanceAr(heavy);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(text.endsWith(`\n…\n${CLOSING}`)).toBe(true);
    const lines = text.split('\n');
    const allowed = new Set(['الأسبوع الأول:', '…', CLOSING, long, ...Array.from({ length: 7 }, (_, i) => `- ${long} ${i}`)]);
    for (const line of lines.slice(1)) expect(allowed.has(line)).toBe(true);
  });

  it('adds no «…» when everything fits', () => {
    expect(handoverGuidanceAr(representativeBody())).not.toContain('…');
  });
});

// ─── writeNarrative ─────────────────────────────────────────────────────────

const CTX = { npiOrgId: ORG, npiUserId: 'u_admin' };
const WRITE_AT = new Date('2026-10-06T13:00:00.000Z');

function llmReturning(text: string, extra: Partial<ModelResponse> = {}) {
  const requests: RedactedRequest[] = [];
  const llm = {
    complete: jest.fn(async (req: RedactedRequest): Promise<ModelResponse> => {
      requests.push(req);
      return { text, toolCalls: [], stopReason: 'end_turn', tokensIn: 10, tokensOut: 10, modelId: 'test-model', ...extra };
    }),
  };
  return { llm, requests };
}

const GOOD = {
  summaryAr: 'يتولى هذا المنصب متابعة ثلاثة طلبات معلقة والتنسيق مع الموردين.',
  firstWeekAr: ['ابدأ بالطلب PR-00025 فهو الأقدم.', 'تعرّف على الموردين المسجلين.', 'راجع الطلبات المعلقة كل أحد.'],
  cautionsAr: ['الاعتماد والرفض في صندوق وارد NPI فقط.', 'لا تحكم على أداء الشاغل السابق.'],
};

function narrate(text: string, extra: Partial<ModelResponse> = {}, body = representativeBody(), pseudonymizer = new Pseudonymizer([])) {
  const { llm, requests } = llmReturning(text, extra);
  return {
    requests,
    result: writeNarrative({ llm, pseudonymizer, now: () => WRITE_AT }, CTX, body),
  };
}

describe('writeNarrative', () => {
  it('asks the advanced tier once, with the handover prompt, a JSON schema and the document as the only message', async () => {
    const { requests, result } = narrate(JSON.stringify(GOOD));
    const narrative = await result;
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.tier).toBe('advanced');
    expect(req.purpose).toBe('handover_narrative');
    expect(req.maxTokens).toBe(2000);
    expect(req.system).toContain('handover note');
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe('user');
    expect(req.jsonSchema).toMatchObject({ type: 'object', required: ['summaryAr', 'firstWeekAr', 'cautionsAr'] });
    expect(narrative).toEqual({
      status: 'written',
      ...GOOD,
      modelId: 'test-model',
      writtenAt: WRITE_AT.toISOString(),
    });
  });

  it('sends the document without its own narrative section, even when the body already has one', async () => {
    const { requests, result } = narrate(JSON.stringify(GOOD));
    await result;
    const sent = String(requests[0].messages[0].content);
    expect(sent).toContain('المهام المفتوحة في NPI');
    expect(sent).not.toContain('ملخص الاستلام');
    expect(sent).not.toContain(representativeBodyNarrativeSummary());
  });

  it('an LlmError is a failed narrative named by its kind', async () => {
    for (const kind of ['timeout', 'cap_reached', 'refused', 'not_configured'] as const) {
      const llm = { complete: jest.fn(async () => Promise.reject(new LlmError(kind))) };
      const narrative = await writeNarrative({ llm, pseudonymizer: new Pseudonymizer([]), now: () => WRITE_AT }, CTX, representativeBody());
      expect(narrative).toEqual({ status: 'failed', reason: kind, failedAt: WRITE_AT.toISOString() });
    }
  });

  it('a non-LlmError propagates', async () => {
    const llm = { complete: jest.fn(async () => Promise.reject(new TypeError('boom'))) };
    await expect(writeNarrative({ llm, pseudonymizer: new Pseudonymizer([]) }, CTX, representativeBody())).rejects.toThrow('boom');
  });

  it('malformed JSON, the wrong shape and a refusal stop are failed with bad_output / refused', async () => {
    for (const text of ['not json at all', '{"summaryAr": 1}', '{"summaryAr":"ن","firstWeekAr":"x","cautionsAr":[]}', '[]', '']) {
      expect(await narrate(text).result).toEqual({ status: 'failed', reason: 'bad_output', failedAt: WRITE_AT.toISOString() });
    }
    expect(await narrate(JSON.stringify(GOOD), { stopReason: 'refusal' }).result).toMatchObject({ status: 'failed', reason: 'refused' });
    expect(await narrate(JSON.stringify(GOOD).slice(0, 40), { stopReason: 'max_tokens' }).result).toMatchObject({ status: 'failed', reason: 'bad_output' });
  });

  it('tolerates a ```json fence around the object', async () => {
    const narrative = await narrate('```json\n' + JSON.stringify(GOOD) + '\n```').result;
    expect(narrative.status).toBe('written');
  });

  it('drops a line with Latin letters outside codes, keeps the others, clamps to 7 and 4 lines', async () => {
    const out = {
      summaryAr: GOOD.summaryAr,
      firstWeekAr: [
        'ابدأ بالطلب PR-00025.',
        'Review the pending orders.',
        '',
        '   ',
        ...Array.from({ length: 9 }, (_, i) => `خطوة عربية ${i + 1}.`),
      ],
      cautionsAr: ['أ.', 'ب.', 'ج.', 'د.', 'هـ.', 'Never approve in chat.'],
    };
    const narrative = await narrate(JSON.stringify(out)).result;
    if (narrative.status !== 'written') throw new Error('expected written');
    expect(narrative.firstWeekAr).toEqual(['ابدأ بالطلب PR-00025.', ...Array.from({ length: 6 }, (_, i) => `خطوة عربية ${i + 1}.`)]);
    expect(narrative.cautionsAr).toEqual(['أ.', 'ب.', 'ج.', 'د.']);
  });

  it('a summary with a stray Latin word, or only Latin, is a failed narrative with reason latin_text', async () => {
    const mixed = { ...GOOD, summaryAr: 'This position handles الطلبات.' };
    expect(await narrate(JSON.stringify(mixed)).result).toEqual({ status: 'failed', reason: 'latin_text', failedAt: WRITE_AT.toISOString() });
    const allLatin = { summaryAr: 'Handles orders.', firstWeekAr: ['Review.'], cautionsAr: ['Careful.'] };
    expect(await narrate(JSON.stringify(allLatin)).result).toMatchObject({ status: 'failed', reason: 'latin_text' });
  });

  it('an empty summary is bad_output, not latin_text', async () => {
    expect(await narrate(JSON.stringify({ ...GOOD, summaryAr: '  ' })).result).toMatchObject({ status: 'failed', reason: 'bad_output' });
  });

  it('allows NPI and codes such as MOD-550 and CAB-LV6 in a line', async () => {
    const out = { ...GOOD, firstWeekAr: ['راجع مخزون MOD-550 وCAB-LV6 في NPI.'] };
    const narrative = await narrate(JSON.stringify(out)).result;
    expect(narrative.status).toBe('written');
  });

  it('names leave only as placeholders and come back after the call', async () => {
    const vendorName = 'شركة الخليج للألواح الشمسية';
    const pseudonymizer = new Pseudonymizer([{ kind: 'vendor', npiId: 'ven_1', names: [vendorName] }]);
    const requests: RedactedRequest[] = [];
    const llm = {
      complete: jest.fn(async (req: RedactedRequest): Promise<ModelResponse> => {
        requests.push(req);
        const sent = String(req.messages[0].content);
        const placeholder = (sent.match(/⟦[^⟧\s]+⟧/g) ?? []).find((p) => pseudonymizer.rehydrate(p) === vendorName);
        if (placeholder === undefined) throw new Error('the request carried no placeholder for the vendor');
        const out = {
          summaryAr: `يتعامل المنصب مع ${placeholder} في توريد الألواح.`,
          firstWeekAr: [`تعرّف على ${placeholder}.`],
          cautionsAr: ['الاعتماد والرفض في صندوق وارد NPI فقط.'],
        };
        return { text: JSON.stringify(out), toolCalls: [], stopReason: 'end_turn', tokensIn: 1, tokensOut: 1, modelId: 'test-model' };
      }),
    };
    const narrative = await writeNarrative({ llm, pseudonymizer, now: () => WRITE_AT }, CTX, representativeBody());

    const sent = String(requests[0].messages[0].content);
    expect(sent).not.toContain(vendorName);
    expect(String(requests[0].system)).not.toContain(vendorName);
    expect(sent).toMatch(/⟦[^⟧\s]+⟧/);
    if (narrative.status !== 'written') throw new Error(`expected written, got ${JSON.stringify(narrative)}`);
    expect(narrative.summaryAr).toContain(vendorName);
    expect(narrative.firstWeekAr[0]).toContain(vendorName);
    expect(narrative.summaryAr).not.toMatch(/⟦/);
  });
});

function representativeBodyNarrativeSummary(): string {
  const narrative = representativeBody().narrative;
  return narrative.status === 'written' ? narrative.summaryAr : '';
}

describe('hasStrayLatin', () => {
  it.each([
    ['PR-00025', false],
    ['MOD-550', false],
    ['CAB-LV6', false],
    ['NPI', false],
    ['راجع PR-00025 في NPI', false],
    ['طلب PR-00025وPO-00007', false],
    ['VEN-00001', false],
    ['abc', true],
    ['راجع invoice', true],
    ['ERP', true],
    ['PR-1', true],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(hasStrayLatin(text)).toBe(expected);
  });
});
