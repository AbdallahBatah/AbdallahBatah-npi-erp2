// Writes facts into the firm's memory (`memory_facts`).
//
// A fact is one short Arabic sentence about a customer, vendor, project, item
// or position, with where it came from (`npi` data or `chat`) and how sure we
// are. Facts live in the copilot's own database in clear text: they never
// leave it except through the pseudonymizer.
//
// BR-06: nothing about an employee's performance is ever stored. The same
// guard that refuses such questions in the chat refuses such facts here.
import type { PrismaClient } from '../generated/prisma';
import { isHrEvaluationRequest } from '../agents/hr-guard';
import { buildSearchText } from './fts';

export type MemoryScope = 'company' | 'position';
export type MemoryEntityType = 'customer' | 'vendor' | 'project' | 'item' | 'position';
export type MemorySourceType = 'npi' | 'chat';

export interface NewFact {
  npiOrgId: string;
  scope: MemoryScope;
  /** Required when `scope` is `position`. */
  positionId?: string | null;
  entityType: MemoryEntityType;
  npiEntityId?: string | null;
  factAr: string;
  valueJson?: unknown;
  sourceType: MemorySourceType;
  /** 0..1 */
  confidence: number;
}

export type SaveResult =
  | { saved: true; id: string; created: boolean }
  | { saved: false; reason: 'empty' | 'too_long' | 'hr_guard' | 'position_missing' | 'bad_confidence' };

export type MemoryStoreDb = Pick<PrismaClient, 'memoryFact'>;

const MAX_FACT_LENGTH = 500;

/**
 * Saves one fact. The same sentence (after normalization) in the same scope
 * is one fact: a repeat raises the stored confidence to the higher of the
 * two and refreshes `updatedAt` instead of inserting a duplicate.
 */
export async function saveFact(db: MemoryStoreDb, fact: NewFact): Promise<SaveResult> {
  const factAr = fact.factAr.trim();
  if (factAr.length === 0) return { saved: false, reason: 'empty' };
  if (factAr.length > MAX_FACT_LENGTH) return { saved: false, reason: 'too_long' };
  if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) {
    return { saved: false, reason: 'bad_confidence' };
  }
  if (isHrEvaluationRequest(factAr)) return { saved: false, reason: 'hr_guard' };

  const positionId = fact.scope === 'position' ? (fact.positionId ?? null) : null;
  if (fact.scope === 'position' && positionId === null) {
    return { saved: false, reason: 'position_missing' };
  }

  const searchText = buildSearchText(factAr);
  if (searchText.length === 0) return { saved: false, reason: 'empty' };

  const existing = await db.memoryFact.findFirst({
    where: { npiOrgId: fact.npiOrgId, scope: fact.scope, positionId, searchText },
    select: { id: true, confidence: true },
  });

  if (existing) {
    await db.memoryFact.update({
      where: { id: existing.id },
      data: { confidence: Math.max(existing.confidence, fact.confidence) },
    });
    return { saved: true, id: existing.id, created: false };
  }

  const created = await db.memoryFact.create({
    data: {
      npiOrgId: fact.npiOrgId,
      scope: fact.scope,
      positionId,
      entityType: fact.entityType,
      npiEntityId: fact.npiEntityId ?? null,
      factAr,
      searchText,
      valueJson: fact.valueJson === undefined ? undefined : (fact.valueJson as never),
      sourceType: fact.sourceType,
      confidence: fact.confidence,
    },
    select: { id: true },
  });
  return { saved: true, id: created.id, created: true };
}
