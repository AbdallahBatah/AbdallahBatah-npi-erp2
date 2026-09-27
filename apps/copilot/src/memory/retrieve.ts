// Reads facts from the firm's memory for one chat turn and records that they
// were used. Visibility (organization, and position for position-scoped
// facts) is enforced inside `searchFacts`.
import type { PrismaClient } from '../generated/prisma';
import { searchFacts, type FactHit } from './fts';

export type MemoryRetrieveDb = Pick<PrismaClient, '$queryRaw' | 'memoryFact'>;

export interface RetrieveParams {
  npiOrgId: string;
  positionId: string | null;
  query: string;
  /** Default 3: memory is a hint for the turn, not a document dump. */
  limit?: number;
  /** Hits scoring below this are dropped. Default 0.35. */
  minScore?: number;
  /** Count each returned fact as used. Default true; a caller that only
   *  offers the facts to the model passes false and counts the ones that
   *  ended up in the answer itself. */
  countUse?: boolean;
}

const DEFAULT_LIMIT = 3;
const DEFAULT_MIN_SCORE = 0.35;

export async function retrieveFacts(
  db: MemoryRetrieveDb,
  params: RetrieveParams,
  now: () => Date = () => new Date(),
): Promise<FactHit[]> {
  const hits = await searchFacts(db, {
    npiOrgId: params.npiOrgId,
    positionId: params.positionId,
    query: params.query,
    limit: params.limit ?? DEFAULT_LIMIT,
  });
  const kept = hits.filter((hit) => hit.score >= (params.minScore ?? DEFAULT_MIN_SCORE));
  if (params.countUse !== false) {
    await markUsed(
      db,
      kept.map((hit) => hit.id),
      now,
    );
  }
  return kept;
}

/** Counts a use of each fact; feeds the memory metric (assumption 2). */
export async function markUsed(
  db: Pick<PrismaClient, 'memoryFact'>,
  ids: string[],
  now: () => Date = () => new Date(),
): Promise<void> {
  if (ids.length === 0) return;
  await db.memoryFact.updateMany({
    where: { id: { in: ids } },
    data: { useCount: { increment: 1 }, lastUsedAt: now() },
  });
}
