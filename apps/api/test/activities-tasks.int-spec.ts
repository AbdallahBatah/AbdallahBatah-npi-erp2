/**
 * CRM Phase 1 · Step 5 — the communication log and the follow-up tasks, against a real
 * PostgreSQL with the seeded users (sales@npi.sa, ceo@npi.sa, admin@npi.sa).
 *
 * What only a database can prove: the TSK- numbering is gapless and issued inside the
 * transaction, the reminder/overdue sweep finds the right rows and says each thing once,
 * the inbox shows the task to its assignee alone, the customer page carries the new
 * lists and the merge moves the new documents.
 *
 * Everything it creates in the seeded organization is deleted again at the end
 * (notifications, tasks, entries); the append-only audit rows stay, by design. The
 * merge scenario runs in a fresh organization of its own, like customer-merge.int-spec.
 */
import { PERMISSIONS_KEY } from '../src/common/decorators';
import { ConflictException } from '@nestjs/common';
import { PERMISSIONS, normalizeValidUntil } from '@npi/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { NumberingService } from '../src/common/numbering.service';
import { AuditService } from '../src/common/audit.service';
import { NotificationService } from '../src/common/notification.service';
import { OrgSettingsService, ORG_SETTING_KEYS } from '../src/common/org-settings.service';
import { OutboxService } from '../src/common/workflow/outbox.service';
import { CustomersService } from '../src/modules/crm/customers.service';
import { CustomerMergeService } from '../src/modules/crm/customer-merge.service';
import { FollowUpTasksService } from '../src/modules/crm/follow-up-tasks.service';
import { ActivitiesService } from '../src/modules/crm/activities.service';
import { ActivitiesController } from '../src/modules/crm/activities.controller';
import { FollowUpTasksController } from '../src/modules/crm/follow-up-tasks.controller';
import { FollowUpReminderScheduler } from '../src/modules/crm/follow-up-reminder.scheduler';
import { InboxService } from '../src/modules/inbox/inbox.service';
import type { AuthUser } from '../src/common/auth-user';
import { buildProposalStack, authUserFor } from './support/proposal-stack';

const prisma = new PrismaService();
const numbering = new NumberingService(prisma);
const audit = new AuditService(prisma);
const notifications = new NotificationService(prisma);
const settings = new OrgSettingsService(prisma, audit);
const tasks = new FollowUpTasksService(prisma, numbering, audit, notifications, settings);
const activities = new ActivitiesService(prisma, audit, tasks);
const scheduler = new FollowUpReminderScheduler(prisma, notifications);
const customers = new CustomersService(prisma, numbering, audit, settings);
const merges = new CustomerMergeService(prisma, audit, new OutboxService(prisma), settings, customers);
const stack = buildProposalStack(prisma);
const inbox = new InboxService(prisma, stack.approvals, stack.engine);

const DAY = 86_400_000;
const startedAt = new Date();
const suffix = `${Date.now()}`;

let SALES: AuthUser;
let CEO: AuthUser;
let ADMIN: AuthUser;
let CUSTOMER_ID = '';
const madeTasks: string[] = [];
const madeActivities: string[] = [];
/** The throw-away organization of the merge scenario (its rows are removed again; the organization itself cannot be: its audit trail is append-only). */
let mergeOrgId = '';

const today = () => normalizeValidUntil(new Date())!;
const inDays = (n: number) => new Date(today().getTime() + n * DAY);

/** Notifications for `userId` of `type` created since this run began and pointing at `taskId`. */
const notified = (userId: string, type: string, taskId: string) =>
  prisma.notification.findMany({
    where: { userId, type, createdAt: { gte: startedAt }, linkPath: `/tasks?focus=${taskId}` },
  });

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    throw new Error('Refusing to run against a non-local database');
  }
  SALES = await authUserFor(prisma, 'sales@npi.sa');
  CEO = await authUserFor(prisma, 'ceo@npi.sa');
  ADMIN = await authUserFor(prisma, 'admin@npi.sa');
  const customer = await prisma.customer.findFirstOrThrow({
    where: { organizationId: SALES.organizationId, mergedIntoId: null },
    orderBy: { createdAt: 'asc' },
  });
  CUSTOMER_ID = customer.id;
});

