// Unit tests for src/queries/home.ts — the four home-tile reads, against a
// fake NPI client (no real HTTP, no real database).
import { loadHomeTiles, type HomeNpi } from '../src/queries/home';
import { NpiError } from '../src/npi/errors';

function forbidden(): never {
  throw new NpiError({ status: 403, kind: 'forbidden', npiMessage: 'no' });
}

function networkFailure(): never {
  throw new NpiError({ status: 0, kind: 'network', npiMessage: null, devDetail: 'fetch failed' });
}

/** A fake NpiClient slice that always succeeds, unless a test overrides one
 *  of its methods. */
function fakeNpi(overrides: Partial<HomeNpi> = {}): HomeNpi {
  return {
    inboxCount: async () => ({ total: 5, actionable: 3, overdue: 1 }),
    listContracts: async () => [{ id: 'c1', status: 'DRAFT' }, { id: 'c2', status: 'ACTIVE' }],
    listRequisitions: async (query) => {
      if (query?.status === 'SUBMITTED') return { total: 2, rows: [] };
      if (query?.status === 'PENDING_APPROVAL') return { total: 4, rows: [] };
      return { total: 0, rows: [] };
    },
    inboxTasks: async () => [
      { documentType: 'VendorBill', stateEn: 'Recorded' },
      { documentType: 'VendorBill', stateEn: 'Matched' },
      { documentType: 'PurchaseOrder', stateEn: 'Recorded' },
    ],
    ...overrides,
  };
}

describe('loadHomeTiles — arithmetic', () => {
  it('inbox tile: count is the actionable field, not total or overdue', async () => {
    const tiles = await loadHomeTiles(fakeNpi());
    expect(tiles.inbox).toEqual({ state: 'ok', count: 3 });
  });

  it('contracts_draft tile: only DRAFT rows are counted', async () => {
    const tiles = await loadHomeTiles(fakeNpi());
    expect(tiles.contracts_draft).toEqual({ state: 'ok', count: 1 });
  });

  it('pr_pending tile: SUBMITTED total + PENDING_APPROVAL total', async () => {
    const tiles = await loadHomeTiles(fakeNpi());
    expect(tiles.pr_pending).toEqual({ state: 'ok', count: 6 });
  });

  it('bills_unmatched tile: only VendorBill rows in state "Recorded"', async () => {
    const tiles = await loadHomeTiles(fakeNpi());
    expect(tiles.bills_unmatched).toEqual({ state: 'ok', count: 1 });
  });

  it('a VendorBill in a different state is not counted', async () => {
    const tiles = await loadHomeTiles(
      fakeNpi({ inboxTasks: async () => [{ documentType: 'VendorBill', stateEn: 'Matched' }] }),
    );
    expect(tiles.bills_unmatched).toEqual({ state: 'ok', count: 0 });
  });

  it('a non-VendorBill task in state "Recorded" is not counted', async () => {
    const tiles = await loadHomeTiles(
      fakeNpi({ inboxTasks: async () => [{ documentType: 'PurchaseOrder', stateEn: 'Recorded' }] }),
    );
    expect(tiles.bills_unmatched).toEqual({ state: 'ok', count: 0 });
  });

  it('an empty list is a zero count, not an error', async () => {
    const tiles = await loadHomeTiles(
      fakeNpi({
        listContracts: async () => [],
        inboxTasks: async () => [],
        listRequisitions: async () => ({ total: 0, rows: [] }),
      }),
    );
    expect(tiles.contracts_draft).toEqual({ state: 'ok', count: 0 });
    expect(tiles.bills_unmatched).toEqual({ state: 'ok', count: 0 });
    expect(tiles.pr_pending).toEqual({ state: 'ok', count: 0 });
  });

  it('the two requisition calls use the two statuses and take: 1, and nothing else', async () => {
    const calls: Array<{ status?: string; take?: number }> = [];
    await loadHomeTiles(
      fakeNpi({
        listRequisitions: async (query) => {
          calls.push({ status: query?.status, take: query?.take });
          return { total: 0, rows: [] };
        },
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        { status: 'SUBMITTED', take: 1 },
        { status: 'PENDING_APPROVAL', take: 1 },
      ]),
    );
  });
});

