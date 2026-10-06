// T-29 (F-12, spec/madar/02 §8): the contract between the NPI snapshot readers
// (`npi-snapshot.ts`), the fact derivation and refresh (`extract-npi.ts`) and
// the memory eval (`scripts/eval-memory.ts`). Types only — no runtime code.
//
// Facts derived from NPI data are deterministic sentences built from
// structured fields (no model call): payment terms from contracts and
// customers, vendor lead times from PO → GRN dates, recurring items from PO
// lines, active projects. Each carries a stable `key` so a refresh replaces
// the earlier sentence for the same thing instead of piling up duplicates.

/** What a derived fact is about. One `kind` per template sentence. */
export type NpiFactKind =
  /** `customer.creditTermsDays` > 0 — key `customer_credit_terms:<customerId>` */
  | 'customer_credit_terms'
  /** advance %, retention %, milestone count, type, value and status of one
   *  contract — key `contract_payment_terms:<contractId>` (entity: the customer) */
  | 'contract_payment_terms'
  /** average days from a PO's approval (or creation) to its first goods
   *  receipt, per vendor, over the POs that have a receipt — key
   *  `vendor_lead_time:<vendorId>` */
  | 'vendor_lead_time'
  /** an item that appears on two or more non-cancelled POs — key
   *  `recurring_item:<itemId>` */
  | 'recurring_item'
  /** a project whose stage is not CLOSED — key `active_project:<projectId>` */
  | 'active_project';

export const NPI_FACT_KINDS: readonly NpiFactKind[] = [
  'customer_credit_terms',
  'contract_payment_terms',
  'vendor_lead_time',
  'recurring_item',
  'active_project',
];

/** The NPI reads a snapshot is built from. Each one needs the permission
 *  NPI's controller requires; a source the user cannot read is skipped. */
export type NpiMemorySource = 'customers' | 'contracts' | 'purchaseOrders' | 'projects';

export const NPI_MEMORY_SOURCES: readonly NpiMemorySource[] = ['customers', 'contracts', 'purchaseOrders', 'projects'];

/** Which kinds each source feeds (a skipped source leaves its kinds untouched). */
export const KINDS_OF_SOURCE: Record<NpiMemorySource, readonly NpiFactKind[]> = {
  customers: ['customer_credit_terms'],
  contracts: ['contract_payment_terms'],
  purchaseOrders: ['vendor_lead_time', 'recurring_item'],
  projects: ['active_project'],
};

/** NPI permission key each source's list endpoint requires
 *  (`packages/shared/src/permissions.ts`; checked against `session.user.permissions`). */
export const PERMISSION_OF_SOURCE: Record<NpiMemorySource, string> = {
  customers: 'crm.customer.read',
  contracts: 'commercial.contract.read',
  purchaseOrders: 'scm.procurement.read',
  projects: 'projects.project.read',
};

/** D-17 (T-29b): the permission each kind of derived fact carries
 *  (`MemoryFact.sourcePermission`) — the permission of the source that feeds
 *  the kind. Computed from the two maps above, never retyped. Migration
 *  0008's backfill spells the same map out in SQL: keep them in step. */
export const PERMISSION_OF_KIND: Record<NpiFactKind, string> = (() => {
  const map = {} as Record<NpiFactKind, string>;
  for (const source of NPI_MEMORY_SOURCES) {
    for (const kind of KINDS_OF_SOURCE[source]) map[kind] = PERMISSION_OF_SOURCE[source];
  }
  return map;
})();

// ─── Snapshot rows: exactly the fields the derivation reads ─────────────────
// Dates are ISO strings as NPI serializes them; amounts are numbers (NPI sends
// Prisma Decimals as strings — the readers parse them).

export interface NpiCustomerRow {
  id: string;
  code: string;
  nameAr: string;
  /** `Customer.creditTermsDays` (default 0 = not set). */
  creditTermsDays: number;
}

