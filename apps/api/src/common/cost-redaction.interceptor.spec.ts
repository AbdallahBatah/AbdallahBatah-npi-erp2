import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { COST_FIELDS, PERMISSIONS } from '@npi/shared';
import { CostRedactionInterceptor, redactCostFields } from './cost-redaction.interceptor';
import type { AuthUser } from './auth-user';

const userWith = (permissions: string[]): AuthUser => ({
  userId: 'u1',
  organizationId: 'org1',
  email: 'a@b.c',
  roleId: 'r1',
  roleKey: 'k',
  roleIds: ['r1'],
  permissions,
  locale: 'AR',
});

const ctx = (user: AuthUser | undefined, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const run = (user: AuthUser | undefined, body: unknown) => {
  const handler: CallHandler = { handle: () => of(body) };
  return firstValueFrom(new CostRedactionInterceptor().intercept(ctx(user), handler));
};

/** Decimal-like: a class instance, not a plain object — must pass through untouched. */
class FakeDecimal {
  constructor(public readonly v: string) {}
}

describe('CostRedactionInterceptor', () => {
  const body = () => ({
    id: 'i1',
    sku: 'PV-550',
    unitCost: new FakeDecimal('310.00'),
    bomLines: [
      { qty: 2, item: { sku: 'A', unitCost: '12.50' }, unitPrice: '20.00' },
      { qty: 1, item: { sku: 'B', unitCost: '3.00' }, unitPrice: '5.00' },
    ],
    costSummary: { budget: 100, committed: 10, actual: 20, variance: 70 },
  });

  it('lets a holder of finance.costs.view through untouched', async () => {
    const input = body();
    const out = await run(userWith([PERMISSIONS.COSTS_VIEW]), input);
    expect(out).toBe(input);
  });

  it('nulls unitCost at every depth, keeping the key, for a user without the permission', async () => {
    const out = (await run(userWith([PERMISSIONS.ITEM_READ]), body())) as ReturnType<typeof body>;
    expect(out.unitCost).toBeNull();
    expect('unitCost' in out).toBe(true);
    expect(out.bomLines[0].item.unitCost).toBeNull();
    expect(out.bomLines[1].item.unitCost).toBeNull();
    // everything that is not a cost field is preserved
    expect(out.sku).toBe('PV-550');
    expect(out.bomLines[0].unitPrice).toBe('20.00');
    expect(out.bomLines[0].qty).toBe(2);
    expect(out.costSummary).toEqual({ budget: null, committed: null, actual: null, variance: null });
  });

  it('does not touch a sales invoice: subtotal / amount / total are public', async () => {
    const invoice = {
      code: 'INV-1',
      subtotal: '1000.00',
      vatAmount: '150.00',
      total: '1150.00',
      lines: [{ amount: '1000.00' }],
      milestones: [{ amount: '500.00' }],
      totalAmount: '1150.00',
    };
    const out = await run(userWith([PERMISSIONS.INVOICE_READ]), invoice);
    expect(out).toEqual(invoice);
  });

  it('redacts every key listed in COST_FIELDS', async () => {
    const input = Object.fromEntries(COST_FIELDS.map((k) => [k, 123]));
    const out = (await run(userWith([]), { nested: [input] })) as { nested: Array<Record<string, unknown>> };
    for (const k of COST_FIELDS) expect(out.nested[0][k]).toBeNull();
  });

  it('does not mutate the original response object', () => {
    const input = { rows: [{ unitCost: 5, sku: 'x' }] };
    const out = redactCostFields(input) as typeof input;
    expect(input.rows[0].unitCost).toBe(5);
    expect(out.rows[0].unitCost).toBeNull();
  });

  it('passes through non-plain values (Date, Decimal, Buffer, null, primitives)', async () => {
    const d = new Date();
    const dec = new FakeDecimal('1');
    const out = (await run(userWith([]), { d, dec, n: null, s: 'x' })) as Record<string, unknown>;
    expect(out.d).toBe(d);
    expect(out.dec).toBe(dec);
    expect(out.n).toBeNull();
    expect(out.s).toBe('x');
    expect(await run(userWith([]), null)).toBeNull();
    expect(await run(userWith([]), 'text')).toBe('text');
  });

  it('fails closed: a request with no user is redacted too', async () => {
    const out = (await run(undefined, { unitCost: 9 })) as { unitCost: unknown };
    expect(out.unitCost).toBeNull();
  });

  it('ignores non-http contexts', async () => {
    const handler: CallHandler = { handle: () => of({ unitCost: 9 }) };
    const out = await firstValueFrom(
      new CostRedactionInterceptor().intercept(ctx(undefined, 'rpc'), handler),
    );
    expect(out).toEqual({ unitCost: 9 });
  });
});