describe('loadHomeTiles — per-tile isolation', () => {
  it('a 403 on one tile becomes "forbidden" and leaves the other three intact', async () => {
    const tiles = await loadHomeTiles(fakeNpi({ inboxCount: async () => forbidden() }));
    expect(tiles.inbox).toEqual({ state: 'forbidden' });
    expect(tiles.contracts_draft).toEqual({ state: 'ok', count: 1 });
    expect(tiles.pr_pending).toEqual({ state: 'ok', count: 6 });
    expect(tiles.bills_unmatched).toEqual({ state: 'ok', count: 1 });
  });

  it('a 403 on listContracts only affects contracts_draft', async () => {
    const tiles = await loadHomeTiles(fakeNpi({ listContracts: async () => forbidden() }));
    expect(tiles.contracts_draft).toEqual({ state: 'forbidden' });
    expect(tiles.inbox).toEqual({ state: 'ok', count: 3 });
  });

  it('a network error on one tile becomes "error", not "forbidden"', async () => {
    const tiles = await loadHomeTiles(fakeNpi({ inboxCount: async () => networkFailure() }));
    expect(tiles.inbox).toEqual({ state: 'error' });
    expect(tiles.contracts_draft).toEqual({ state: 'ok', count: 1 });
  });

  it('a network error on inboxTasks only affects bills_unmatched', async () => {
    const tiles = await loadHomeTiles(fakeNpi({ inboxTasks: async () => networkFailure() }));
    expect(tiles.bills_unmatched).toEqual({ state: 'error' });
    expect(tiles.pr_pending).toEqual({ state: 'ok', count: 6 });
  });

  it('one of the two requisition calls failing fails only pr_pending', async () => {
    const tiles = await loadHomeTiles(
      fakeNpi({
        listRequisitions: async (query) => {
          if (query?.status === 'PENDING_APPROVAL') return forbidden();
          return { total: 2, rows: [] };
        },
      }),
    );
    expect(tiles.pr_pending).toEqual({ state: 'forbidden' });
    expect(tiles.inbox).toEqual({ state: 'ok', count: 3 });
  });
});

describe('loadHomeTiles — malformed bodies', () => {
  it('a body missing "actionable" becomes "error"', async () => {
    const tiles = await loadHomeTiles(fakeNpi({ inboxCount: async () => ({}) as never }));
    expect(tiles.inbox).toEqual({ state: 'error' });
  });

  it('a non-array body from listContracts becomes "error"', async () => {
    const tiles = await loadHomeTiles(fakeNpi({ listContracts: async () => ({ nope: true }) as never }));
    expect(tiles.contracts_draft).toEqual({ state: 'error' });
  });

  it('a non-array body from inboxTasks becomes "error"', async () => {
    const tiles = await loadHomeTiles(fakeNpi({ inboxTasks: async () => (null as never) }));
    expect(tiles.bills_unmatched).toEqual({ state: 'error' });
  });

  it('a requisitions body missing "total" becomes "error"', async () => {
    const tiles = await loadHomeTiles(fakeNpi({ listRequisitions: async () => ({ rows: [] }) as never }));
    expect(tiles.pr_pending).toEqual({ state: 'error' });
  });
});

describe('loadHomeTiles — non-NpiError is rethrown', () => {
  it('a plain bug (not an NpiError) rejects loadHomeTiles rather than being swallowed into a tile state', async () => {
    const bug = new TypeError('some unrelated bug');
    await expect(loadHomeTiles(fakeNpi({ inboxCount: async () => { throw bug; } }))).rejects.toBe(bug);
  });
});