afterAll(async () => {
  // Own rows only: the ones this run created, found by id.
  await prisma.notification.deleteMany({
    where: { organizationId: SALES.organizationId, createdAt: { gte: startedAt }, type: { in: ['TASK_ASSIGNED', 'TASK_REMINDER', 'TASK_OVERDUE'] }, OR: madeTasks.map((id) => ({ linkPath: `/tasks?focus=${id}` })) },
  });
  await prisma.followUpTask.deleteMany({ where: { id: { in: madeTasks } } });
  await prisma.activity.deleteMany({ where: { id: { in: madeActivities } } });
  if (mergeOrgId) {
    await prisma.notification.deleteMany({ where: { organizationId: mergeOrgId } });
    await prisma.followUpTask.deleteMany({ where: { organizationId: mergeOrgId } });
    await prisma.activity.deleteMany({ where: { organizationId: mergeOrgId } });
  }
  await prisma.$disconnect();
});

describe('the sales user logs a meeting with a follow-up for themselves', () => {
  let activityId = '';
  let task: { id: string; code: string; assigneeId: string; remindAt: Date | null; reminderSentAt: Date | null; dueAt: Date };

  it('creates the entry and a numbered task together', async () => {
    const res = (await activities.create(SALES, {
      customerId: CUSTOMER_ID,
      activityType: 'MEETING',
      body: `اجتماع مع مدير المصنع لمناقشة سعة المحطة — ${suffix}`,
      followUp: { title: `إرسال الجدول الزمني — ${suffix}`, dueAt: inDays(1).toISOString().slice(0, 10) },
    })) as { activity: { id: string }; task: typeof task };
    activityId = res.activity.id;
    madeActivities.push(activityId);
    task = res.task;
    madeTasks.push(task.id);

    expect(task.code).toMatch(/^TSK-\d{5}$/);
    expect(task.assigneeId).toBe(SALES.userId);
    expect(task.dueAt.toISOString()).toBe(inDays(1).toISOString());
  });

  it('remindAt is 08:00 Riyadh the day before (today) — or, if that hour has passed, the reminder went at once', async () => {
    const eightRiyadh = new Date(today().getTime() + 5 * 3_600_000); // 08:00 Riyadh = 05:00 UTC, today
    expect(task.remindAt!.toISOString()).toBe(eightRiyadh.toISOString());
    if (eightRiyadh.getTime() <= Date.now()) {
      expect(task.reminderSentAt).not.toBeNull();
      expect((await notified(SALES.userId, 'TASK_REMINDER', task.id)).length).toBe(1);
    } else {
      expect(task.reminderSentAt).toBeNull();
    }
  });

  it('sends the creator no assignment notice about their own task', async () => {
    expect(await notified(SALES.userId, 'TASK_ASSIGNED', task.id)).toHaveLength(0);
  });

  it('the entry is on the customer’s timeline with its author, and counted', async () => {
    const page = (await activities.list(SALES, { customerId: CUSTOMER_ID })) as {
      items: Array<{ id: string; createdBy: { id: string }; attachmentsCount: number }>;
    };
    const mine = page.items.find((r) => r.id === activityId)!;
    expect(mine.createdBy.id).toBe(SALES.userId);
    expect(mine.attachmentsCount).toBe(0);
  });

  it('only the author edits it: the executive is refused, and the entry is never deleted by anyone', async () => {
    await expect(activities.update({ ...CEO, permissions: [...CEO.permissions, 'crm.customer.write'] }, activityId, { body: 'x' })).rejects.toThrow(
      'Only the author can edit this entry',
    );
    const edited = await activities.update(SALES, activityId, { body: `نص معدّل — ${suffix}` });
    expect((edited as { body: string }).body).toContain('نص معدّل');
    const trail = await prisma.auditLog.findMany({ where: { entityType: 'Activity', entityId: activityId }, orderBy: { occurredAt: 'asc' } });
    expect(trail.map((t) => t.action)).toEqual(['CREATE', 'UPDATE']);
  });

  it('the customer overview carries the entries, the open tasks and both counts', async () => {
    const overview = (await customers.overview(SALES, CUSTOMER_ID)) as {
      activities: Array<{ id: string }>;
      tasks: Array<{ id: string }>;
      counts: { activities: number; tasks: number };
    };
    expect(overview.activities.map((a) => a.id)).toContain(activityId);
    expect(overview.tasks.map((t) => t.id)).toContain(task.id);
    expect(overview.counts.activities).toBeGreaterThanOrEqual(1);
    expect(overview.counts.tasks).toBeGreaterThanOrEqual(1);
  });

  it('completing it twice: the second is a 409', async () => {
    await tasks.complete(SALES, task.id);
    const done = await prisma.followUpTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(done.status).toBe('DONE');
    expect(done.completedById).toBe(SALES.userId);
    await expect(tasks.complete(SALES, task.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(tasks.cancel(SALES, task.id, 'سبب')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('a task for the administrator', () => {
  let task: { id: string; code: string };

  it('tells the administrator — and only the administrator — that it was assigned to them', async () => {
    task = (await tasks.create(SALES, {
      customerId: CUSTOMER_ID,
      title: `مراجعة العقد — ${suffix}`,
      dueAt: inDays(5).toISOString().slice(0, 10),
      assigneeId: ADMIN.userId,
    })) as typeof task;
    madeTasks.push(task.id);
    expect(await notified(ADMIN.userId, 'TASK_ASSIGNED', task.id)).toHaveLength(1);
    expect(await notified(SALES.userId, 'TASK_ASSIGNED', task.id)).toHaveLength(0);
    // five days out, the reminder is not yet due
    expect(await notified(ADMIN.userId, 'TASK_REMINDER', task.id)).toHaveLength(0);
  });

  it('numbers are consecutive, never repeated', async () => {
    const second = (await tasks.create(SALES, { customerId: CUSTOMER_ID, title: `ثانية — ${suffix}`, dueAt: inDays(6).toISOString().slice(0, 10) })) as { id: string; code: string };
    madeTasks.push(second.id);
    const n = (c: string) => Number(c.slice(4));
    expect(n(second.code)).toBe(n(task.code) + 1);
  });

  it('the sweep says "overdue" once, to the assignee and the creator, and the inbox lists it for the assignee alone', async () => {
    // Make it overdue by the only route there is: the date moves under it.
    await prisma.followUpTask.update({ where: { id: task.id }, data: { dueAt: inDays(-1), remindAt: inDays(-2), reminderSentAt: new Date() } });

    const first = await scheduler.sweep();
    expect(first.overdue).toBeGreaterThanOrEqual(1);
    expect(await notified(ADMIN.userId, 'TASK_OVERDUE', task.id)).toHaveLength(1);
    expect(await notified(SALES.userId, 'TASK_OVERDUE', task.id)).toHaveLength(1);

    await scheduler.sweep();
    expect(await notified(ADMIN.userId, 'TASK_OVERDUE', task.id)).toHaveLength(1);
    expect(await notified(SALES.userId, 'TASK_OVERDUE', task.id)).toHaveLength(1);

    const adminBox = await inbox.tasks(ADMIN);
    const row = adminBox.find((t) => t.source === 'FOLLOWUP' && t.documentId === task.id)!;
    expect(row).toBeDefined();
    expect(row.overdue).toBe(true);
    expect(row.stateAr).toBe('متأخرة يوم');
    expect(row.linkPath).toBe(`/tasks?focus=${task.id}`);
    expect((await inbox.count(ADMIN)).overdue).toBeGreaterThanOrEqual(1);

    expect((await inbox.tasks(CEO)).some((t) => t.source === 'FOLLOWUP' && t.documentId === task.id)).toBe(false);
    expect((await inbox.tasks(SALES)).some((t) => t.source === 'FOLLOWUP' && t.documentId === task.id)).toBe(false);
  });

  it('a task due TODAY is in the inbox but is not yet overdue and is not swept as overdue', async () => {
    const t = (await tasks.create(SALES, { customerId: CUSTOMER_ID, title: `اليوم — ${suffix}`, dueAt: today().toISOString().slice(0, 10) })) as { id: string };
    madeTasks.push(t.id);
    await scheduler.sweep();
    expect(await notified(SALES.userId, 'TASK_OVERDUE', t.id)).toHaveLength(0);
    const row = (await inbox.tasks(SALES)).find((r) => r.documentId === t.id)!;
    expect(row.overdue).toBe(false);
    expect(row.stateAr).toBe('مستحقة اليوم');
    // and a task due TOMORROW is not an inbox item yet
    const tomorrow = (await tasks.create(SALES, { customerId: CUSTOMER_ID, title: `غداً — ${suffix}`, dueAt: inDays(1).toISOString().slice(0, 10) })) as { id: string };
    madeTasks.push(tomorrow.id);
    expect((await inbox.tasks(SALES)).some((r) => r.documentId === tomorrow.id)).toBe(false);
  });

  it('a cancelled task is never swept and leaves the inbox', async () => {
    const t = (await tasks.create(SALES, { customerId: CUSTOMER_ID, title: `ملغاة — ${suffix}`, dueAt: today().toISOString().slice(0, 10) })) as { id: string };
    madeTasks.push(t.id);
    await tasks.cancel(SALES, t.id, 'لم يعد مطلوباً');
    await prisma.followUpTask.update({ where: { id: t.id }, data: { dueAt: inDays(-3) } });
    await scheduler.sweep();
    expect(await notified(SALES.userId, 'TASK_OVERDUE', t.id)).toHaveLength(0);
    expect((await inbox.tasks(SALES)).some((r) => r.documentId === t.id)).toBe(false);
  });

  it('extending the due date clears the overdue notice, so a later lapse is told again', async () => {
    const extended = await tasks.update(SALES, task.id, { dueAt: inDays(2).toISOString().slice(0, 10) });
    expect((extended as { overdueNotifiedAt: Date | null }).overdueNotifiedAt).toBeNull();
    expect((extended as { dueState: string }).dueState).toBe('UPCOMING');
  });
});

describe('who may do what — the keys of the existing customer module', () => {
  const keyOf = (cls: { prototype: object }, method: string): string[] =>
    Reflect.getMetadata(PERMISSIONS_KEY, (cls.prototype as Record<string, object>)[method]);

  it('every write needs crm.customer.write, every read crm.customer.read — and no new key exists', () => {
    for (const m of ['create', 'update']) expect(keyOf(ActivitiesController, m)).toEqual([PERMISSIONS.CUSTOMER_WRITE]);
    expect(keyOf(ActivitiesController, 'list')).toEqual([PERMISSIONS.CUSTOMER_READ]);
    for (const m of ['create', 'update', 'complete', 'cancel']) expect(keyOf(FollowUpTasksController, m)).toEqual([PERMISSIONS.CUSTOMER_WRITE]);
    for (const m of ['list', 'get', 'summary']) expect(keyOf(FollowUpTasksController, m)).toEqual([PERMISSIONS.CUSTOMER_READ]);
    expect(keyOf(FollowUpTasksController, 'assignees')).toEqual([PERMISSIONS.CUSTOMER_WRITE]);
  });

  it('the executive (read only) holds the read key but not the write key, so POST /activities answers 403 at the guard', () => {
    expect(CEO.permissions).toContain(PERMISSIONS.CUSTOMER_READ);
    expect(CEO.permissions).not.toContain(PERMISSIONS.CUSTOMER_WRITE);
  });
});

describe('Step 5-b — the assignee list and the dashboard summary', () => {
  let inactiveId = '';
  afterAll(async () => {
    if (inactiveId) await prisma.user.delete({ where: { id: inactiveId } });
  });

  it('the sales user is offered the active administrator, with the three name fields only', async () => {
    const rows = (await tasks.assignees(SALES)) as Array<Record<string, unknown>>;
    const admin = rows.find((r) => r.id === ADMIN.userId);
    expect(admin).toBeDefined();
    expect(Object.keys(admin!).sort()).toEqual(['id', 'nameAr', 'nameEn']);
    // not filtered by the caller: the screen drops "me" itself
    expect(rows.some((r) => r.id === SALES.userId)).toBe(true);
  });

  it('a deactivated user is not offered', async () => {
    const role = await prisma.role.findFirstOrThrow({ where: { organizationId: SALES.organizationId } });
    const u = await prisma.user.create({
      data: {
        organizationId: SALES.organizationId,
        email: `inactive-${suffix}@assignees.test`,
        passwordHash: 'x',
        nameAr: 'مستخدم معطّل',
        nameEn: 'Inactive User',
        roleId: role.id,
        isActive: false,
      },
    });
    inactiveId = u.id;
    const rows = (await tasks.assignees(SALES)) as Array<{ id: string }>;
    expect(rows.some((r) => r.id === u.id)).toBe(false);
  });

  it('the list is ordered by Arabic name', async () => {
    const rows = (await tasks.assignees(SALES)) as Array<{ nameAr: string }>;
    expect(rows.length).toBeGreaterThan(1);
    // Postgres collation may differ from a code-point sort, so compare with the database's own order.
    const dbOrder = await prisma.user.findMany({
      where: { organizationId: SALES.organizationId, isActive: true },
      orderBy: { nameAr: 'asc' },
      select: { nameAr: true },
    });
    expect(rows.map((r) => r.nameAr)).toEqual(dbOrder.map((r) => r.nameAr));
  });

  it('the read-only executive does not hold the key of the assignee list (403 at the guard) but does hold the summary key', () => {
    expect(CEO.permissions).not.toContain(PERMISSIONS.CUSTOMER_WRITE);
    expect(CEO.permissions).toContain(PERMISSIONS.CUSTOMER_READ);
  });

  it('mySummary counts the caller’s open tasks due today, then overdue once the day has passed', async () => {
    const before = await tasks.mySummary(SALES);
    const t = (await tasks.create(SALES, {
      customerId: CUSTOMER_ID,
      title: `ملخص اللوحة — ${suffix}`,
      dueAt: today().toISOString().slice(0, 10),
    })) as { id: string };
    madeTasks.push(t.id);
    const withToday = await tasks.mySummary(SALES);
    expect(withToday.dueToday).toBe(before.dueToday + 1);
    expect(withToday.overdue).toBe(before.overdue);

    await prisma.followUpTask.update({ where: { id: t.id }, data: { dueAt: inDays(-1) } });
    const late = await tasks.mySummary(SALES);
    expect(late.dueToday).toBe(before.dueToday);
    expect(late.overdue).toBe(before.overdue + 1);

    // a finished task is neither
    await tasks.complete(SALES, t.id);
    const done = await tasks.mySummary(SALES);
    expect(done.overdue).toBe(before.overdue);
  });

  it('mySummary is the caller’s own: a task given to the administrator is not counted for the sales user', async () => {
    const before = await tasks.mySummary(SALES);
    const t = (await tasks.create(SALES, {
      customerId: CUSTOMER_ID,
      title: `لغيري — ${suffix}`,
      dueAt: today().toISOString().slice(0, 10),
      assigneeId: ADMIN.userId,
    })) as { id: string };
    madeTasks.push(t.id);
    expect(await tasks.mySummary(SALES)).toEqual(before);
  });
});

describe('the merge moves the log and the tasks (its own organization)', () => {
  it('a duplicate customer’s entries and tasks end up on the survivor, counted in movedJson', async () => {
    const org = await prisma.organization.create({
      data: { legalNameAr: 'منشأة اختبار سجل التواصل', legalNameEn: `Activities Test ${suffix}`, baseCurrency: 'SAR' },
    });
    mergeOrgId = org.id;
    const seeded = await prisma.numberingSequence.findMany({
      where: { organizationId: SALES.organizationId, documentType: { in: ['FOLLOWUP_TASK', 'CUSTOMER'] } },
    });
    await prisma.numberingSequence.createMany({
      data: seeded.map((s) => ({ organizationId: org.id, documentType: s.documentType, prefix: s.prefix, fiscalYear: s.fiscalYear, nextValue: 1, padding: s.padding })),
    });
    const role = await prisma.role.create({
      data: { organizationId: org.id, key: 'sales', nameAr: 'مبيعات', nameEn: 'Sales', permissions: ['crm.customer.read', 'crm.customer.write', 'crm.customer.merge'] },
    });
    const person = await prisma.user.create({
      data: { organizationId: org.id, email: `act-${suffix}@merge.test`, passwordHash: 'x', nameAr: 'مندوب', nameEn: 'Rep', roleId: role.id },
    });
    const user = { userId: person.id, organizationId: org.id, permissions: role.permissions } as unknown as AuthUser;
    const survivor = await prisma.customer.create({ data: { organizationId: org.id, code: `CUS-S${suffix.slice(-6)}`, nameAr: 'الباقي', nameEn: 'Survivor', crNumber: `8${suffix.slice(-9)}` } });
    const dupe = await prisma.customer.create({ data: { organizationId: org.id, code: `CUS-D${suffix.slice(-6)}`, nameAr: 'المكرر', nameEn: 'Duplicate', crNumber: `9${suffix.slice(-9)}` } });

    await activities.create(user, {
      customerId: dupe.id, activityType: 'CALL', body: 'مكالمة قبل الدمج',
      followUp: { title: 'متابعة قبل الدمج', dueAt: inDays(3).toISOString().slice(0, 10) },
    });
    await activities.create(user, { customerId: dupe.id, activityType: 'NOTE', body: 'ملاحظة ثانية' });

    const found = (await merges.duplicates(user)) as { groups: unknown[] };
    expect(found.groups).toBeDefined();

    await settings.set(org.id, ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED, true, person.id);
    const res = await merges.merge(user, { survivorId: survivor.id, mergedIds: [dupe.id], backupRef: `backup-${suffix}.dump` });
    expect(res.merged[0].moved).toMatchObject({ Activity: 2, FollowUpTask: 1 });

    expect(await prisma.activity.count({ where: { customerId: survivor.id } })).toBe(2);
    expect(await prisma.followUpTask.count({ where: { customerId: survivor.id } })).toBe(1);
    expect(await prisma.activity.count({ where: { customerId: dupe.id } })).toBe(0);
    expect(await prisma.followUpTask.count({ where: { customerId: dupe.id } })).toBe(0);

    // The merged-away customer takes nothing new.
    await expect(activities.create(user, { customerId: dupe.id, activityType: 'NOTE', body: 'بعد الدمج' })).rejects.toThrow('Customer already merged');
    await expect(tasks.create(user, { customerId: dupe.id, title: 'بعد الدمج', dueAt: inDays(1).toISOString().slice(0, 10) })).rejects.toThrow('Customer already merged');
  });
});
