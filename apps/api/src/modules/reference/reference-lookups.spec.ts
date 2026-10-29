import { PATH_METADATA } from '@nestjs/common/constants';
import { LOOKUP_ACCESS, LOOKUP_PATH, PERMISSIONS, canUseLookup, type LookupKind } from '@npi/shared';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY } from '../../common/decorators';
import { ReferenceController } from './reference.controller';
import { ReferenceLookupsService } from './reference-lookups.service';

const KINDS: LookupKind[] = ['items', 'projects', 'customers', 'vendors', 'locations', 'workItems'];

/** The controller method serving each list. */
const HANDLER: Record<LookupKind, string> = {
  items: 'lookupItems',
  projects: 'lookupProjects',
  customers: 'lookupCustomers',
  vendors: 'lookupVendors',
  locations: 'lookupLocations',
  workItems: 'lookupWorkItems',
};

describe('LOOKUP_ACCESS — the ADR-02 §3-3 table', () => {
  it('names exactly the keys of the accepted table', () => {
    expect(LOOKUP_ACCESS).toEqual({
      items: [
        'commercial.item.read',
        'scm.requisition.write',
        'scm.procurement.write',
        'commercial.proposal.write',
        'fsm.workorder.write',
      ],
      projects: ['projects.project.read', 'scm.procurement.write'],
      customers: ['crm.customer.read', 'crm.opportunity.write'],
      vendors: ['scm.procurement.read', 'projects.project.write'],
      locations: ['scm.procurement.read', 'assets.serialunit.read', 'fsm.workorder.write'],
      workItems: ['commercial.item.read', 'commercial.proposal.write'],
    });
  });

  it('canUseLookup: any one key of the row is enough, none is not', () => {
    expect(canUseLookup('items', [PERMISSIONS.REQUISITION_WRITE])).toBe(true);
    expect(canUseLookup('items', [PERMISSIONS.PROCUREMENT_READ])).toBe(false);
    expect(canUseLookup('customers', [PERMISSIONS.OPPORTUNITY_WRITE, PERMISSIONS.LEAD_READ])).toBe(true);
    expect(canUseLookup('customers', [PERMISSIONS.OPPORTUNITY_READ])).toBe(false);
    expect(canUseLookup('locations', [PERMISSIONS.ASSET_READ])).toBe(true);
    expect(canUseLookup('workItems', [PERMISSIONS.PROPOSAL_WRITE])).toBe(true);
    expect(canUseLookup('workItems', [PERMISSIONS.PROPOSAL_READ])).toBe(false);
    for (const kind of KINDS) expect(canUseLookup(kind, [])).toBe(false);
  });
});

describe('ReferenceController — the lookup routes', () => {
  const proto = ReferenceController.prototype as unknown as Record<string, object>;

  it.each(KINDS)('%s: GET lookups/<kind>, any-of exactly its LOOKUP_ACCESS row, no all-of list', (kind) => {
    const handler = proto[HANDLER[kind]];
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(`lookups/${LOOKUP_PATH[kind]}`);
    expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, handler)).toEqual([...LOOKUP_ACCESS[kind]]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toBeUndefined();
  });

  it.each(KINDS)('%s: passes the caller organization to the service', async (kind) => {
    const lookups = Object.fromEntries(
      KINDS.map((k) => [k, jest.fn().mockResolvedValue([{ id: k }])]),
    ) as unknown as Record<LookupKind, jest.Mock>;
    const controller = new ReferenceController({} as never, lookups as never);
    const user = { organizationId: 'org1' } as never;
    const call = (controller as unknown as Record<string, (u: unknown) => Promise<unknown>>)[
      HANDLER[kind]
    ].bind(controller);
    await expect(call(user)).resolves.toEqual([{ id: kind }]);
    expect(lookups[kind]).toHaveBeenCalledWith('org1');
  });
});

describe('ReferenceLookupsService — one findMany per list, names only', () => {
  const prismaDouble = () => {
    const model = () => ({ findMany: jest.fn().mockResolvedValue([]) });
    return {
      item: model(),
      project: model(),
      customer: model(),
      vendor: model(),
      location: model(),
      workItem: model(),
    };
  };

  /** The whole call, so a field added to a select (or a dropped filter) fails here. */
  const EXPECTED: Record<LookupKind, { model: keyof ReturnType<typeof prismaDouble>; args: unknown }> = {
    items: {
      model: 'item',
      args: {
        where: { organizationId: 'org1' },
        select: {
          id: true,
          sku: true,
          nameAr: true,
          nameEn: true,
          uom: true,
          isSerialised: true,
          unitCost: true,
        },
        orderBy: { sku: 'asc' },
      },
    },
    projects: {
      model: 'project',
      args: {
        where: { organizationId: 'org1' },
        select: { id: true, code: true, nameAr: true, nameEn: true },
        orderBy: { code: 'asc' },
      },
    },
    customers: {
      model: 'customer',
      args: {
        // A merged customer is never offered.
        where: { organizationId: 'org1', mergedIntoId: null },
        select: { id: true, code: true, nameAr: true, nameEn: true },
        orderBy: { code: 'asc' },
      },
    },
    vendors: {
      model: 'vendor',
      args: {
        where: { organizationId: 'org1' },
        select: { id: true, code: true, nameAr: true, nameEn: true },
        orderBy: { code: 'asc' },
      },
    },
    locations: {
      model: 'location',
      args: {
        where: { organizationId: 'org1' },
        select: {
          id: true,
          code: true,
          nameAr: true,
          nameEn: true,
          locationType: true,
          projectId: true,
        },
        orderBy: { code: 'asc' },
      },
    },
    workItems: {
      model: 'workItem',
      args: {
        // A switched-off work item is not offered to a new budget.
        where: { organizationId: 'org1', isActive: true },
        select: {
          id: true,
          code: true,
          nameAr: true,
          nameEn: true,
          kind: true,
          uom: true,
          defaultUnitCost: true,
          itemId: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      },
    },
  };

  it.each(KINDS)('%s', async (kind) => {
    const prisma = prismaDouble();
    const rows = [{ id: 'r1' }];
    const { model, args } = EXPECTED[kind];
    prisma[model].findMany.mockResolvedValue(rows);
    const service = new ReferenceLookupsService(prisma as never);

    await expect(service[kind]('org1')).resolves.toBe(rows);

    expect(prisma[model].findMany).toHaveBeenCalledTimes(1);
    expect(prisma[model].findMany).toHaveBeenCalledWith(args);
    // No other table is read.
    for (const other of Object.keys(prisma) as Array<keyof typeof prisma>) {
      if (other !== model) expect(prisma[other].findMany).not.toHaveBeenCalled();
    }
  });

  it('the organization comes from the caller, never a constant', async () => {
    const prisma = prismaDouble();
    const service = new ReferenceLookupsService(prisma as never);
    await service.vendors('org-other');
    expect(prisma.vendor.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org-other' });
  });
});
