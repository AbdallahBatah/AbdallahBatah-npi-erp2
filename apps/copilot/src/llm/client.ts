// The single entry point every feature must go through to call an LLM.
// Enforces: provider allow-list, per-tier model/timeout selection, the
// per-user daily token cap, and — unconditionally — one llm_audit row per
// attempt (a failure to write that row fails the call; there is no
// un-audited model traffic). T-22 adds vision input: every image/document
// block in a request must share one consent event and go out only on the
// advanced tier (spec/madar/02 §5.3); `outboundRedactedText` is built from
// an audit-safe view of the messages that never carries base64 image data,
// and every audit row is written through `writeLlmAudit` so invariant I4
// (an image never leaves without a recorded consent id) is enforced before
// any row reaches the database.
import type { ModelProvider, ModelResponse, RedactedMessage, RedactedRequest } from './provider';
import { costUsdMicro, isPriced } from './pricing';
import { writeLlmAudit, type LlmAuditData } from '../audit/log';
import { auditViewOfMessages } from './vision';

export type { LlmAuditData } from '../audit/log';

export type LlmErrorKind =
  | 'not_configured'
  | 'cap_reached'
  | 'timeout'
  | 'rate_limited'
  | 'network'
  | 'provider_down'
  | 'bad_request'
  | 'refused';

const MESSAGES_AR: Record<LlmErrorKind, string> = {
  not_configured: 'مزوّد النماذج غير مهيّأ. راجع مدير النظام.',
  cap_reached: 'بلغت حد الاستخدام اليومي. يتجدد الحد غداً.',
  timeout: 'تأخر الرد أكثر من المهلة. حاول مرة أخرى.',
  rate_limited: 'الطلبات كثيرة الآن. حاول بعد قليل.',
  network: 'تعذر الوصول إلى مزوّد النماذج.',
  provider_down: 'مزوّد النماذج غير متاح حالياً.',
  bad_request: 'تعذر تنفيذ الطلب.',
  refused: 'لا أستطيع المساعدة في هذا الطلب.',
};

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly messageAr: string;

  constructor(kind: LlmErrorKind, message?: string) {
    super(message ?? kind);
    this.name = 'LlmError';
    this.kind = kind;
    this.messageAr = MESSAGES_AR[kind];
  }
}

export interface LlmContext {
  npiOrgId: string;
  npiUserId: string;
  conversationId?: string;
  intakeJobId?: string;
  documentId?: string;
}

interface UsageKey {
  npiUserId_day: { npiUserId: string; day: Date };
}

/**
 * The part of the Prisma client that createLlmClient calls, typed closely
 * enough that the real client satisfies it without a cast (checked in
 * tests/llm-db.spec.ts) and a small in-memory fake does too.
 */
export interface LlmDb {
  llmAudit: {
    create(args: { data: LlmAuditData }): Promise<unknown>;
  };
  dailyUsage: {
    findUnique(args: { where: UsageKey }): Promise<{ tokensIn: number; tokensOut: number } | null>;
    upsert(args: {
      where: UsageKey;
      create: {
        npiOrgId: string;
        npiUserId: string;
        day: Date;
        tokensIn: number;
        tokensOut: number;
        costUsdMicro: bigint;
        messageCount: number;
      };
      update: {
        tokensIn: { increment: number };
        tokensOut: { increment: number };
        costUsdMicro: { increment: bigint };
      };
    }): Promise<unknown>;
  };
}

const DEFAULT_ECONOMY_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_ADVANCED_MODEL = 'claude-sonnet-5';
const ECONOMY_TIMEOUT_MS = 20_000;
const ADVANCED_TIMEOUT_MS = 60_000;
const DEFAULT_DAILY_TOKEN_CAP = 600_000;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000; // Asia/Riyadh: UTC+3, no DST

function riyadhDateOnly(now: Date): Date {
  const shifted = new Date(now.getTime() + RIYADH_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function modelIdForTier(env: NodeJS.ProcessEnv, tier: RedactedRequest['tier']): string {
  if (tier === 'advanced') {
    return env.COPILOT_MODEL_ADVANCED?.trim() || DEFAULT_ADVANCED_MODEL;
  }
  return env.COPILOT_MODEL_ECONOMY?.trim() || DEFAULT_ECONOMY_MODEL;
}

function timeoutForTier(tier: RedactedRequest['tier']): number {
  return tier === 'advanced' ? ADVANCED_TIMEOUT_MS : ECONOMY_TIMEOUT_MS;
}

function dailyCap(env: NodeJS.ProcessEnv): number {
  const raw = env.COPILOT_DAILY_TOKEN_CAP;
  if (!raw) return DEFAULT_DAILY_TOKEN_CAP;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_TOKEN_CAP;
}

/** Scans every message for image/document ("vision") blocks. Used to
 *  enforce that a request carries at most one consent event and only ever
 *  targets the advanced tier (spec/madar/02 §5.3) — both checked before
 *  anything is sent. `totalRawBytes` is informational here; the per-block
 *  and per-request byte limits are already enforced where blocks are built
 *  (src/llm/vision.ts), before they ever reach this client. */
function scanVisionBlocks(messages: RedactedMessage[]): {
  visionCount: number;
  consentEventIds: Set<string>;
  totalRawBytes: number;
} {
  let visionCount = 0;
  const consentEventIds = new Set<string>();
  let totalRawBytes = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'image' || block.type === 'document') {
        visionCount += 1;
        consentEventIds.add(block.consentEventId);
        totalRawBytes += block.sizeBytes;
      }
    }
  }
  return { visionCount, consentEventIds, totalRawBytes };
}