export interface NpiContractRow {
  id: string;
  code: string;
  /** DRAFT | ACTIVE | SUSPENDED | CLOSED | CANCELLED */
  status: string;
  /** EPC | PPA | OM | LEASE */
  contractType: string;
  totalValue: number;
  retentionPct: number;
  advancePct: number;
  startDate: string | null;
  endDate: string | null;
  customer: { id: string; code: string; nameAr: string };
  /** `_count.milestones` of the list endpoint. */
  milestoneCount: number;
}

export interface NpiPurchaseOrderLine {
  itemId: string;
  sku: string;
  nameAr: string;
  uom: string;
  qty: number;
}

export interface NpiGoodsReceiptRow {
  id: string;
  code: string;
  /** DRAFT | INSPECTED | ACCEPTED | PARTIALLY_REJECTED */
  status: string;
  receivedAt: string;
}

/** One purchase order as `GET /procurement/purchase-orders/:id` returns it
 *  (vendor row, lines with their item, goods receipts). */
export interface NpiPurchaseOrderRow {
  id: string;
  code: string;
  /** DRAFT | PENDING_APPROVAL | APPROVED | SENT | PARTIALLY_RECEIVED | RECEIVED | CLOSED | CANCELLED */
  status: string;
  createdAt: string;
  approvedAt: string | null;
  vendor: { id: string; code: string; nameAr: string };
  project: { id: string; code: string } | null;
  lines: NpiPurchaseOrderLine[];
  goodsReceipts: NpiGoodsReceiptRow[];
}

export interface NpiProjectRow {
  id: string;
  code: string;
  nameAr: string;
  /** PLANNING | PROCUREMENT | EXECUTION | COMMISSIONING | CLOSED */
  stage: string;
  capacityKwp: number | null;
  plannedEnd: string | null;
  contract: { code: string; customer: { nameAr: string } };
}

export interface NpiMemorySnapshot {
  customers: NpiCustomerRow[];
  contracts: NpiContractRow[];
  purchaseOrders: NpiPurchaseOrderRow[];
  projects: NpiProjectRow[];
}

/** Per source: how many rows were read, or why it was not read. */
export type SnapshotSourceOutcome =
  | { status: 'read'; rows: number }
  | { status: 'skipped'; reason: 'no_permission' | 'npi_refused' | 'npi_error' | 'not_requested' };

export interface SnapshotLoad {
  snapshot: NpiMemorySnapshot;
  sources: Record<NpiMemorySource, SnapshotSourceOutcome>;
}

// ─── Derived facts ──────────────────────────────────────────────────────────

/** `MemoryFact.entityType` values a derived fact may carry. */
export type NpiFactEntityType = 'customer' | 'vendor' | 'project' | 'item';

export interface DerivedFact {
  kind: NpiFactKind;
  /** Stable identity: `<kind>:<npi id of the thing>`; the refresh replaces by it. */
  key: string;
  entityType: NpiFactEntityType;
  /** The NPI id of the entity the fact is filed under (customer / vendor /
   *  project / item id — for a contract fact, the customer id). */
  npiEntityId: string;
  /** One self-contained Arabic sentence, at most 25 words, Latin only in
   *  document codes and SKUs (spec/madar/08 §E.8). */
  factAr: string;
  /** Stored as `MemoryFact.valueJson`; always carries `kind` and `key`. */
  valueJson: { kind: NpiFactKind; key: string } & Record<string, unknown>;
  /** 0..1 — how far the sentence is a plain reading of the data. */
  confidence: number;
  /** D-17: the NPI permission of the fact's source (`PERMISSION_OF_KIND[kind]`);
   *  stored as `MemoryFact.sourcePermission`, checked at retrieval. */
  sourcePermission: string;
}

export interface RefreshOutcome {
  sources: Record<NpiMemorySource, SnapshotSourceOutcome>;
  derived: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Facts of a refreshed kind whose key no longer derives (a closed project,
   *  a cancelled contract) — removed. */
  removed: number;
}
