import { ForbiddenException } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import { ItemsService } from './items.service';
import { ProposalsService } from './proposals.service';
import { assertCanSetCosts, canViewCosts, hideRevisionPricing } from './revision-pricing';

const user = (permissions: string[]): AuthUser => ({
  userId: 'u1',
  organizationId: 'org1',
  email: 'a@b.c',
  roleId: 'r1',
  roleKey: 'sales',
  roleIds: ['r1'],
  permissions,
  locale: 'AR',
});
const withCosts = user([PERMISSIONS.COSTS_VIEW, PERMISSIONS.PROPOSAL_READ, PERMISSIONS.ITEM_WRITE]);
const withoutCosts = user([PERMISSIONS.PROPOSAL_READ, PERMISSIONS.PROPOSAL_WRITE, PERMISSIONS.ITEM_WRITE]);

const revision = () => ({
  id: 'rev1',
  subtotal: '1000.00',
  marginAmount: '100.00',
  totalAmount: '1100.00',
  pricingScheme: { id: 's1', marginPct: '10' },
  bomLines: [{ id: 'l1', qty: 2, unitPrice: '500.00', lineTotal: '1000.00', item: { sku: 'X' } }],
});

describe('hideRevisionPricing', () => {
  it('nulls subtotal, pricingScheme, line prices - and keeps totalAmount', () => {
    const out = hideRevisionPricing(revision());
    expect(out.subtotal).toBeNull();
    expect(out.pricingScheme).toBeNull();
    expect(out.bomLines[0].unitPrice).toBeNull();
    expect(out.bomLines[0].lineTotal).toBeNull();
    expect(out.bomLines[0].qty).toBe(2);
    expect(out.totalAmount).toBe('1100.00');
  });

  it('does not mutate its input', () => {
    const input = revision();
    hideRevisionPricing(input);
    expect(input.subtotal).toBe('1000.00');
  });
});

// CRM Phase 1 · Step 4 (contract §1-4): a revision created from now on carries the
// COST in the base columns and the SELLING price in unitPrice / lineTotal / totalAmount.
// What a caller without finance.costs.view must not see flips accordingly; a revision
// created before Step 4 (no validity date, no line cost) keeps the old redaction.
describe('hideRevisionPricing — cost-based revisions', () => {
  const costBased = () => ({
    id: 'rev2',
    validUntil: new Date('2099-01-01T00:00:00Z'),
    subtotal: '200.00',
    marginAmount: '60.00',
    totalAmount: '260.00',
    pricingScheme: { id: 's1', marginPct: '10' },
    bomLines: [
      {
        id: 'l1',
        qty: 2,
        unitCost: '100.00',
        originalUnitCost: '100.00',
        costSource: 'GRN',
        costDate: new Date('2026-09-20'),
        costAgeDays: 18,
        costOverrideReason: 'quote 12',
        costOverriddenAt: new Date('2026-10-01'),
        costOverriddenById: 'u1',
        unitPrice: '130.00',
        lineTotal: '260.00',
        item: { sku: 'X' },
      },
    ],
  });

  it('keeps the selling price (unitPrice, lineTotal, totalAmount) and hides the cost build-up', () => {
    const out = hideRevisionPricing(costBased());
    expect(out.subtotal).toBeNull();
    expect(out.marginAmount).toBeNull();
    expect(out.pricingScheme).toBeNull();
    const line = out.bomLines[0] as Record<string, unknown>;
    expect(line.unitPrice).toBe('130.00');
    expect(line.lineTotal).toBe('260.00');
    expect(out.totalAmount).toBe('260.00');
    for (const k of ['unitCost', 'originalUnitCost', 'costSource', 'costDate', 'costAgeDays', 'costOverrideReason', 'costOverriddenAt', 'costOverriddenById']) {
      expect(line[k]).toBeNull();
    }
    expect(line.qty).toBe(2);
  });

  it('recognises a cost-based revision by its lines when the revision row carries no date', () => {
    const rev = { ...costBased(), validUntil: undefined };
    expect((hideRevisionPricing(rev).bomLines[0] as Record<string, unknown>).unitPrice).toBe('130.00');
  });

  it('a revision from before Step 4 is redacted exactly as it always was', () => {
    const legacy = { ...revision(), validUntil: null };
    const out = hideRevisionPricing(legacy);
    expect(out.bomLines[0].unitPrice).toBeNull();
    expect(out.bomLines[0].lineTotal).toBeNull();
    expect(out.subtotal).toBeNull();
  });
});

