/**
 * CRM Phase 1 · Step 5 (contract §1-5, §5, §8) — the hourly sweep that tells people
 * about follow-up tasks: a reminder once when it falls due, an overdue notice once
 * when the due DAY has ended. In-system notifications only; there is no mail.
 *
 * The sweep selects and claims; which side of "today" counts as overdue is proved
 * against real rows in test/activities-tasks.int-spec.ts.
 */
import { riyadhDayStart } from '@npi/shared';
import { FollowUpReminderScheduler } from './follow-up-reminder.scheduler';

const NOW = new Date('2026-10-08T10:00:00.000Z'); // 13:00 on the 8th in Riyadh

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  organizationId: 'org1',
  code: `TSK-${id}`,
  title: `متابعة ${id}`,
  dueAt: new Date('2026-10-07T00:00:00.000Z'),
  assigneeId: 'u-assignee',
  createdById: 'u-creator',
  customer: { nameAr: 'مصنع الرياض', nameEn: 'Riyadh Plant' },
  ...over,
});

function setup(opts: { reminders?: unknown[]; overdue?: unknown[]; claim?: number | ((id: string) => number) } = {}) {
  const tx = {
    followUpTask: {
      updateMany: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({
        count: typeof opts.claim === 'function' ? opts.claim(where.id) : (opts.claim ?? 1),
      })),
    },
  };
  const prisma = {
    followUpTask: {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        'remindAt' in where ? (opts.reminders ?? []) : (opts.overdue ?? []),
      ),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const notifications = { notifyUser: jest.fn().mockResolvedValue(1) };
  const sched = new FollowUpReminderScheduler(prisma as never, notifications as never);
  return { sched, prisma, tx, notifications };
}

const whereOf = (prisma: ReturnType<typeof setup>['prisma'], kind: 'remindAt' | 'dueAt') =>
  prisma.followUpTask.findMany.mock.calls.map((c) => c[0].where).find((w: Record<string, unknown>) => kind in w);

describe('FollowUpReminderScheduler.sweep — what it selects', () => {
  it('reminders: OPEN tasks never reminded whose reminder instant has come', async () => {
    const { sched, prisma } = setup();
    await sched.sweep(NOW);
    expect(whereOf(prisma, 'remindAt')).toEqual({ status: 'OPEN', reminderSentAt: null, remindAt: { lte: NOW } });
  });

  it('overdue: OPEN tasks never flagged whose due DAY ended before today (Riyadh) began — the due day itself is not late', async () => {
    const { sched, prisma } = setup();
    await sched.sweep(NOW);
    expect(whereOf(prisma, 'dueAt')).toEqual({
      status: 'OPEN',
      overdueNotifiedAt: null,
      dueAt: { lt: riyadhDayStart(NOW) },
    });
  });

  it('never selects a DONE or CANCELLED task (both selections are for OPEN only)', async () => {
    const { sched, prisma } = setup();
    await sched.sweep(NOW);
    for (const call of prisma.followUpTask.findMany.mock.calls) expect(call[0].where.status).toBe('OPEN');
  });
});

describe('FollowUpReminderScheduler.sweep — reminders', () => {
  it('claims the task (reminderSentAt = now, only if still unreminded and OPEN) and tells the assignee, in one transaction', async () => {
    const { sched, tx, notifications } = setup({ reminders: [task('1')] });
    await expect(sched.sweep(NOW)).resolves.toEqual({ reminded: 1, overdue: 0 });
    expect(tx.followUpTask.updateMany).toHaveBeenCalledWith({
      where: { id: '1', status: 'OPEN', reminderSentAt: null },
      data: { reminderSentAt: NOW },
    });
    expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
    const [input, client] = notifications.notifyUser.mock.calls[0];
    expect(input).toMatchObject({
      organizationId: 'org1',
      userId: 'u-assignee',
      type: 'TASK_REMINDER',
      linkPath: '/tasks?focus=1',
    });
    expect(input.titleAr).toContain('متابعة 1');
    expect(input.bodyAr).toContain('TSK-1');
    expect(input.bodyAr).toContain('مصنع الرياض');
    expect(input.bodyEn).toContain('Riyadh Plant');
    expect(client).toBe(tx);
  });

  it('is ONCE: a task another sweep claimed in the meantime (0 rows updated) is not notified again', async () => {
    const { sched, notifications } = setup({ reminders: [task('1')], claim: 0 });
    await expect(sched.sweep(NOW)).resolves.toEqual({ reminded: 0, overdue: 0 });
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });
});

describe('FollowUpReminderScheduler.sweep — overdue', () => {
  it('tells the assignee AND the creator when they are different people, once', async () => {
    const { sched, tx, notifications } = setup({ overdue: [task('1')] });
    await expect(sched.sweep(NOW)).resolves.toEqual({ reminded: 0, overdue: 1 });
    expect(tx.followUpTask.updateMany).toHaveBeenCalledWith({
      where: { id: '1', status: 'OPEN', overdueNotifiedAt: null },
      data: { overdueNotifiedAt: NOW },
    });
    const sent = notifications.notifyUser.mock.calls.map((c) => [c[0].userId, c[0].type]);
    expect(sent).toEqual([
      ['u-assignee', 'TASK_OVERDUE'],
      ['u-creator', 'TASK_OVERDUE'],
    ]);
  });

  it('tells the person once when assignee and creator are the same', async () => {
    const { sched, notifications } = setup({ overdue: [task('1', { createdById: 'u-assignee' })] });
    await sched.sweep(NOW);
    expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
  });

  it('a task whose creator is gone (null) goes to the assignee alone', async () => {
    const { sched, notifications } = setup({ overdue: [task('1', { createdById: null })] });
    await sched.sweep(NOW);
    expect(notifications.notifyUser).toHaveBeenCalledTimes(1);
  });

  it('is ONCE: a task already claimed is not notified again', async () => {
    const { sched, notifications } = setup({ overdue: [task('1')], claim: 0 });
    await expect(sched.sweep(NOW)).resolves.toEqual({ reminded: 0, overdue: 0 });
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('the notice says how late the task is and links to it', async () => {
    const { sched, notifications } = setup({ overdue: [task('1', { dueAt: new Date('2026-10-05T00:00:00.000Z') })] });
    await sched.sweep(NOW);
    const input = notifications.notifyUser.mock.calls[0][0];
    expect(input.linkPath).toBe('/tasks?focus=1');
    expect(input.bodyEn).toContain('3');
  });
});

describe('FollowUpReminderScheduler.sweep — failure', () => {
  it('one task that cannot be processed does not stop the others', async () => {
    const { sched, notifications } = setup({ reminders: [task('1'), task('2')] });
    notifications.notifyUser.mockRejectedValueOnce(new Error('boom'));
    await expect(sched.sweep(NOW)).resolves.toEqual({ reminded: 1, overdue: 0 });
    expect(notifications.notifyUser).toHaveBeenCalledTimes(2);
  });

  it('a failure in the reminders does not stop the overdue pass', async () => {
    const { sched, notifications } = setup({ reminders: [task('1')], overdue: [task('2')] });
    notifications.notifyUser.mockRejectedValueOnce(new Error('boom'));
    const res = await sched.sweep(NOW);
    expect(res.overdue).toBe(1);
  });

  it('the hourly entry point never throws into the scheduler', async () => {
    const prisma = { followUpTask: { findMany: jest.fn().mockRejectedValue(new Error('db down')) } };
    const sched = new FollowUpReminderScheduler(prisma as never, {} as never);
    await expect(sched.scheduledSweep()).resolves.toBeUndefined();
  });
});
