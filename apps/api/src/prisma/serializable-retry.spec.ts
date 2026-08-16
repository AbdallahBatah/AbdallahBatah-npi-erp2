import { Prisma } from '@npi/db';
import { PrismaService } from './prisma.service';

/** A P2034 as Prisma raises it when PostgreSQL aborts a serializable txn. */
function writeConflict() {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
    { code: 'P2034', clientVersion: 'test' },
  );
}

/**
 * A PrismaService whose `$transaction` is scripted, so the retry policy can be
 * tested without a database. Everything else about the class is untouched.
 */
function serviceThatFails(times: number, error: () => Error) {
  const service = Object.create(PrismaService.prototype) as PrismaService;
  let calls = 0;
  Object.defineProperty(service, 'logger', { value: { warn: jest.fn() } });
  (service as unknown as { $transaction: unknown }).$transaction = async (fn: (tx: unknown) => unknown) => {
    calls++;
    if (calls <= times) throw error();
    return fn({});
  };
  return { service, calls: () => calls };
}

describe('serializable(): the write conflict is retried, not surfaced', () => {
  it('returns the result once a retry succeeds', async () => {
    const { service, calls } = serviceThatFails(2, writeConflict);
    const result = await service.serializable(async () => 'issued');
    expect(result).toBe('issued');
    expect(calls()).toBe(3); // two conflicts, then through
  });

  it('gives up after the configured number of attempts', async () => {
    const { service, calls } = serviceThatFails(99, writeConflict);
    await expect(service.serializable(async () => 'never', { attempts: 3 })).rejects.toMatchObject({
      code: 'P2034',
    });
    expect(calls()).toBe(3);
  });

  it('does not retry an error that re-running cannot fix', async () => {
    // A unique violation means the work was wrong, not unlucky. Retrying it
    // would just produce the same violation three times more slowly.
    const duplicate = () =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    const { service, calls } = serviceThatFails(99, duplicate);
    await expect(service.serializable(async () => 'never')).rejects.toMatchObject({ code: 'P2002' });
    expect(calls()).toBe(1);
  });

  it('runs the callback exactly once when there is no conflict', async () => {
    const { service, calls } = serviceThatFails(0, writeConflict);
    const body = jest.fn(async () => 'ok');
    await service.serializable(body);
    expect(body).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(1);
  });
});