describe('cost-permission helpers', () => {
  it('canViewCosts / assertCanSetCosts follow finance.costs.view', () => {
    expect(canViewCosts(withCosts)).toBe(true);
    expect(canViewCosts(withoutCosts)).toBe(false);
    expect(() => assertCanSetCosts(withCosts)).not.toThrow();
    expect(() => assertCanSetCosts(withoutCosts)).toThrow(ForbiddenException);
  });
});

describe('ProposalsService redaction', () => {
  const proposal = () => ({ id: 'p1', code: 'PRP-1', revisions: [revision()] });
  const make = () => {
    const prisma = {
      proposal: {
        findMany: jest.fn().mockResolvedValue([proposal()]),
        findFirst: jest.fn().mockResolvedValue(proposal()),
      },
    };
    // get() / list() also ask the engine, the matrix and the settings (Step 4).
    const engine = { available: jest.fn().mockResolvedValue([]), history: jest.fn().mockResolvedValue([]) };
    const approvals = { forDocument: jest.fn().mockResolvedValue(null), pendingFor: jest.fn().mockResolvedValue(new Map()) };
    const settings = { get: jest.fn().mockImplementation(async (_o: string, _k: string, d: unknown) => d) };
    return {
      svc: new ProposalsService(
        prisma as never, {} as never, {} as never, {} as never,
        engine as never, approvals as never, {} as never, settings as never,
      ),
      prisma,
    };
  };

  it('get(): hides the price build-up from a user without costs.view, keeps totalAmount', async () => {
    const out = await make().svc.get(withoutCosts, 'p1');
    expect(out.revisions[0].subtotal).toBeNull();
    expect(out.revisions[0].pricingScheme).toBeNull();
    expect(out.revisions[0].bomLines[0].unitPrice).toBeNull();
    expect(out.revisions[0].bomLines[0].lineTotal).toBeNull();
    expect(out.revisions[0].totalAmount).toBe('1100.00');
  });

  it('list(): same for the latest revision of each proposal', async () => {
    const [row] = await make().svc.list(withoutCosts);
    expect(row.revisions[0].subtotal).toBeNull();
    expect(row.revisions[0].totalAmount).toBe('1100.00');
  });

  it('get()/list() return the full figures to a user with costs.view', async () => {
    const { svc } = make();
    expect((await svc.get(withCosts, 'p1')).revisions[0].subtotal).toBe('1000.00');
    expect((await svc.list(withCosts))[0].revisions[0].subtotal).toBe('1000.00');
  });

  it('addRevision(): 403 when a user without costs.view sends marginPct or pricingSchemeId', async () => {
    const { svc, prisma } = make();
    await expect(
      svc.addRevision(withoutCosts, 'p1', { marginPct: 12, bomLines: [] }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.addRevision(withoutCosts, 'p1', { pricingSchemeId: 's1', bomLines: [] }),
    ).rejects.toThrow(ForbiddenException);
    // rejected before touching the database
    expect(prisma.proposal.findFirst).not.toHaveBeenCalled();
  });
});

describe('ItemsService unitCost write guard', () => {
  const make = () => {
    const prisma = {
      item: {
        create: jest.fn().mockResolvedValue({ id: 'i1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'i1' }),
        update: jest.fn().mockResolvedValue({ id: 'i1' }),
      },
    };
    return { svc: new ItemsService(prisma as never), prisma };
  };
  const dto = { sku: 'S', nameAr: 'ا', nameEn: 'A', itemCategory: 'PV_MODULE' as never };

  it('create(): 403 on unitCost without costs.view; allowed without unitCost', async () => {
    const { svc, prisma } = make();
    await expect(svc.create(withoutCosts, { ...dto, unitCost: 10 })).rejects.toThrow(ForbiddenException);
    expect(prisma.item.create).not.toHaveBeenCalled();
    await expect(svc.create(withoutCosts, dto)).resolves.toBeDefined();
  });

  it('update(): 403 on unitCost without costs.view; allowed for other fields', async () => {
    const { svc, prisma } = make();
    await expect(svc.update(withoutCosts, 'i1', { unitCost: 0 })).rejects.toThrow(ForbiddenException);
    expect(prisma.item.update).not.toHaveBeenCalled();
    await expect(svc.update(withoutCosts, 'i1', { nameEn: 'B' })).resolves.toBeDefined();
  });

  it('create()/update(): a holder of costs.view may set unitCost', async () => {
    const { svc } = make();
    await expect(svc.create(withCosts, { ...dto, unitCost: 10 })).resolves.toBeDefined();
    await expect(svc.update(withCosts, 'i1', { unitCost: 11 })).resolves.toBeDefined();
  });
});
