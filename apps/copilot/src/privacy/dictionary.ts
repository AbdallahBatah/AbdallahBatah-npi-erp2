// Builds the pseudonymizer's dictionary from NPI: the names of customers,
// vendors, projects and employees that must never reach the model in clear.
//
// The four lists are read through NPI's API with the caller's own token, and
// what each caller may read differs: a sales employee reads customers, a
// site engineer reads vendors and projects, only an administrator reads the
// employee directory. So each list is cached on its own, per organization:
//
//  - a list is stored only when its read succeeded;
//  - a failed or refused read never replaces a list that is already known —
//    the last good one keeps being used, however old;
//  - a list is read again once it is older than five minutes (spec/madar/02
//    §4), by whichever caller comes next and is allowed to.
//
// The dictionary a turn gets is therefore the union of what recent callers
// of the organization could read, not only what this caller could. Sharing
// it that way is safe because the names are used for one thing only: to
// mask outbound text. They are never shown to a user and never sent
// anywhere.
//
// The dictionary is one of three layers, not the only one: tool results mask
// the fields they know to be names as whole values (see `sensitiveFields` in
// src/agents/tools/read.ts), and the pseudonymizer's patterns cover names
// that are in no list.
import { NpiError } from '../npi/errors';
import type { NpiClient } from '../npi/client';
import { readList } from '../npi/responses';
import type { DictionaryEntry, EntityKind } from './pseudonymizer';

export type DictionaryNpi = Pick<
  NpiClient,
  'listCustomers' | 'listVendors' | 'listProjects' | 'listDepartmentDirectory'
>;

export interface DictionaryCaller {
  npiOrgId: string;
  npiUserId: string;
  nameAr: string;
}

const TTL_MS = 5 * 60 * 1000;
const KINDS: readonly EntityKind[] = ['customer', 'vendor', 'project', 'employee'];

interface CachedList {
  at: number;
  entries: DictionaryEntry[];
}

/** organization -> kind -> last list read successfully */
const cache = new Map<string, Map<EntityKind, CachedList>>();

export function clearDictionaryCache(): void {
  cache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function names(row: Record<string, unknown>): string[] {
  return [row.nameAr, row.nameEn].filter(
    (name): name is string => typeof name === 'string' && name.trim().length > 0,
  );
}

/** The list, or `null` when NPI refused it, could not be reached, or sent
 *  something this file cannot read. */
async function readKind(kind: EntityKind, read: () => Promise<unknown>): Promise<DictionaryEntry[] | null> {
  let rows: unknown[];
  try {
    rows = readList(await read());
  } catch (err) {
    if (err instanceof NpiError) return null;
    throw err;
  }
  const entries: DictionaryEntry[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string') continue;
    const found = names(row);
    if (found.length > 0) entries.push({ kind, npiId: row.id, names: found });
  }
  return entries;
}

export async function buildDictionary(
  npi: DictionaryNpi,
  caller: DictionaryCaller,
  now: () => number = Date.now,
): Promise<DictionaryEntry[]> {
  const readers: Record<EntityKind, () => Promise<unknown>> = {
    customer: () => npi.listCustomers(),
    vendor: () => npi.listVendors(),
    project: () => npi.listProjects(),
    employee: () => npi.listDepartmentDirectory(),
  };

  let lists = cache.get(caller.npiOrgId);
  if (!lists) {
    lists = new Map();
    cache.set(caller.npiOrgId, lists);
  }
  const known = lists;

  await Promise.all(
    KINDS.map(async (kind) => {
      const cached = known.get(kind);
      if (cached && now() - cached.at < TTL_MS) return;
      const fresh = await readKind(kind, readers[kind]);
      // A refusal or a failure leaves the last good list in place.
      if (fresh !== null) known.set(kind, { at: now(), entries: fresh });
    }),
  );

  const shared = KINDS.flatMap((kind) => known.get(kind)?.entries ?? []);

  // The caller's own name is always known, whatever NPI let them list.
  const self: DictionaryEntry = { kind: 'employee', npiId: caller.npiUserId, names: [caller.nameAr] };
  return shared.some((entry) => entry.kind === 'employee' && entry.npiId === caller.npiUserId)
    ? shared
    : [...shared, self];
}