export function createLlmClient(deps: {
  provider: ModelProvider;
  db: LlmDb;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): { complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> } {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());

  async function complete(req: RedactedRequest, ctx: LlmContext): Promise<ModelResponse> {
    const provider = (env.MADAR_PROVIDER?.trim() || 'anthropic').toLowerCase();
    if (provider !== 'anthropic') {
      throw new LlmError('not_configured', `Unsupported MADAR_PROVIDER: "${env.MADAR_PROVIDER}"`);
    }

    const modelId = modelIdForTier(env, req.tier);
    // Checked before anything is sent: a call whose cost cannot be computed
    // could not be audited afterwards.
    if (!isPriced(modelId)) {
      throw new LlmError('not_configured', `No price configured for model "${modelId}"`);
    }

    // Vision pre-flight (02 §5.3): both are programming errors caught before
    // anything is sent, so — like `not_configured` — neither writes an audit
    // row. A request may carry blocks covered by at most one consent event,
    // and vision input only ever travels on the advanced tier.
    const { visionCount, consentEventIds } = scanVisionBlocks(req.messages);
    if (visionCount > 0) {
      if (consentEventIds.size !== 1) {
        throw new LlmError('bad_request', 'vision blocks must share one consent event');
      }
      if (req.tier !== 'advanced') {
        throw new LlmError('bad_request', 'vision input requires the advanced tier (02 §5.3)');
      }
    }
    const singleConsentEventId = consentEventIds.size === 1 ? [...consentEventIds][0] : null;

    const timeoutMs = timeoutForTier(req.tier);
    const day = riyadhDateOnly(now());
    const cap = dailyCap(env);

    const existing = await deps.db.dailyUsage.findUnique({
      where: { npiUserId_day: { npiUserId: ctx.npiUserId, day } },
    });
    const existingTotal = existing ? existing.tokensIn + existing.tokensOut : 0;

    if (existingTotal >= cap) {
      await writeLlmAudit(deps.db, {
        npiOrgId: ctx.npiOrgId,
        npiUserId: ctx.npiUserId,
        conversationId: ctx.conversationId ?? null,
        intakeJobId: ctx.intakeJobId ?? null,
        documentId: ctx.documentId ?? null,
        event: 'cap_reached',
        modelTier: null,
        modelId: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicro: 0n,
        outboundRedactedText: null,
        imageSent: false,
        consentEventId: null,
        latencyMs: null,
        error: null,
      });
      throw new LlmError('cap_reached');
    }

    // Built before the call: the trust log must show what left the building
    // even when the provider then fails or times out. The audit view never
    // carries base64 image/document data (src/llm/vision.ts auditView).
    const outboundRedactedText = JSON.stringify({
      system: req.system,
      messages: auditViewOfMessages(req.messages),
    });

    const startedAt = Date.now();
    let response: ModelResponse;
    try {
      response = await deps.provider.complete({ modelId, timeoutMs, request: req });
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const llmErr = err instanceof LlmError ? err : new LlmError('bad_request', describe(err));
      // `not_configured` is raised before anything is sent.
      const sent = llmErr.kind !== 'not_configured';
      // The image DID leave when the provider failed after sending.
      const imageSent = sent && visionCount > 0;
      await writeLlmAudit(deps.db, {
        npiOrgId: ctx.npiOrgId,
        npiUserId: ctx.npiUserId,
        conversationId: ctx.conversationId ?? null,
        intakeJobId: ctx.intakeJobId ?? null,
        documentId: ctx.documentId ?? null,
        event: req.purpose,
        modelTier: req.tier,
        modelId,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicro: 0n,
        outboundRedactedText: sent ? outboundRedactedText : null,
        imageSent,
        consentEventId: imageSent ? singleConsentEventId : null,
        latencyMs,
        error: llmErr.kind,
      });
      throw llmErr;
    }
    const latencyMs = Date.now() - startedAt;

    const cost = costUsdMicro(modelId, response.tokensIn, response.tokensOut);
    const imageSent = visionCount > 0;

    await writeLlmAudit(deps.db, {
      npiOrgId: ctx.npiOrgId,
      npiUserId: ctx.npiUserId,
      conversationId: ctx.conversationId ?? null,
      intakeJobId: ctx.intakeJobId ?? null,
      documentId: ctx.documentId ?? null,
      event: req.purpose,
      modelTier: req.tier,
      modelId,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      costUsdMicro: cost,
      outboundRedactedText,
      imageSent,
      consentEventId: imageSent ? singleConsentEventId : null,
      latencyMs,
      error: null,
    });

    await deps.db.dailyUsage.upsert({
      where: { npiUserId_day: { npiUserId: ctx.npiUserId, day } },
      create: {
        npiOrgId: ctx.npiOrgId,
        npiUserId: ctx.npiUserId,
        day,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        costUsdMicro: cost,
        messageCount: 0,
      },
      update: {
        tokensIn: { increment: response.tokensIn },
        tokensOut: { increment: response.tokensOut },
        costUsdMicro: { increment: cost },
      },
    });

    if (response.stopReason === 'refusal') {
      throw new LlmError('refused');
    }

    return response;
  }

  return { complete };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
