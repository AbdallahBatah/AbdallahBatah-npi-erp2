// Full-text + fuzzy search over MemoryFact.
//
// The search combines two independent match strategies so both an exact
// (accented/tashkeel-varying) word match and a slightly misspelled name are
// found:
//   - `fts @@ plainto_tsquery('simple', q)` — exact token match against the
//     generated tsvector column (see prisma/migrations/0002_core).
//   - `word_similarity(q, "searchText") >= 0.3` — trigram fuzzy match, for
//     misspellings that would never match a tsquery.
// Both operate on `searchText`, the already-normalized (normalizeArabic)
// form of `factAr` — never on the raw Arabic text, which still carries
// tashkeel/alef variants that would defeat exact matching.
import { Prisma, type PrismaClient } from '../generated/prisma';
import { normalizeArabic } from '../text/normalize';

export interface FactSearchParams {
  /** Mandatory tenant filter: every query is scoped to one NPI organization. */
  npiOrgId: string;
  query: string;
  /** The caller's own position, if any. Position-scoped facts for a
   * *different* position (or for no position at all) are never returned. */
  positionId?: string | null;
  /** Default 5, max 20. */
  limit?: number;
}

export interface FactHit {
  id: string;
  factAr: string;
  scope: 'company' | 'position';
  entityType: string;
  npiEntityId: string | null;
  valueJson: unknown;
  sourceType: 'npi' | 'chat';
  confidence: number;
  score: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const SIMILARITY_THRESHOLD = 0.3;

/** The normalized form to store in `MemoryFact.searchText`. */
export function buildSearchText(factAr: string): string {
  return normalizeArabic(factAr);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

interface FactSearchRow {
  id: string;
  factAr: string;
  scope: string;
  entityType: string;
  npiEntityId: string | null;
  valueJson: unknown;
  sourceType: string;
  confidence: number;
  score: number;
}

/** Only `$queryRaw` is used, so callers may pass a narrowed client. */
export type FactSearchDb = Pick<PrismaClient, '$queryRaw'>;

export async function searchFacts(
  db: FactSearchDb,
  params: FactSearchParams,
): Promise<FactHit[]> {
  const q = normalizeArabic(params.query);
  if (q.length === 0) {
    return [];
  }

  const limit = clampLimit(params.limit);
  const positionId = params.positionId ?? null;

  // Visibility: company-scope facts are visible to everyone in the org.
  // Position-scope facts are visible only to the matching positionId — a
  // null/undefined positionId on the caller never matches a position-scope
  // row, even if that row's positionId happens to also be null.
  const visibility = positionId
    ? Prisma.sql`("scope" = 'company' OR ("scope" = 'position' AND "positionId" = ${positionId}))`
    : Prisma.sql`("scope" = 'company')`;

  const rows = await db.$queryRaw<FactSearchRow[]>(Prisma.sql`
    SELECT
      "id",
      "factAr",
      "scope"::text AS "scope",
      "entityType"::text AS "entityType",
      "npiEntityId",
      "valueJson",
      "sourceType"::text AS "sourceType",
      "confidence",
      (
        ts_rank("fts", plainto_tsquery('simple', ${q}))
        + word_similarity(${q}, "searchText")
      ) AS "score"
    FROM "memory_facts"
    WHERE "npiOrgId" = ${params.npiOrgId}
      AND ${visibility}
      AND (
        "fts" @@ plainto_tsquery('simple', ${q})
        OR word_similarity(${q}, "searchText") >= ${SIMILARITY_THRESHOLD}
      )
    ORDER BY "score" DESC, "confidence" DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    id: row.id,
    factAr: row.factAr,
    scope: row.scope as FactHit['scope'],
    entityType: row.entityType,
    npiEntityId: row.npiEntityId,
    valueJson: row.valueJson,
    sourceType: row.sourceType as FactHit['sourceType'],
    confidence: row.confidence,
    score: Number(row.score),
  }));
}
