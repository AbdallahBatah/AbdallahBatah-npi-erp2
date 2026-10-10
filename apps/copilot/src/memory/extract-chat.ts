// Learns lasting facts from what an employee writes in the chat.
//
// Most messages hold no fact, and each extraction is a model call, so a cheap
// local check decides first whether a message is worth sending at all. The
// model then sees the redacted message only; the facts it returns carry
// placeholders, which are turned back into real names before being stored in
// the copilot's own database.
//
// Best effort by design: a failure here never fails the chat turn.
import { z } from 'zod';
import { loadPrompt } from '../prompts/load';
import type { LlmContext } from '../llm/client';
import type { ModelResponse, RedactedRequest } from '../llm/provider';
import { staticPrompt, type Pseudonymizer } from '../privacy/pseudonymizer';
import { normalizeArabic } from '../text/normalize';
import { hasAnyPhrase, tokenize } from '../text/tokens';
import { saveFact, type MemoryStoreDb } from './store';

const MIN_CONFIDENCE = 0.7;
const MAX_FACTS_PER_MESSAGE = 3;

const MEMORY_CUES = [
  'دائما', 'دايما', 'دايم', 'عادة', 'بالعادة', 'كل مرة', 'كل شهر', 'كل اسبوع',
  'شروط السداد', 'شروط الدفع', 'شروط', 'مهلة', 'مدة التوريد', 'مدة التسليم',
  'يفضل', 'نفضل', 'افضل التعامل', 'يشترط', 'اتفقنا', 'متفقين', 'المتفق عليه',
  'تذكر', 'سجل عندك', 'خل في بالك', 'خلي في بالك', 'للعلم', 'لمعلوميتك', 'ملاحظة',
].map((cue) => normalizeArabic(cue));

const QUESTION_WORDS = ['كم', 'وش', 'ايش', 'هل', 'متى', 'وين', 'اين', 'ليش', 'لماذا', 'كيف', 'مين', 'ماذا'].map(
  (word) => normalizeArabic(word),
);

/** Cheap local check: does this message state something, and does it sound
 *  like a standing arrangement rather than a one-off request? */
export function looksMemorable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12 || trimmed.length > 1000) return false;
  if (trimmed.endsWith('؟') || trimmed.endsWith('?')) return false;
  const tokens = tokenize(normalizeArabic(trimmed));
  if (tokens.length < 3) return false;
  if (QUESTION_WORDS.includes(tokens[0])) return false;
  return hasAnyPhrase(tokens, MEMORY_CUES);
}

const extractedSchema = z.object({
  facts: z
    .array(
      z.object({
        factAr: z.string().trim().min(1).max(500),
        entityType: z.enum(['customer', 'vendor', 'project', 'item', 'position']),
        scope: z.enum(['company', 'position']),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(10),
});

const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factAr: { type: 'string' },
          entityType: { type: 'string', enum: ['customer', 'vendor', 'project', 'item', 'position'] },
          scope: { type: 'string', enum: ['company', 'position'] },
          confidence: { type: 'number' },
        },
        required: ['factAr', 'entityType', 'scope', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
} as const;

export interface ExtractDeps {
  db: MemoryStoreDb;
  llm: { complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> };
  pseudonymizer: Pseudonymizer;
}

export interface ExtractContext extends LlmContext {
  positionId: string | null;
}

export interface ExtractOutcome {
  attempted: boolean;
  saved: number;
}

export async function extractFactsFromMessage(
  deps: ExtractDeps,
  ctx: ExtractContext,
  text: string,
): Promise<ExtractOutcome> {
  if (!looksMemorable(text)) return { attempted: false, saved: 0 };

  let response: ModelResponse;
  try {
    response = await deps.llm.complete(
      {
        tier: 'economy',
        purpose: 'memory_extract',
        system: staticPrompt(loadPrompt('memory-extract.md')),
        messages: [{ role: 'user', content: deps.pseudonymizer.redact(text) }],
        maxTokens: 1024,
        jsonSchema: OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
      ctx,
    );
  } catch {
    return { attempted: true, saved: 0 };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(response.text);
  } catch {
    return { attempted: true, saved: 0 };
  }
  const parsed = extractedSchema.safeParse(parsedJson);
  if (!parsed.success) return { attempted: true, saved: 0 };

  let saved = 0;
  for (const fact of parsed.data.facts.slice(0, MAX_FACTS_PER_MESSAGE)) {
    if (fact.confidence < MIN_CONFIDENCE) continue;
    // A position fact needs a position; without one it is not stored at all
    // rather than widened to the whole company.
    if (fact.scope === 'position' && ctx.positionId === null) continue;
    const result = await saveFact(deps.db, {
      npiOrgId: ctx.npiOrgId,
      scope: fact.scope,
      positionId: fact.scope === 'position' ? ctx.positionId : null,
      entityType: fact.entityType,
      factAr: deps.pseudonymizer.rehydrate(fact.factAr),
      sourceType: 'chat',
      confidence: fact.confidence,
    });
    if (result.saved) saved += 1;
  }
  return { attempted: true, saved };
}
