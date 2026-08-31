import { EventDispatcher } from './event-dispatcher.service';
import { EVENT_MAX_ATTEMPTS, nextRetryDelayMinutes } from '@npi/shared';

const eventRow = (over: Record<string, unknown> = {}) => ({
  id: 'evt1',
  organizationId: 'org1',
  eventCode: 'po.approved',
  payloadJson: {
    documentType: 'PurchaseOrder',
    documentId: 'po1',
    documentCode: 'PO-00001',
    fromState: 'PENDING_APPROVAL',
    toState: 'APPROVED',
    actorId: 'u1',
  },
  status: 'PENDING',
  attempts: 0,
  ...over,
});

const prismaWith = (rows: Array<Record<string, unknown>>) => {
  const db = {
    domainEvent: {
      findMany: jest.fn().mockResolvedValue(rows),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return db;
};

beforeEach(() => jest.clearAllMocks());

// ── the retry ladder itself ─────────────────────────────────────────────────

describe('retry back-off', () => {
  it('lengthens the wait after each failure, then gives up', () => {
    // Retrying a broken handler every minute forever is how a bug becomes a
    // load problem. The ladder ends, and the row is kept rather than dropped.
    const delays = Array.from({ length: EVENT_MAX_ATTEMPTS + 1 }, (_, i) =>
      nextRetryDelayMinutes(i),
    );
    expect(delays.slice(0, EVENT_MAX_ATTEMPTS).every((d) => d !== null)).toBe(true);
    const finite = delays.slice(0, EVENT_MAX_ATTEMPTS) as number[];
    for (let i = 1; i < finite.length; i += 1) expect(finite[i]).toBeGreaterThan(finite[i - 1]);
    expect(delays[EVENT_MAX_ATTEMPTS]).toBeNull();
  });
});

// ── delivery ────────────────────────────────────────────────────────────────

describe('EventDispatcher.drain', () => {
  it('runs every subscriber and marks the event processed', async () => {
    const prisma = prismaWith([eventRow()]);
    const dispatcher = new EventDispatcher(prisma as never);
    const a = jest.fn().mockResolvedValue(undefined);
    const b = jest.fn().mockResolvedValue(undefined);
    dispatcher.on('po.approved', 'book-commitment', a);
    dispatcher.on('po.approved', 'notify', b);

    await expect(dispatcher.drain()).resolves.toEqual({ processed: 1, failed: 0, retried: 0 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(prisma.domainEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSED' }) }),
    );
  });

  it('hands the handler the payload the engine wrote', async () => {
    const prisma = prismaWith([eventRow()]);
    const dispatcher = new EventDispatcher(prisma as never);
    const handler = jest.fn().mockResolvedValue(undefined);
    dispatcher.on('po.approved', 'h', handler);

    await dispatcher.drain();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org1',
        eventCode: 'po.approved',
        payload: expect.objectContaining({ documentId: 'po1', documentCode: 'PO-00001' }),
      }),
    );
  });

  it('processes an event nobody subscribes to instead of retrying it forever', async () => {
    // A flow may legitimately emit something no module consumes yet. That is
    // not a failure, and treating it as one would fill the table with noise.
    const prisma = prismaWith([eventRow({ eventCode: 'po.sent' })]);
    await expect(new EventDispatcher(prisma as never).drain()).resolves.toMatchObject({
      processed: 1,
    });
  });
});

// ── the failure path the architecture names explicitly ──────────────────────

describe('EventDispatcher — a handler that fails, then is retried', () => {
  it('schedules a later attempt and keeps the error, without losing the event', async () => {
    const prisma = prismaWith([eventRow({ attempts: 0 })]);
    const dispatcher = new EventDispatcher(prisma as never);
    dispatcher.on('po.approved', 'flaky', jest.fn().mockRejectedValue(new Error('DB unreachable')));

    await expect(dispatcher.drain()).resolves.toEqual({ processed: 0, failed: 0, retried: 1 });

    const data = prisma.domainEvent.update.mock.calls[0][0].data;
    expect(data.attempts).toBe(1);
    expect(data.lastError).toMatch(/DB unreachable/);
    expect(data.nextAttemptAt).toBeInstanceOf(Date);
    // Still PENDING: the row is never marked processed on failure, which is
    // exactly what makes the consequence impossible to lose.
    expect(data.status).toBeUndefined();
    expect(data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('succeeds on the retry, and the consequence finally happens', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);

    const first = prismaWith([eventRow({ attempts: 0 })]);
    const d1 = new EventDispatcher(first as never);
    d1.on('po.approved', 'flaky', handler);
    await d1.drain();

    // Second tick: the same row comes back due, with its attempt count.
    const second = prismaWith([eventRow({ attempts: 1 })]);
    const d2 = new EventDispatcher(second as never);
    d2.on('po.approved', 'flaky', handler);
    await expect(d2.drain()).resolves.toEqual({ processed: 1, failed: 0, retried: 0 });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(second.domainEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED', attempts: 2, lastError: null }),
      }),
    );
  });

  it('gives up after the ladder ends, and keeps the row visible as FAILED', async () => {
    const prisma = prismaWith([eventRow({ attempts: EVENT_MAX_ATTEMPTS - 1 })]);
    const dispatcher = new EventDispatcher(prisma as never);
    dispatcher.on('po.approved', 'broken', jest.fn().mockRejectedValue(new Error('still broken')));

    await expect(dispatcher.drain()).resolves.toEqual({ processed: 0, failed: 1, retried: 0 });

    const data = prisma.domainEvent.update.mock.calls[0][0].data;
    // FAILED, not deleted: a consequence that never happened must stay
    // findable, because somebody has to go and make it happen.
    expect(data.status).toBe('FAILED');
    expect(data.lastError).toMatch(/still broken/);
  });

  it('does not let one poisoned event stop the rest of the batch', async () => {
    const prisma = prismaWith([
      eventRow({ id: 'bad', eventCode: 'po.approved' }),
      eventRow({ id: 'good', eventCode: 'goods.received' }),
    ]);
    const dispatcher = new EventDispatcher(prisma as never);
    dispatcher.on('po.approved', 'boom', jest.fn().mockRejectedValue(new Error('nope')));
    const healthy = jest.fn().mockResolvedValue(undefined);
    dispatcher.on('goods.received', 'fine', healthy);

    await expect(dispatcher.drain()).resolves.toEqual({ processed: 1, failed: 0, retried: 1 });
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('truncates a runaway error message rather than storing a novel', async () => {
    const prisma = prismaWith([eventRow()]);
    const dispatcher = new EventDispatcher(prisma as never);
    dispatcher.on('po.approved', 'verbose', jest.fn().mockRejectedValue(new Error('x'.repeat(5000))));
    await dispatcher.drain();
    expect(prisma.domainEvent.update.mock.calls[0][0].data.lastError.length).toBe(1000);
  });
});

describe('EventDispatcher — overlap', () => {
  it('will not run two drains at once', async () => {
    // Two overlapping drains would deliver the same due rows twice, and
    // "handlers must be idempotent" is a contract, not a licence to abuse it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prisma = prismaWith([eventRow()]);
    const dispatcher = new EventDispatcher(prisma as never);
    dispatcher.on('po.approved', 'slow', () => gate);

    const first = dispatcher.drain();
    const second = await dispatcher.drain();
    expect(second).toEqual({ processed: 0, failed: 0, retried: 0 });

    release();
    await first;
    // Only the first drain queried for work.
    expect(prisma.domainEvent.findMany).toHaveBeenCalledTimes(1);
  });
});
