/**
 * CRM Phase 1 · Step 5 — the communication log (contract §1-1…3, §5, §8).
 *
 * The doubles stand in for Prisma and for the task service, so these specs pin the
 * RULES: which input is refused with which status, what is written in which
 * transaction, and who may edit what. Real rows, real numbering and the real
 * ordering/cursor are the integration spec's job (test/activities-tasks.int-spec.ts).
 *
 * The clock is faked: "now" is 13:00 on Thursday 8 October 2026 in Riyadh (10:00 UTC).
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import type { AuthUser } from '../../common/auth-user';

const NOW = new Date('2026-10-08T10:00:00.000Z');

const USER = {
  userId: 'u1',
  organizationId: 'org1',
  permissions: ['crm.customer.read', 'crm.customer.write'],
} as unknown as AuthUser;

const CUSTOMER = { id: 'c1', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh Industries Plant', mergedIntoId: null };

function stored(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    organizationId: 'org1',
    customerId: 'c1',
    opportunityId: null,
    projectId: null,
    contactId: null,
    activityType: 'CALL',
    occurredAt: new Date('2026-10-07T09:00:00.000Z'),
    body: 'اتصلت بمدير المشتريات وأكد الاهتمام بالعرض',
    createdById: 'u1',
    createdAt: new Date('2026-10-07T09:05:00.000Z'),
    updatedAt: new Date('2026-10-07T09:05:00.000Z'),
    ...over,
  };
}

function setup() {
  const tx = {
    activity: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'a-new', ...data })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...stored(), ...data })),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    customer: { findFirst: jest.fn().mockResolvedValue(CUSTOMER) },
    opportunity: { findFirst: jest.fn().mockResolvedValue({ id: 'o1', customerId: 'c1' }) },
    project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
    customerContact: { findFirst: jest.fn().mockResolvedValue({ id: 'ct1' }) },
    activity: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(stored()) },
    attachment: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const tasks = { createInTx: jest.fn().mockResolvedValue({ id: 't-new', code: 'TSK-00007' }) };
  const svc = new ActivitiesService(prisma as never, audit as never, tasks as never);
  return { svc, prisma, tx, audit, tasks };
}

async function thrown(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

const BODY = { customerId: 'c1', activityType: 'MEETING' as const, body: 'اجتماع في الموقع لمعاينة السطح' };

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('ActivitiesService.create — what an entry may point at', () => {
  it('refuses an opportunity that belongs to ANOTHER customer (400), writing nothing', async () => {
    const { svc, prisma } = setup();
    prisma.opportunity.findFirst.mockResolvedValue({ id: 'o1', customerId: 'c-other' });
    const e = await thrown(svc.create(USER, { ...BODY, opportunityId: 'o1' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Opportunity does not belong to this customer');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s an opportunity that is not in the organization', async () => {
    const { svc, prisma } = setup();
    prisma.opportunity.findFirst.mockResolvedValue(null);
    await expect(svc.create(USER, { ...BODY, opportunityId: 'zzz' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.opportunity.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'zzz', organizationId: 'org1' });
  });

  it('refuses a contact of ANOTHER customer (400): the lookup is by customer', async () => {
    const { svc, prisma } = setup();
    prisma.customerContact.findFirst.mockResolvedValue(null);
    const e = await thrown(svc.create(USER, { ...BODY, contactId: 'ct-other' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Contact does not belong to this customer');
    expect(prisma.customerContact.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'ct-other',
      organizationId: 'org1',
      customerId: 'c1',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a project that exists in the organization, and 404s one that does not', async () => {
    const { svc, prisma, tx } = setup();
    await svc.create(USER, { ...BODY, projectId: 'p1' });
    expect(tx.activity.create.mock.calls[0][0].data.projectId).toBe('p1');
    prisma.project.findFirst.mockResolvedValue(null);
    await expect(svc.create(USER, { ...BODY, projectId: 'p-x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a customer that was merged away (409 "Customer already merged")', async () => {
    const { svc, prisma } = setup();
    prisma.customer.findFirst.mockResolvedValue({ ...CUSTOMER, mergedIntoId: 'c9' });
    const e = await thrown(svc.create(USER, BODY));
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as Error).message).toBe('Customer already merged');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s a customer of another organization (the lookup carries the organization)', async () => {
    const { svc, prisma } = setup();
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(svc.create(USER, BODY)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.customer.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'c1', organizationId: 'org1' });
  });
});

describe('ActivitiesService.create — the date and the text', () => {
  it('refuses a date more than 5 minutes in the future (400)', async () => {
    const { svc, prisma } = setup();
    const e = await thrown(svc.create(USER, { ...BODY, occurredAt: '2026-10-08T10:06:00.000Z' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Activity date cannot be in the future');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows the 5 minutes of clock skew between a browser and the server', async () => {
    const { svc, tx } = setup();
    await svc.create(USER, { ...BODY, occurredAt: '2026-10-08T10:04:30.000Z' });
    expect(tx.activity.create.mock.calls[0][0].data.occurredAt.toISOString()).toBe('2026-10-08T10:04:30.000Z');
  });

  it('defaults the date to now', async () => {
    const { svc, tx } = setup();
    await svc.create(USER, BODY);
    expect(tx.activity.create.mock.calls[0][0].data.occurredAt).toEqual(NOW);
  });

  it('refuses text that is not a date (400)', async () => {
    const { svc } = setup();
    const e = await thrown(svc.create(USER, { ...BODY, occurredAt: 'yesterday' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('occurredAt must be a valid date');
  });

  it('refuses an empty body (400)', async () => {
    const { svc } = setup();
    const e = await thrown(svc.create(USER, { ...BODY, body: '   ' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Body is required');
  });

  it('writes the entry for the author, with the body trimmed, and audits CREATE inside the transaction', async () => {
    const { svc, tx, audit } = setup();
    await svc.create(USER, { ...BODY, body: '  اجتماع في الموقع  ' });
    expect(tx.activity.create.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org1',
      customerId: 'c1',
      activityType: 'MEETING',
      body: 'اجتماع في الموقع',
      createdById: 'u1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org1', actorId: 'u1', entityType: 'Activity', entityId: 'a-new', action: 'CREATE' }),
      tx,
    );
  });
});

describe('ActivitiesService.create — with a follow-up', () => {
  it('creates the task in the SAME transaction, for the same customer and opportunity', async () => {
    const { svc, tx, tasks } = setup();
    const res = (await svc.create(USER, {
      ...BODY,
      opportunityId: 'o1',
      followUp: { title: 'إرسال العرض المعدّل', dueAt: '2026-10-12', assigneeId: 'u2' },
    })) as { activity: { id: string }; task: { code: string } };
    expect(tasks.createInTx).toHaveBeenCalledTimes(1);
    const [client, user, input] = tasks.createInTx.mock.calls[0];
    expect(client).toBe(tx);
    expect(user).toBe(USER);
    expect(input).toMatchObject({
      title: 'إرسال العرض المعدّل',
      dueAt: '2026-10-12',
      assigneeId: 'u2',
      scope: { customerId: 'c1', opportunityId: 'o1' },
    });
    expect(res.activity.id).toBe('a-new');
    expect(res.task.code).toBe('TSK-00007');
  });

  it('the title defaults to the first 120 characters of the body', async () => {
    const { svc, tasks } = setup();
    const long = 'ا'.repeat(300);
    await svc.create(USER, { ...BODY, body: long, followUp: { dueAt: '2026-10-12' } });
    expect(tasks.createInTx.mock.calls[0][2].title).toBe('ا'.repeat(120));
  });

  it('when the task is refused the whole entry is (the error comes out of the transaction)', async () => {
    const { svc, tasks } = setup();
    tasks.createInTx.mockRejectedValue(new BadRequestException('Due date cannot be in the past'));
    await expect(svc.create(USER, { ...BODY, followUp: { dueAt: '2026-10-01' } })).rejects.toThrow('Due date cannot be in the past');
  });

  it('without a follow-up no task is created and none is returned', async () => {
    const { svc, tasks } = setup();
    const res = (await svc.create(USER, BODY)) as { task?: unknown };
    expect(tasks.createInTx).not.toHaveBeenCalled();
    expect(res.task).toBeUndefined();
  });
});

describe('ActivitiesService.update — only the author edits, nobody deletes', () => {
  it('somebody else is refused (403 "Only the author can edit this entry")', async () => {
    const { svc, prisma } = setup();
    prisma.activity.findFirst.mockResolvedValue(stored({ createdById: 'u-other' }));
    const e = await thrown(svc.update(USER, 'a1', { body: 'تعديل' }));
    expect(e).toBeInstanceOf(ForbiddenException);
    expect((e as Error).message).toBe('Only the author can edit this entry');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an entry whose author is gone (createdById null) is nobody’s to edit', async () => {
    const { svc, prisma } = setup();
    prisma.activity.findFirst.mockResolvedValue(stored({ createdById: null }));
    await expect(svc.update(USER, 'a1', { body: 'تعديل' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s an entry of another organization', async () => {
    const { svc, prisma } = setup();
    prisma.activity.findFirst.mockResolvedValue(null);
    await expect(svc.update(USER, 'zzz', { body: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.activity.findFirst.mock.calls[0][0].where).toEqual({ id: 'zzz', organizationId: 'org1' });
  });

  it('the author changes type, date, body or contact — and the audit keeps before and after', async () => {
    const { svc, tx, audit } = setup();
    await svc.update(USER, 'a1', { activityType: 'MEETING', body: 'نص معدّل', occurredAt: '2026-10-06T08:00:00Z' });
    const data = tx.activity.update.mock.calls[0][0].data;
    expect(data.activityType).toBe('MEETING');
    expect(data.body).toBe('نص معدّل');
    expect(data.occurredAt.toISOString()).toBe('2026-10-06T08:00:00.000Z');
    expect(Object.keys(data).sort()).toEqual(['activityType', 'body', 'occurredAt']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Activity', entityId: 'a1', action: 'UPDATE', before: expect.objectContaining({ body: expect.any(String) }), after: expect.anything() }),
      tx,
    );
  });

  it('cannot move an entry to the future either (400)', async () => {
    const { svc } = setup();
    await expect(svc.update(USER, 'a1', { occurredAt: '2026-10-09T10:00:00Z' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot blank the body (400)', async () => {
    const { svc } = setup();
    await expect(svc.update(USER, 'a1', { body: '  ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a new contact must be one of the entry’s own customer (400), looked up by that customer', async () => {
    const { svc, prisma } = setup();
    prisma.customerContact.findFirst.mockResolvedValue(null);
    const e = await thrown(svc.update(USER, 'a1', { contactId: 'ct-other' }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('Contact does not belong to this customer');
    expect(prisma.customerContact.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'ct-other', organizationId: 'org1', customerId: 'c1' });
  });

  it('the contact can be cleared with null', async () => {
    const { svc, tx } = setup();
    await svc.update(USER, 'a1', { contactId: null });
    expect(tx.activity.update.mock.calls[0][0].data).toEqual({ contactId: null });
  });

  it('has no delete: the service exposes none', () => {
    const { svc } = setup();
    expect((svc as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>).remove).toBeUndefined();
  });
});

describe('ActivitiesService.list', () => {
  it('needs a customer or an opportunity (400)', async () => {
    const { svc } = setup();
    const e = await thrown(svc.list(USER, {}));
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe('customerId or opportunityId is required');
  });

  it('is scoped to the organization, newest occurrence first, with a stable tie-break', async () => {
    const { svc, prisma } = setup();
    await svc.list(USER, { customerId: 'c1' });
    const arg = prisma.activity.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ organizationId: 'org1', customerId: 'c1' });
    expect(arg.orderBy).toEqual([{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('defaults to 50 rows, caps at 200, and reads one extra to know whether there is a next page', async () => {
    const { svc, prisma } = setup();
    await svc.list(USER, { opportunityId: 'o1' });
    expect(prisma.activity.findMany.mock.calls[0][0].take).toBe(51);
    await svc.list(USER, { opportunityId: 'o1', take: 9999 });
    expect(prisma.activity.findMany.mock.calls[1][0].take).toBe(201);
    await svc.list(USER, { opportunityId: 'o1', take: 0 });
    expect(prisma.activity.findMany.mock.calls[2][0].take).toBe(51);
  });

  it('pages by the id of the last row it was given', async () => {
    const { svc, prisma } = setup();
    await svc.list(USER, { customerId: 'c1', cursor: 'a-last' });
    const arg = prisma.activity.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: 'a-last' });
    expect(arg.skip).toBe(1);
  });

  it('returns the rows with their attachment counts and the cursor of the next page', async () => {
    const { svc, prisma } = setup();
    const rows = Array.from({ length: 3 }, (_, i) => stored({ id: `a${i + 1}` }));
    prisma.activity.findMany.mockResolvedValue(rows); // 3 rows read for take=2 → one extra
    prisma.attachment.groupBy.mockResolvedValue([{ entityId: 'a1', _count: { _all: 2 } }]);
    const page = (await svc.list(USER, { customerId: 'c1', take: 2 })) as { items: Array<{ id: string; attachmentsCount: number }>; nextCursor: string | null };
    expect(page.items.map((r) => [r.id, r.attachmentsCount])).toEqual([['a1', 2], ['a2', 0]]);
    expect(page.nextCursor).toBe('a2');
    expect(prisma.attachment.groupBy.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org1',
      entityType: 'ACTIVITY',
      entityId: { in: ['a1', 'a2'] },
    });
  });

  it('the last page has no cursor', async () => {
    const { svc, prisma } = setup();
    prisma.activity.findMany.mockResolvedValue([stored({ id: 'a1' })]);
    const page = (await svc.list(USER, { customerId: 'c1', take: 5 })) as { nextCursor: string | null };
    expect(page.nextCursor).toBeNull();
  });
});
