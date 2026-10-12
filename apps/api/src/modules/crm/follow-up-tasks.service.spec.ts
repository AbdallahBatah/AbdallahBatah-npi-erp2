/**
 * CRM Phase 1 · Step 5 — follow-up tasks (contract §1-4…6, §5, §8).
 *
 * The doubles stand in for Prisma, so these specs pin the RULES — which input is
 * refused with which status, what is written, who is told and when. That the numbering
 * is gapless and the scheduler really finds the rows is the integration spec's job
 * (test/activities-tasks.int-spec.ts).
 *
 * The clock is faked: "now" is 13:00 on Thursday 8 October 2026 in Riyadh (10:00 UTC).
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { PERMISSIONS_KEY } from '../../common/decorators';
import { FollowUpTasksService } from './follow-up-tasks.service';
import { FollowUpTasksController } from './follow-up-tasks.controller';
import type { AuthUser } from '../../common/auth-user';

const NOW = new Date('2026-10-08T10:00:00.000Z');

const USER = {
  userId: 'u1',
  organizationId: 'org1',
  permissions: ['crm.customer.read', 'crm.customer.write'],
} as unknown as AuthUser;

const CUSTOMER = { id: 'c1', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh Industries Plant' };
const SCOPE = {
  customerId: 'c1',
  customerCode: 'CUS-00001',
  customerNameAr: CUSTOMER.nameAr,
  customerNameEn: CUSTOMER.nameEn,
  opportunityId: 'o1',
  projectId: null,
  contactId: null,
};

function stored(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    organizationId: 'org1',
    code: 'TSK-00001',
    customerId: 'c1',
    opportunityId: 'o1',
    projectId: null,
    title: 'اتصل بالعميل لتأكيد موعد المعاينة',
    details: null,
    dueAt: new Date('2026-10-12T00:00:00.000Z'),
    remindAt: new Date('2026-10-11T05:00:00.000Z'),
    assigneeId: 'u1',
    status: 'OPEN',
    completedAt: null,
    completedById: null,
    cancelReason: null,
    reminderSentAt: null,
    overdueNotifiedAt: null,
    createdById: 'u1',
    createdAt: new Date('2026-10-01T08:00:00.000Z'),
    updatedAt: new Date('2026-10-01T08:00:00.000Z'),
    customer: CUSTOMER,
    ...over,
  };
}

function makeTx(opts: { row?: Record<string, unknown> | null; assignee?: unknown; updateCount?: number } = {}) {
  const row = opts.row === undefined ? stored() : opts.row;
  let lastData: Record<string, unknown> = {};
  return {
    user: { findFirst: jest.fn().mockResolvedValue(opts.assignee === undefined ? { id: 'u2' } : opts.assignee) },
    followUpTask: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 't1', ...data })),
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        lastData = data;
        return { count: opts.updateCount ?? 1 };
      }),
      findUniqueOrThrow: jest.fn().mockImplementation(async () => ({ ...row, ...lastData })),
    },
  };
}

function setup(tx: ReturnType<typeof makeTx>, settings: Record<string, number> = {}) {
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    customer: { findFirst: jest.fn().mockResolvedValue({ ...CUSTOMER, mergedIntoId: null }) },
    opportunity: { findFirst: jest.fn().mockResolvedValue({ id: 'o1', customerId: 'c1' }) },
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
    customerContact: { findFirst: jest.fn().mockResolvedValue({ id: 'ct1' }) },
    followUpTask: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(stored()),
      count: jest.fn().mockResolvedValue(0),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const numbering = { next: jest.fn().mockResolvedValue('TSK-00001') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notifyUser: jest.fn().mockResolvedValue(1) };
  const orgSettings = {
    get: jest.fn(async (_org: string, key: string, fallback: number) => settings[key] ?? fallback),
  };
  const svc = new FollowUpTasksService(
    prisma as never,
    numbering as never,
    audit as never,
    notifications as never,
    orgSettings as never,
  );
  return { svc, prisma, numbering, audit, notifications, orgSettings };
}

async function thrown(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

const INPUT = { scope: SCOPE, title: 'اتصل بالعميل', dueAt: '2026-10-10' };

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('FollowUpTasksService.createInTx — the due date', () => {
  it('refuses a due date before today (400) before numbering or writing anything', async () => {
    const tx = makeTx();
    const { svc, numbering } = setup(tx);
    const e = await thrown(svc.createInTx(tx as never, USER, { ...INPUT, dueAt: '2026-10-07' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Due date cannot be in the past');
    expect(numbering.next).not.toHaveBeenCalled();
    expect(tx.followUpTask.create).not.toHaveBeenCalled();
  });

  it('accepts today, stored as UTC midnight of the Riyadh date', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    await svc.createInTx(tx as never, USER, { ...INPUT, dueAt: '2026-10-08' });
    expect(tx.followUpTask.create.mock.calls[0][0].data.dueAt.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('reads an ISO instant by its Riyadh day: 01:30 Riyadh on the 13th is the 13th', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    await svc.createInTx(tx as never, USER, { ...INPUT, dueAt: '2026-10-12T22:30:00Z' });
    expect(tx.followUpTask.create.mock.calls[0][0].data.dueAt.toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });

  it('refuses text that is not a date (400)', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    const e = await thrown(svc.createInTx(tx as never, USER, { ...INPUT, dueAt: 'next week' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('dueAt must be a valid date');
  });

  it('refuses a blank title (400)', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    const e = await thrown(svc.createInTx(tx as never, USER, { ...INPUT, title: '   ' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Title is required');
  });
});

describe('FollowUpTasksService.createInTx — the assignee', () => {
  it('refuses a user who is inactive, in another organization, or unknown: 400 "Assignee not found"', async () => {
    const tx = makeTx({ assignee: null });
    const { svc } = setup(tx);
    const e = await thrown(svc.createInTx(tx as never, USER, { ...INPUT, assigneeId: 'u9' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Assignee not found');
    // The lookup itself carries both guards — that is what makes "inactive" and
    // "someone else's" indistinguishable from "does not exist".
    expect(tx.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'u9', organizationId: 'org1', isActive: true });
    expect(tx.followUpTask.create).not.toHaveBeenCalled();
  });

  it('defaults to the actor, and then sends no assignment notice (you do not tell yourself)', async () => {
    const tx = makeTx({ assignee: { id: 'u1' } });
    const { svc, notifications } = setup(tx);
    await svc.createInTx(tx as never, USER, INPUT);
    expect(tx.followUpTask.create.mock.calls[0][0].data.assigneeId).toBe('u1');
    const types = notifications.notifyUser.mock.calls.map((c) => c[0].type);
    expect(types).not.toContain('TASK_ASSIGNED');
  });

  it('assigning to somebody else sends TASK_ASSIGNED to them alone, inside the transaction', async () => {
    const tx = makeTx();
    const { svc, notifications } = setup(tx);
    await svc.createInTx(tx as never, USER, { ...INPUT, assigneeId: 'u2' });
    const assigned = notifications.notifyUser.mock.calls.filter((c) => c[0].type === 'TASK_ASSIGNED');
    expect(assigned).toHaveLength(1);
    const [input, client] = assigned[0];
    expect(input).toMatchObject({ organizationId: 'org1', userId: 'u2', linkPath: '/tasks?focus=t1' });
    expect(input.titleAr).toContain('اتصل بالعميل');
    expect(input.titleEn).toContain('اتصل بالعميل');
    expect(input.bodyAr).toContain('TSK-00001');
    expect(input.bodyAr).toContain('مصنع الرياض للصناعات');
    expect(client).toBe(tx);
  });
});

describe('FollowUpTasksService.createInTx — the record', () => {
  it('numbers it TSK-… through the FOLLOWUP_TASK sequence, in the same transaction, and audits CREATE', async () => {
    const tx = makeTx({ assignee: { id: 'u1' } });
    const { svc, numbering, audit } = setup(tx);
    await svc.createInTx(tx as never, USER, { ...INPUT, title: '  اتصل بالعميل  ', details: ' بعد الظهر ' });
    expect(numbering.next).toHaveBeenCalledWith('org1', 'FOLLOWUP_TASK', tx);
    const data = tx.followUpTask.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      organizationId: 'org1',
      code: 'TSK-00001',
      customerId: 'c1',
      opportunityId: 'o1',
      projectId: null,
      title: 'اتصل بالعميل',
      details: 'بعد الظهر',
      assigneeId: 'u1',
      status: 'OPEN',
      createdById: 'u1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org1', actorId: 'u1', entityType: 'FollowUpTask', entityId: 't1', action: 'CREATE' }),
      tx,
    );
  });
});

describe('FollowUpTasksService.createInTx — the reminder', () => {
  it('a task due in two days: reminder = 08:00 Riyadh the day before, not sent yet', async () => {
    const tx = makeTx({ assignee: { id: 'u1' } });
    const { svc, notifications } = setup(tx);
    await svc.createInTx(tx as never, USER, { ...INPUT, dueAt: '2026-10-10' });
    const data = tx.followUpTask.create.mock.calls[0][0].data;
    expect(data.remindAt.toISOString()).toBe('2026-10-09T05:00:00.000Z');
    expect(data.reminderSentAt ?? null).toBeNull();
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('takes the days-before and the hour from the organization settings, not from the code', async () => {
    const tx = makeTx({ assignee: { id: 'u1' } });
    const { svc, orgSettings } = setup(tx, { 'crm.task.reminderDaysBefore': 2, 'crm.task.reminderHour': 6 });
    await svc.createInTx(tx as never, USER, { ...INPUT, dueAt: '2026-10-20' });
    expect(tx.followUpTask.create.mock.calls[0][0].data.remindAt.toISOString()).toBe('2026-10-18T03:00:00.000Z');
    const asked = orgSettings.get.mock.calls.map((c) => c[1]);
    expect(asked).toEqual(expect.arrayContaining(['crm.task.reminderDaysBefore', 'crm.task.reminderHour']));
  });

  it('a task due today has no time left for a day-before reminder: it is sent AT ONCE, inside the transaction', async () => {
    const tx = makeTx({ assignee: { id: 'u1' } });
    const { svc, notifications } = setup(tx);
    await svc.createInTx(tx as never, USER, { ...INPUT, dueAt: '2026-10-08' });
    const data = tx.followUpTask.create.mock.calls[0][0].data;
    expect(data.reminderSentAt).toEqual(NOW);
    const reminders = notifications.notifyUser.mock.calls.filter((c) => c[0].type === 'TASK_REMINDER');
    expect(reminders).toHaveLength(1);
    expect(reminders[0][0]).toMatchObject({ organizationId: 'org1', userId: 'u1', linkPath: '/tasks?focus=t1' });
    expect(reminders[0][1]).toBe(tx);
  });

  it('an explicit remindAt is kept as given', async () => {
    const tx = makeTx({ assignee: { id: 'u1' } });
    const { svc } = setup(tx);
    await svc.createInTx(tx as never, USER, { ...INPUT, dueAt: '2026-10-10', remindAt: '2026-10-09T12:00:00Z' });
    expect(tx.followUpTask.create.mock.calls[0][0].data.remindAt.toISOString()).toBe('2026-10-09T12:00:00.000Z');
  });

  it('refuses a reminder after the due day (400)', async () => {
    const tx = makeTx({ assignee: { id: 'u1' } });
    const { svc } = setup(tx);
    const e = await thrown(svc.createInTx(tx as never, USER, { ...INPUT, dueAt: '2026-10-10', remindAt: '2026-10-11T12:00:00Z' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Reminder cannot be after the due date');
  });
});

describe('FollowUpTasksService.create — the links (POST /tasks)', () => {
  it('refuses a merged customer (409) before opening a transaction', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    prisma.customer.findFirst.mockResolvedValue({ ...CUSTOMER, mergedIntoId: 'c9' });
    const e = await thrown(svc.create(USER, { customerId: 'c1', title: 'x', dueAt: '2026-10-10' }));
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe('Customer already merged');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an opportunity of another customer (400)', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    prisma.opportunity.findFirst.mockResolvedValue({ id: 'o1', customerId: 'c-other' });
    const e = await thrown(svc.create(USER, { customerId: 'c1', opportunityId: 'o1', title: 'x', dueAt: '2026-10-10' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Opportunity does not belong to this customer');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('writes the task for the customer and the opportunity it was given', async () => {
    const tx = makeTx({ assignee: { id: 'u1' } });
    const { svc } = setup(tx);
    await svc.create(USER, { customerId: 'c1', opportunityId: 'o1', title: 'اتصل', dueAt: '2026-10-10' });
    expect(tx.followUpTask.create.mock.calls[0][0].data).toMatchObject({ customerId: 'c1', opportunityId: 'o1' });
  });
});

describe('FollowUpTasksService.complete / cancel', () => {
  it('completes an OPEN task: status, who and when, guarded by "still OPEN", audited COMPLETE', async () => {
    const tx = makeTx();
    const { svc, audit } = setup(tx);
    await svc.complete(USER, 't1');
    const call = tx.followUpTask.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 't1', organizationId: 'org1', status: 'OPEN' });
    expect(call.data).toEqual({ status: 'DONE', completedAt: NOW, completedById: 'u1' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'FollowUpTask', entityId: 't1', action: 'COMPLETE', actorId: 'u1' }),
      tx,
    );
  });

  it.each(['DONE', 'CANCELLED'])('completing a %s task is a 409 "Task is not open"', async (status) => {
    const tx = makeTx({ row: stored({ status }) });
    const { svc } = setup(tx);
    const e = await thrown(svc.complete(USER, 't1'));
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe('Task is not open');
    expect(tx.followUpTask.updateMany).not.toHaveBeenCalled();
  });

  it('a task that closed between the read and the write is a 409 too', async () => {
    const tx = makeTx({ updateCount: 0 });
    const { svc } = setup(tx);
    await expect(svc.complete(USER, 't1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('a task of another organization (or none) is a 404', async () => {
    const tx = makeTx({ row: null });
    const { svc } = setup(tx);
    const e = await thrown(svc.complete(USER, 'nope'));
    expect(e).toBeInstanceOf(NotFoundException);
    expect((e as Error).message).toBe('Task not found');
    expect(tx.followUpTask.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'nope', organizationId: 'org1' });
  });

  it('cancelling needs a reason (400) and does not even open a transaction without one', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    for (const reason of [undefined, '', '   ']) {
      const e = await thrown(svc.cancel(USER, 't1', reason as never));
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as Error).message).toBe('Cancellation reason is required');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cancels an OPEN task keeping the reason, audited CANCEL', async () => {
    const tx = makeTx();
    const { svc, audit } = setup(tx);
    await svc.cancel(USER, 't1', ' العميل أجّل المشروع ');
    expect(tx.followUpTask.updateMany.mock.calls[0][0].data).toEqual({ status: 'CANCELLED', cancelReason: 'العميل أجّل المشروع' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CANCEL' }), tx);
  });

  it.each(['DONE', 'CANCELLED'])('cancelling a %s task is a 409', async (status) => {
    const tx = makeTx({ row: stored({ status }) });
    const { svc } = setup(tx);
    await expect(svc.cancel(USER, 't1', 'سبب')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.followUpTask.updateMany).not.toHaveBeenCalled();
  });
});

describe('FollowUpTasksService.update', () => {
  it('a closed task cannot be edited (409)', async () => {
    const tx = makeTx({ row: stored({ status: 'DONE' }) });
    const { svc } = setup(tx);
    await expect(svc.update(USER, 't1', { title: 'جديد' })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.followUpTask.updateMany).not.toHaveBeenCalled();
  });

  it('a title change is an UPDATE, nothing else moves, nobody is told', async () => {
    const tx = makeTx();
    const { svc, audit, notifications } = setup(tx);
    await svc.update(USER, 't1', { title: 'عنوان جديد' });
    const data = tx.followUpTask.updateMany.mock.calls[0][0].data;
    expect(data).toEqual({ title: 'عنوان جديد' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({ action: 'UPDATE', before: expect.anything(), after: expect.anything() });
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('refuses a due date in the past (400)', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    await expect(svc.update(USER, 't1', { dueAt: '2026-10-01' })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.followUpTask.updateMany).not.toHaveBeenCalled();
  });

  it('naming the due day the task already has is no change — even when that day is past, so an overdue task is editable', async () => {
    const tx = makeTx({ row: stored({ dueAt: new Date('2026-10-05T00:00:00.000Z') }) });
    const { svc } = setup(tx);
    await svc.update(USER, 't1', { dueAt: '2026-10-05', title: 'عنوان جديد' });
    expect(tx.followUpTask.updateMany.mock.calls[0][0].data).toEqual({ title: 'عنوان جديد' });
  });

  it('EXTENDING the due date after the reminder was sent clears it, so a new one is due — and clears the overdue notice too', async () => {
    const tx = makeTx({ row: stored({ reminderSentAt: new Date('2026-10-07T05:00:00.000Z'), overdueNotifiedAt: new Date('2026-10-08T01:00:00.000Z') }) });
    const { svc } = setup(tx);
    await svc.update(USER, 't1', { dueAt: '2026-10-20' });
    const data = tx.followUpTask.updateMany.mock.calls[0][0].data;
    expect(data.dueAt.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(data.reminderSentAt).toBeNull();
    expect(data.overdueNotifiedAt).toBeNull();
    expect(data.remindAt.toISOString()).toBe('2026-10-19T05:00:00.000Z');
  });

  it('bringing the due date FORWARD keeps the reminder already sent (nothing new is due)', async () => {
    const sent = new Date('2026-10-07T05:00:00.000Z');
    const tx = makeTx({ row: stored({ reminderSentAt: sent }) });
    const { svc } = setup(tx);
    await svc.update(USER, 't1', { dueAt: '2026-10-09' });
    const data = tx.followUpTask.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('reminderSentAt');
  });

  it('a reminder not sent yet is simply recomputed for the new due date', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    await svc.update(USER, 't1', { dueAt: '2026-10-15' });
    const data = tx.followUpTask.updateMany.mock.calls[0][0].data;
    expect(data.remindAt.toISOString()).toBe('2026-10-14T05:00:00.000Z');
    expect(data).not.toHaveProperty('reminderSentAt');
  });

  it('re-assigning records REASSIGN, tells the NEW assignee, and checks they are an active user of the organization', async () => {
    const tx = makeTx();
    const { svc, audit, notifications } = setup(tx);
    await svc.update(USER, 't1', { assigneeId: 'u2' });
    expect(tx.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'u2', organizationId: 'org1', isActive: true });
    expect(tx.followUpTask.updateMany.mock.calls[0][0].data).toEqual({ assigneeId: 'u2' });
    expect(audit.record.mock.calls.map((c) => c[0].action)).toEqual(['REASSIGN']);
    const assigned = notifications.notifyUser.mock.calls.filter((c) => c[0].type === 'TASK_ASSIGNED');
    expect(assigned).toHaveLength(1);
    expect(assigned[0][0]).toMatchObject({ userId: 'u2', linkPath: '/tasks?focus=t1' });
  });

  it('re-assigning to a user who is not there is a 400 "Assignee not found" and changes nothing', async () => {
    const tx = makeTx({ assignee: null });
    const { svc } = setup(tx);
    const e = await thrown(svc.update(USER, 't1', { assigneeId: 'ghost' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Assignee not found');
    expect(tx.followUpTask.updateMany).not.toHaveBeenCalled();
  });

  it('taking a task over yourself is a REASSIGN but sends no notice', async () => {
    const tx = makeTx({ row: stored({ assigneeId: 'u2' }), assignee: { id: 'u1' } });
    const { svc, audit, notifications } = setup(tx);
    await svc.update(USER, 't1', { assigneeId: 'u1' });
    expect(audit.record.mock.calls.map((c) => c[0].action)).toEqual(['REASSIGN']);
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('naming the assignee it already has changes nothing and is not a REASSIGN', async () => {
    const tx = makeTx();
    const { svc, audit } = setup(tx);
    await svc.update(USER, 't1', { assigneeId: 'u1', title: 'عنوان' });
    expect(audit.record.mock.calls.map((c) => c[0].action)).toEqual(['UPDATE']);
  });
});

describe('FollowUpTasksService.list / get', () => {
  it('defaults to the open tasks of the organization, due date first', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    await svc.list(USER, {});
    const arg = prisma.followUpTask.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ organizationId: 'org1', status: 'OPEN' });
    expect(arg.orderBy).toEqual([{ dueAt: 'asc' }, { createdAt: 'asc' }]);
  });

  it('mine=1 narrows to the caller; customerId and opportunityId narrow to them', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    await svc.list(USER, { mine: true, customerId: 'c1', opportunityId: 'o1' });
    expect(prisma.followUpTask.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org1',
      status: 'OPEN',
      assigneeId: 'u1',
      customerId: 'c1',
      opportunityId: 'o1',
    });
  });

  it('due=overdue / today / week are cut on Riyadh days (today is the 8th)', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    await svc.list(USER, { due: 'overdue' });
    await svc.list(USER, { due: 'today' });
    await svc.list(USER, { due: 'week' });
    const dueOf = (n: number) => prisma.followUpTask.findMany.mock.calls[n][0].where.dueAt;
    expect(dueOf(0)).toEqual({ lt: new Date('2026-10-08T00:00:00.000Z') });
    expect(dueOf(1)).toEqual({ gte: new Date('2026-10-08T00:00:00.000Z'), lt: new Date('2026-10-09T00:00:00.000Z') });
    expect(dueOf(2)).toEqual({ gte: new Date('2026-10-08T00:00:00.000Z'), lt: new Date('2026-10-15T00:00:00.000Z') });
  });

  it('refuses an unknown status or due filter (400)', async () => {
    const tx = makeTx();
    const { svc } = setup(tx);
    await expect(svc.list(USER, { status: 'BOGUS' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.list(USER, { due: 'someday' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('status=ALL leaves the status out of the filter', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    await svc.list(USER, { status: 'ALL' });
    expect(prisma.followUpTask.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org1' });
  });

  it('marks each open row with its due state and the days it is late', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    prisma.followUpTask.findMany.mockResolvedValue([
      stored({ id: 'late', dueAt: new Date('2026-10-05T00:00:00.000Z') }),
      stored({ id: 'now', dueAt: new Date('2026-10-08T00:00:00.000Z') }),
      stored({ id: 'soon', dueAt: new Date('2026-10-12T00:00:00.000Z') }),
    ]);
    const rows = (await svc.list(USER, {})) as Array<{ id: string; dueState: string | null; daysOverdue: number }>;
    expect(rows.map((r) => [r.id, r.dueState, r.daysOverdue])).toEqual([
      ['late', 'OVERDUE', 3],
      ['now', 'TODAY', 0],
      ['soon', 'UPCOMING', 0],
    ]);
  });

  it('a closed row has no due state (a finished task is not "late")', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    prisma.followUpTask.findMany.mockResolvedValue([stored({ status: 'DONE', dueAt: new Date('2026-10-01T00:00:00.000Z') })]);
    const rows = (await svc.list(USER, { status: 'ALL' })) as Array<{ dueState: string | null; daysOverdue: number }>;
    expect(rows[0].dueState).toBeNull();
    expect(rows[0].daysOverdue).toBe(0);
  });

  it('get is organization-scoped and 404s a stranger', async () => {
    const tx = makeTx();
    const { svc, prisma } = setup(tx);
    prisma.followUpTask.findFirst.mockResolvedValue(null);
    const e = await thrown(svc.get(USER, 'other-org-task'));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(prisma.followUpTask.findFirst.mock.calls[0][0].where).toEqual({ id: 'other-org-task', organizationId: 'org1' });
  });
});

describe('FollowUpTasksService.assignees — who a task may be given to', () => {
  it('asks Prisma for the active users of the caller’s organization who hold crm.task.read, ordered by Arabic name', async () => {
    const { svc, prisma } = setup(makeTx());
    prisma.user.findMany.mockResolvedValue([{ id: 'u2', nameAr: 'أحمد', nameEn: 'Ahmad' }]);
    await svc.assignees(USER);
    const args = prisma.user.findMany.mock.calls[0][0];
    // P1-6 (ADR-02 §5): only someone who can open /tasks may be given a task — through the
    // primary role or an extra one, the shape of NotificationService.notify.
    const holds = { permissions: { has: PERMISSIONS.TASK_READ } };
    expect(args.where).toEqual({
      organizationId: 'org1',
      isActive: true,
      OR: [{ role: holds }, { extraRoles: { some: { role: holds } } }],
    });
    expect(args.orderBy).toEqual({ nameAr: 'asc' });
  });

  it('selects id, nameAr and nameEn and nothing else (no e-mail, role or status)', async () => {
    const { svc, prisma } = setup(makeTx());
    prisma.user.findMany.mockResolvedValue([{ id: 'u2', nameAr: 'أحمد', nameEn: 'Ahmad' }]);
    const rows = await svc.assignees(USER);
    expect(prisma.user.findMany.mock.calls[0][0].select).toEqual({ id: true, nameAr: true, nameEn: true });
    expect(rows).toEqual([{ id: 'u2', nameAr: 'أحمد', nameEn: 'Ahmad' }]);
  });
});

describe('FollowUpTasksService.mySummary — the dashboard card', () => {
  it('counts the caller’s own open tasks due today and before today (Riyadh days)', async () => {
    const { svc, prisma } = setup(makeTx());
    prisma.followUpTask.count.mockResolvedValueOnce(2).mockResolvedValueOnce(5);
    const res = await svc.mySummary(USER);
    expect(res).toEqual({ dueToday: 2, overdue: 5 });
    // "now" is 13:00 on 8 Oct in Riyadh: the stored form of today is UTC midnight of that date
    const today = new Date('2026-10-08T00:00:00.000Z');
    const wheres = prisma.followUpTask.count.mock.calls.map((c) => c[0].where);
    expect(wheres).toContainEqual({ organizationId: 'org1', assigneeId: 'u1', status: 'OPEN', dueAt: today });
    expect(wheres).toContainEqual({ organizationId: 'org1', assigneeId: 'u1', status: 'OPEN', dueAt: { lt: today } });
  });
});

describe('FollowUpTasksController — the keys of the reads', () => {
  const keyOf = (method: string): string[] =>
    Reflect.getMetadata(PERMISSIONS_KEY, (FollowUpTasksController.prototype as unknown as Record<string, object>)[method]);

  it('assignees needs the write key (it only feeds the assign-to picker), summary the tasks key', () => {
    expect(keyOf('assignees')).toEqual([PERMISSIONS.CUSTOMER_WRITE]);
    expect(keyOf('summary')).toEqual([PERMISSIONS.TASK_READ]);
  });

  it('list and get need the key of the /tasks screen, not the customers key (P1-6)', () => {
    expect(keyOf('list')).toEqual([PERMISSIONS.TASK_READ]);
    expect(keyOf('get')).toEqual([PERMISSIONS.TASK_READ]);
  });

  it('every write stays on the customer write key (no task write key in this package)', () => {
    for (const m of ['create', 'update', 'complete', 'cancel']) {
      expect(keyOf(m)).toEqual([PERMISSIONS.CUSTOMER_WRITE]);
    }
  });

  it('the static routes are declared before :id so the parameter cannot swallow them', () => {
    const names = Object.getOwnPropertyNames(FollowUpTasksController.prototype);
    expect(names.indexOf('assignees')).toBeLessThan(names.indexOf('get'));
    expect(names.indexOf('summary')).toBeLessThan(names.indexOf('get'));
  });
});
