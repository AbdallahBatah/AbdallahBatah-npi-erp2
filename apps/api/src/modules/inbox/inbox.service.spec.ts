/**
 * CRM Phase 1 · Step 5 (contract §1-7, §8) — follow-up tasks in the unified inbox.
 *
 * The inbox so far held what the approval matrix and the workflow engine wait on from
 * the user's ROLE. A follow-up task is assigned to a PERSON, so it joins as a third,
 * deliberately personal source: the caller's own open tasks, due today or earlier. A
 * task due tomorrow is not an inbox item yet, and a colleague's task never is.
 *
 * The clock is faked: "now" is 13:00 on Thursday 8 October 2026 in Riyadh (10:00 UTC).
 */
import { InboxService } from './inbox.service';
import type { AuthUser } from '../../common/auth-user';

const NOW = new Date('2026-10-08T10:00:00.000Z');

const USER = { userId: 'u1', organizationId: 'org1', permissions: [] } as unknown as AuthUser;

const task = (id: string, dueAt: string, over: Record<string, unknown> = {}) => ({
  id,
  code: `TSK-${id}`,
  title: `متابعة ${id}`,
  dueAt: new Date(dueAt),
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  customer: { nameAr: 'مصنع الرياض', nameEn: 'Riyadh Plant' },
  ...over,
});

function setup(rows: unknown[] = [], approvals: unknown[] = [], workflow: unknown[] = []) {
  const prisma = { followUpTask: { findMany: jest.fn().mockResolvedValue(rows) } };
  const approvalService = { inbox: jest.fn().mockResolvedValue(approvals) };
  const engine = { tasksFor: jest.fn().mockResolvedValue(workflow) };
  const svc = new InboxService(prisma as never, approvalService as never, engine as never);
  return { svc, prisma };
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('InboxService.tasks — the follow-up source', () => {
  it('asks only for the caller’s own OPEN tasks due before tomorrow began (Riyadh), in their organization', async () => {
    const { svc, prisma } = setup();
    await svc.tasks(USER);
    const where = prisma.followUpTask.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      organizationId: 'org1',
      assigneeId: 'u1',
      status: 'OPEN',
      // tomorrow in Riyadh begins at 21:00 UTC tonight
      dueAt: { lt: new Date('2026-10-08T21:00:00.000Z') },
    });
  });

  it('a task due today appears as "due today", a late one as "late n days" and overdue', async () => {
    const { svc } = setup([task('today', '2026-10-08T00:00:00.000Z'), task('late', '2026-10-05T00:00:00.000Z')]);
    const out = await svc.tasks(USER);
    const today = out.find((t) => t.id === 'today')!;
    const late = out.find((t) => t.id === 'late')!;

    expect(today).toMatchObject({
      source: 'FOLLOWUP',
      documentType: 'FOLLOWUP_TASK',
      documentId: 'today',
      documentCode: 'TSK-today',
      stateAr: 'مستحقة اليوم',
      stateEn: 'Due today',
      amount: null,
      overdue: false,
      actionable: true,
      linkPath: '/tasks?focus=today',
    });
    expect(late).toMatchObject({ overdue: true, stateAr: 'متأخرة 3 أيام', stateEn: 'Overdue by 3 days', linkPath: '/tasks?focus=late' });
  });

  it('the title carries the task and the customer, in both languages', async () => {
    const { svc } = setup([task('1', '2026-10-08T00:00:00.000Z')]);
    const [t] = await svc.tasks(USER);
    expect(t.titleAr).toContain('متابعة 1');
    expect(t.titleAr).toContain('مصنع الرياض');
    expect(t.titleEn).toContain('Riyadh Plant');
  });

  it('waits since it was created', async () => {
    const { svc } = setup([task('1', '2026-10-08T00:00:00.000Z')]);
    const [t] = await svc.tasks(USER);
    expect(t.waitingSince).toEqual(new Date('2026-10-01T08:00:00.000Z'));
    expect(t.ageHours).toBeGreaterThan(24 * 7);
  });

  it('says "late one day" in the singular and "two days" in the dual', async () => {
    const { svc } = setup([task('1', '2026-10-07T00:00:00.000Z'), task('2', '2026-10-06T00:00:00.000Z')]);
    const out = await svc.tasks(USER);
    expect(out.find((t) => t.id === '1')!.stateAr).toBe('متأخرة يوم');
    expect(out.find((t) => t.id === '2')!.stateAr).toBe('متأخرة يومين');
    expect(out.find((t) => t.id === '1')!.stateEn).toBe('Overdue by 1 day');
  });

  it('sits among the other sources, oldest waiting first', async () => {
    const approval = {
      id: 'ap1', documentType: 'PURCHASE_ORDER', documentId: 'po1', documentCode: 'PO-1', currentStep: 1, steps: [{}],
      amount: 100, currentStepAt: new Date('2026-10-02T08:00:00.000Z'), escalated: false, canDecide: true,
    };
    const { svc } = setup([task('1', '2026-10-08T00:00:00.000Z')], [approval]);
    const out = await svc.tasks(USER);
    expect(out.map((t) => t.source)).toEqual(['FOLLOWUP', 'APPROVAL']);
  });

  it('count includes the follow-up tasks (and the overdue ones in "overdue")', async () => {
    const { svc } = setup([task('1', '2026-10-08T00:00:00.000Z'), task('2', '2026-10-05T00:00:00.000Z')]);
    await expect(svc.count(USER)).resolves.toEqual({ total: 2, actionable: 2, overdue: 1 });
  });
});
