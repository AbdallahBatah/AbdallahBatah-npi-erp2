/**
 * The pick lists (ADR-02 §3-3): the five short lists a form needs to fill a
 * dropdown — items, projects, customers, vendors and locations — served by
 * `GET /reference/lookups/<kind>` apart from the screens that own the records.
 *
 * Read by the API (each lookup route declares its row here through
 * `@RequireAnyPermission`, so the guard lets a request through on any one of
 * the keys) and by the web pages (`canUseLookup` decides whether a page asks
 * at all, so a user who may not see a list never triggers a 403 for it).
 *
 * The rule: a screen's working key earns the lists its form needs — names
 * only, without the other screen. Raising a requisition brings the item list
 * without the item catalogue screen; taking that screen away does not stop
 * anyone from picking an item, taking away the requisition key does.
 *
 * Imports only from `./permissions`, never the reverse: that file must stay
 * import-free (apps/copilot/tests/catalog.spec.ts reads it by relative path).
 */
import { PERMISSIONS, type PermissionKey } from './permissions';

export type LookupKind = 'items' | 'projects' | 'customers' | 'vendors' | 'locations' | 'workItems';

/** The URL segment of each list (`GET /reference/lookups/<segment>`). */
export const LOOKUP_PATH: Record<LookupKind, string> = {
  items: 'items',
  projects: 'projects',
  customers: 'customers',
  vendors: 'vendors',
  locations: 'locations',
  workItems: 'work-items',
};

/** Holding ANY one of a list's keys is enough to read it. */
export const LOOKUP_ACCESS: Record<LookupKind, readonly PermissionKey[]> = {
  // The catalogue's own key, then every form that adds an item line: a
  // requisition, a purchase order or stock transfer, a proposal's bill of
  // materials, a work order's spare parts.
  items: [
    PERMISSIONS.ITEM_READ,
    PERMISSIONS.REQUISITION_WRITE,
    PERMISSIONS.PROCUREMENT_WRITE,
    PERMISSIONS.PROPOSAL_WRITE,
    PERMISSIONS.WORKORDER_WRITE,
  ],
  // The projects screen's key, and a purchase order charged to a project.
  projects: [PERMISSIONS.PROJECT_READ, PERMISSIONS.PROCUREMENT_WRITE],
  // The customers screen's key, and a new opportunity's customer.
  customers: [PERMISSIONS.CUSTOMER_READ, PERMISSIONS.OPPORTUNITY_WRITE],
  // The procurement screen's key, and a project's subcontract.
  vendors: [PERMISSIONS.PROCUREMENT_READ, PERMISSIONS.PROJECT_WRITE],
  // The procurement screen's key (stock by location), a serial unit's
  // location, and the store a work order's part is issued from.
  locations: [
    PERMISSIONS.PROCUREMENT_READ,
    PERMISSIONS.ASSET_READ,
    PERMISSIONS.WORKORDER_WRITE,
  ],
  // Package 3 · P3-3 (ADR-03 §4-3): the work-item list's own screen key (the
  // items screen) and the budget editor, which is the proposal form.
  workItems: [PERMISSIONS.ITEM_READ, PERMISSIONS.PROPOSAL_WRITE],
};

/** True when `permissions` holds at least one of the list's keys. */
export function canUseLookup(kind: LookupKind, permissions: readonly string[]): boolean {
  return LOOKUP_ACCESS[kind].some((key) => permissions.includes(key));
}
