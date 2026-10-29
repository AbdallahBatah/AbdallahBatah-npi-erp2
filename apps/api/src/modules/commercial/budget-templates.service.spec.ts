/**
 * Package 3 · P3-5 (ADR-03 §4-5) — standard estimated budgets. Lines are work
 * items of the tenant with quantities, kept in the order given; an edit with
 * lines replaces them all; codes are unique; everything is audited.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { BudgetTemplatesService } from './budget-templates.service';
import type { AuthUser } from '../../common/auth-user';

const OFFICE = { userId: 'u1', organizationId: 'org1', permissions: ['commercial.item.write'] } as unknown as AuthUser;
const ROW = { id: 't1', organizationId: 'org1', code: 'T-990', nameAr: '990 لوح', nameEn: '990 panels', lines: [] };

function setup(opts: { existing?: unknown; found?: unknown; workItems?: number } = {}) {
  const budgetTemplate = {
    findMany: jest.fn().mockResolvedValue([ROW]),
    findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.code !== undefined ? (opts.existing ?? null) : opts.found === undefined ? ROW : opts.found,
    ),
    create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
    update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, ...data })),
  };
  const budgetTemplateLine = { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) };
  const workItem = { count: jest.fn().mockResolvedValue(opts.workItems ?? 2) };
  const tx = { budgetTemplate, budgetTemplateLine };
  const prisma = { budgetTemplate, budgetTemplateLine, workItem, $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new BudgetTemplatesService(prisma as never, audit as never), budgetTemplate, budgetTemplateLine, workItem, audit, tx };
}

const LINES = [
  { workItemId: 'w-panels', qty: 990 },
  { workItemId: 'w-labour', qty: 648.45, description: ' تركيب ' },
];

describe('BudgetTemplatesService.create', () => {
  it('keeps the lines in the order given, trims, and audits in the same transaction', async () => {
    const { svc, budgetTemplate, audit, tx } = setup();
    await svc.create(OFFICE, { code: ' T-990 ', nameAr: '990 لوح', nameEn: '990 panels', panelCount: 990, lines: LINES });
    const data = budgetTemplate.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ organizationId: 'org1', code: 'T-990', panelCount: 990 });
    expect(data.lines.create).toEqual([
      { workItemId: 'w-panels', qty: 990, description: null, sortOrder: 0 },
      { workItemId: 'w-labour', qty: 648.45, description: 'تركيب', sortOrder: 1 },
    ]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'BudgetTemplate', action: 'CREATE' }), tx);
  });

  it('refuses a work item of another organization (400)', async () => {
    const { svc, budgetTemplate, workItem } = setup({ workItems: 1 });
    await expect(svc.create(OFFICE, { code: 'X', nameAr: 'x', nameEn: 'x', lines: LINES })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(workItem.count.mock.calls[0][0].where).toEqual({ id: { in: ['w-panels', 'w-labour'] }, organizationId: 'org1' });
    expect(budgetTemplate.create).not.toHaveBeenCalled();
  });

  it('refuses a code already in use (409)', async () => {
    const { svc } = setup({ existing: ROW });
    await expect(svc.create(OFFICE, { code: 'T-990', nameAr: 'x', nameEn: 'x', lines: [] })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('BudgetTemplatesService.update', () => {
  it('lines given → every old line is replaced, in one transaction', async () => {
    const { svc, budgetTemplate, budgetTemplateLine } = setup({ workItems: 1 });
    await svc.update(OFFICE, 't1', { lines: [{ workItemId: 'w-panels', qty: 1230 }] });
    expect(budgetTemplateLine.deleteMany).toHaveBeenCalledWith({ where: { templateId: 't1' } });
    expect(budgetTemplate.update.mock.calls[0][0].data.lines).toEqual({
      create: [{ workItemId: 'w-panels', qty: 1230, description: null, sortOrder: 0 }],
    });
  });

  it('no lines given → the lines are left alone', async () => {
    const { svc, budgetTemplateLine } = setup();
    await svc.update(OFFICE, 't1', { isActive: false });
    expect(budgetTemplateLine.deleteMany).not.toHaveBeenCalled();
  });

  it('a template of another organization is not found (404)', async () => {
    const { svc } = setup({ found: null });
    await expect(svc.update(OFFICE, 't-other', { nameAr: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
