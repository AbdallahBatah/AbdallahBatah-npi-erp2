import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { LeadsService } from './leads.service';
import type { AuthUser } from '../../common/auth-user';

const USER = {
  userId: 'u1',
  organizationId: 'org1',
  permissions: ['crm.customer.read', 'crm.customer.write'],
} as unknown as AuthUser;

const EXISTING = { id: 'c-existing', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh' };

/** A tx whose customer.findFirst answers per call from `lookups` (by the key searched). */
function makeTx(opts: { duplicateOf?: Partial<Record<'crNumber' | 'vatNumber' | 'mobile', typeof EXISTING>>; row?: unknown } = {}) {
  const customer = {
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const key of ['crNumber', 'vatNumber', 'mobile'] as const) {
        if (where[key] !== undefined) return opts.duplicateOf?.[key] ?? null;
      }
      return opts.row ?? null; // lookup by id
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
    update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'c1', ...data })),
  };
  return { customer };
}

function setup(tx: ReturnType<typeof makeTx>, settingsValue?: unknown) {
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    customer: { findMany: jest.fn(), findFirst: jest.fn() },
  };
  const numbering = { next: jest.fn().mockResolvedValue('CUS-00002') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const settings = { get: jest.fn().mockImplementation(async (_o: string, _k: string, d: unknown) => settingsValue ?? d) };
  const svc = new CustomersService(prisma as never, numbering as never, audit as never, settings as never);
  return { svc, prisma, numbering, audit, settings };
}

async function thrown(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('CustomersService.create', () => {
  it('rejects a CR number another customer already has, naming that customer (409)', async () => {
    const { svc } = setup(makeTx({ duplicateOf: { crNumber: EXISTING } }));
    const e = (await thrown(svc.create(USER, { nameAr: 'س', nameEn: 'S', crNumber: '1010000001' }))) as ConflictException;
    expect(e).toBeInstanceOf(ConflictException);
    const body = e.getResponse() as Record<string, any>;
    expect(body.message).toMatch(/^Duplicate customer key:/);
    expect(body).toMatchObject({ code: 'CUSTOMER_DUPLICATE', field: 'crNumber', existing: { id: 'c-existing', code: 'CUS-00001' } });
  });

  it('rejects a VAT number already in use', async () => {
    const { svc } = setup(makeTx({ duplicateOf: { vatNumber: EXISTING } }));
    const e = (await thrown(svc.create(USER, { nameAr: 'س', nameEn: 'S', vatNumber: '310000000000003' }))) as ConflictException;
    expect((e.getResponse() as Record<string, unknown>).field).toBe('vatNumber');
  });

  it('rejects a mobile already in use, comparing the canonical +966 form', async () => {
    const tx = makeTx({ duplicateOf: { mobile: EXISTING } });
    const { svc } = setup(tx);
    const e = (await thrown(
      svc.create(USER, { nameAr: 'أحمد', nameEn: 'Ahmed', entityKind: 'INDIVIDUAL', mobile: '0501234567' }),
    )) as ConflictException;
    expect((e.getResponse() as Record<string, unknown>).field).toBe('mobile');
    expect(tx.customer.findFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org1',
      mergedIntoId: null,
      mobile: '+966501234567',
    });
  });

  it('creates when no key collides, storing the normalised name and canonical mobile', async () => {
    const tx = makeTx();
    const { svc, audit } = setup(tx);
    await svc.create(USER, {
      nameAr: 'الشركة الجديدة', nameEn: 'New Co', crNumber: ' 1010000009 ', mobile: '050 111 2222',
    });
    const data = tx.customer.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      organizationId: 'org1',
      entityKind: 'COMPANY',
      crNumber: '1010000009',
      mobile: '+966501112222',
      nameNormalized: 'شركه جديده',
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'Customer', action: 'CREATE' }), tx);
  });

  it('requires a CR or VAT number for a company, and a mobile for an individual', async () => {
    const { svc } = setup(makeTx());
    await expect(svc.create(USER, { nameAr: 'س', nameEn: 'S' })).rejects.toThrow(/requires a CR number or a VAT number/);
    await expect(svc.create(USER, { nameAr: 'س', nameEn: 'S', entityKind: 'INDIVIDUAL' })).rejects.toThrow(/requires a mobile/);
    // A landline is not a mobile.
    await expect(
      svc.create(USER, { nameAr: 'س', nameEn: 'S', entityKind: 'INDIVIDUAL', mobile: '0112345678' }),
    ).rejects.toThrow(BadRequestException);
    // A VAT number alone satisfies the company rule.
    await expect(svc.create(USER, { nameAr: 'س', nameEn: 'S', vatNumber: '310000000000003' })).resolves.toBeDefined();
  });
});

