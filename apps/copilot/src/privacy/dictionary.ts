// Builds the pseudonymizer's dictionary from NPI: the names of customers,
// vendors, projects and employees that must never reach the model in clear.
//
// The lists are read through NPI's API with the caller's own token. A list
// the caller may not read (403) is skipped: the pseudonymizer's pattern
// rules still apply to the text, and NPI will refuse the same data to the
// tools anyway. Results are cached per organization for five minutes
// (spec/madar/02 §4). The cache holds names only, is used only to mask
// outbound text, and is never shown to a user.
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

interface CacheEntry {
  at: number;
  entries: DictionaryEntry[];
}

const cache = new Map<string, CacheEntry>();

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

async function readKind(kind: EntityKind, read: () => Promise<unknown>): Promise<DictionaryEntry[]> {
  let body: unknown;
  try {
    body = await read();
  } catch (err) {
    // Not allowed to read it, or NPI is unreachable: go on without this list.
    if (err instanceof NpiError) return [];
    throw err;
  }
  let rows: unknown[];
  try {
    rows = readList(body);
  } catch (err) {
    if (err instanceof NpiError) return [];
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
  const cached = cache.get(caller.npiOrgId);
  let shared: DictionaryEntry[];
  if (cached && now() - cached.at < TTL_MS) {
    shared = cached.entries;
  } else {
    const lists = await Promise.all([
      readKind('customer', () => npi.listCustomers()),
      readKind('vendor', () => npi.listVendors()),
      readKind('project', () => npi.listProjects()),
      readKind('employee', () => npi.listDepartmentDirectory()),
    ]);
    shared = lists.flat();
    // An empty result (everything refused) is not cached, so that a later
    // caller with wider permissions fills the dictionary.
    if (shared.length > 0) cache.set(caller.npiOrgId, { at: now(), entries: shared });
  }

  // The caller's own name is always known, whatever NPI let them list.
  const self: DictionaryEntry = { kind: 'employee', npiId: caller.npiUserId, names: [caller.nameAr] };
  return shared.some((entry) => entry.kind === 'employee' && entry.npiId === caller.npiUserId)
    ? shared
    : [...shared, self];
}