describe('CustomersService.update', () => {
  const row = { id: 'c1', organizationId: 'org1', code: 'CUS-00009', nameAr: 'قديم', mergedIntoId: null, crNumber: null, vatNumber: null, mobile: null };

  it('rejects a key another customer holds, excluding the record itself from the search', async () => {
    const tx = makeTx({ duplicateOf: { vatNumber: EXISTING }, row });
    const { svc } = setup(tx);
    await expect(svc.update(USER, 'c1', { vatNumber: '310000000000003' })).rejects.toBeInstanceOf(ConflictException);
    const where = tx.customer.findFirst.mock.calls.find((c) => c[0].where.vatNumber)![0].where;
    expect(where.id).toEqual({ not: 'c1' });
  });

  it('does NOT force the mandatory key on an existing customer that lacks it', async () => {
    const tx = makeTx({ row });
    const { svc } = setup(tx);
    await expect(svc.update(USER, 'c1', { nameEn: 'Renamed' })).resolves.toBeDefined();
    expect(tx.customer.update).toHaveBeenCalled();
  });

  it('writes and audits inside the one transaction, and refreshes the normalised name', async () => {
    const tx = makeTx({ row });
    const { svc, audit, prisma } = setup(tx);
    await svc.update(USER, 'c1', { nameAr: 'أحمد العلي' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.customer.update.mock.calls[0][0].data).toMatchObject({ nameAr: 'أحمد العلي', nameNormalized: 'احمد علي' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE', before: row }), tx);
  });

  it('stores an emptied key as NULL, not as the empty string', async () => {
    const tx = makeTx({ row });
    const { svc } = setup(tx);
    await svc.update(USER, 'c1', { crNumber: '   ' });
    expect(tx.customer.update.mock.calls[0][0].data.crNumber).toBeNull();
  });

  it('404s an unknown or foreign customer and freezes a merged one (409)', async () => {
    const { svc } = setup(makeTx({ row: null }));
    await expect(svc.update(USER, 'nope', { nameEn: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    const { svc: svc2 } = setup(makeTx({ row: { ...row, mergedIntoId: 'c0' } }));
    await expect(svc2.update(USER, 'c1', { nameEn: 'x' })).rejects.toThrow('Customer already merged');
  });
});

describe('CustomersService.similar', () => {
  const rows = [
    { id: 'a', code: 'CUS-00001', nameAr: 'مصنع الرياض للصناعات', nameEn: 'Riyadh Industries Factory', nameNormalized: 'مصنع رياض للصناعات', entityKind: 'COMPANY' },
    { id: 'b', code: 'CUS-00002', nameAr: 'شركة النورس للمقاولات', nameEn: 'Nawras', nameNormalized: 'شركه نورس للمقاولات', entityKind: 'COMPANY' },
    { id: 'c', code: 'CUS-00003', nameAr: 'مؤسسة البناء', nameEn: 'Building', nameNormalized: 'موسسه بناء', entityKind: 'COMPANY' },
  ];

  it('returns the close customers above the threshold, closest first, scoped to the organization', async () => {
    const { svc, prisma } = setup(makeTx());
    prisma.customer.findMany.mockResolvedValue(rows);
    const out = await svc.similar(USER, 'شركة الرياض للصناعات');
    expect(out.map((r) => r.code)).toEqual(['CUS-00001']);
    expect(out[0].score).toBeGreaterThanOrEqual(0.8);
    expect(prisma.customer.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: 'org1', mergedIntoId: null });
  });

  it('honours a lower organization threshold', async () => {
    const { svc, prisma } = setup(makeTx(), 0.5);
    prisma.customer.findMany.mockResolvedValue(rows);
    const out = await svc.similar(USER, 'شركة النور');
    expect(out.map((r) => r.code)).toContain('CUS-00002');
  });

  it('returns nothing for a name too short to compare', async () => {
    const { svc, prisma } = setup(makeTx());
    expect(await svc.similar(USER, 'ا')).toEqual([]);
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });
});

describe('LeadsService.convert', () => {
  const lead = {
    id: 'l1', code: 'LEAD-00009', status: 'QUALIFIED', contactName: 'سعد', companyName: 'شركة الأمل',
    phone: '0501234567', email: null, customerId: null, estimatedKwp: null,
  };

  function leadSetup(dupe: boolean) {
    const tx = {
      customer: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          dupe && where.mobile ? EXISTING : null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cNew', ...data })),
      },
      opportunity: { create: jest.fn().mockResolvedValue({ id: 'o1' }) },
      lead: { update: jest.fn().mockResolvedValue({ id: 'l1' }) },
    };
    const prisma = {
      lead: { findFirst: jest.fn().mockResolvedValue(lead) },
      customer: { findFirst: jest.fn() },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
    const numbering = { next: jest.fn().mockResolvedValue('CUS-00003') };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const customers = new CustomersService(prisma as never, numbering as never, audit as never, { get: jest.fn() } as never);
    return { svc: new LeadsService(prisma as never, numbering as never, audit as never, customers), tx, audit, prisma };
  }

  it('refuses to create a customer whose key (the lead mobile) already belongs to another (409)', async () => {
    const { svc, tx } = leadSetup(true);
    const e = (await thrown(svc.convert(USER, 'l1', {}))) as ConflictException;
    expect(e).toBeInstanceOf(ConflictException);
    expect((e.getResponse() as Record<string, unknown>).code).toBe('CUSTOMER_DUPLICATE');
    expect(tx.customer.create).not.toHaveBeenCalled();
    expect(tx.opportunity.create).not.toHaveBeenCalled();
  });

  it('creates the customer, audits "Customer CREATE", and keeps converting when no key collides', async () => {
    const { svc, tx, audit } = leadSetup(false);
    await svc.convert(USER, 'l1', {});
    expect(tx.customer.create.mock.calls[0][0].data).toMatchObject({
      entityKind: 'COMPANY', mobile: '+966501234567', nameNormalized: 'شركه امل',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Customer', action: 'CREATE', entityId: 'cNew' }),
      tx,
    );
  });

  it('404s a customerId from another organization before touching anything', async () => {
    const { svc, prisma, tx } = leadSetup(false);
    prisma.customer.findFirst.mockResolvedValue(null);
    // The in-transaction lookup goes through the tx client.
    (tx.customer.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.convert(USER, 'l1', { customerId: 'foreign' })).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.opportunity.create).not.toHaveBeenCalled();
  });
});
