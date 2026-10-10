// Provider-agnostic types for the copilot's LLM boundary. Everything text
// that crosses this boundary must already be a `RedactedText` — that is
// enforced by the type of `RedactedRequest.system`/`.messages`, not by any
// runtime check here. An image or PDF crosses this boundary only as a
// `ConsentedBase64` value carrying the id of the consent event that covers
// it (T-22, ADR-27, invariant I4) — produced exclusively by
// `src/llm/vision.ts` from a `VerifiedConsent`, never by a plain string cast.
import type { RedactedText } from '../privacy/pseudonymizer';

export type ModelTier = 'economy' | 'advanced';

export type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

declare const consentedBrand: unique symbol;
/** Base64 bytes of an image or PDF that a recorded consent event covers.
 *  Only src/llm/vision.ts produces this; a plain string is not assignable. */
export type ConsentedBase64 = string & { readonly [consentedBrand]: true };

export type RedactedBlock =
  | { type: 'text'; text: RedactedText }
  // The model's own earlier tool call, echoed back on a later turn.
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: RedactedText; isError?: boolean }
  // An image/scan page sent with vision (02 §5.3). `sizeBytes` is the raw
  // (pre-base64) byte length — used for the request-size limit and shown in
  // the audit trail; `consentEventId` is the id of the recorded consent
  // event that covers it (I4).
  | {
      type: 'image';
      mediaType: VisionMediaType;
      data: ConsentedBase64;
      consentEventId: string;
      sizeBytes: number;
    }
  // A PDF sent with vision, always as a whole document (ADR-27: only
  // `pdf_scanned` pages reach this path, never `pdf_text`).
  | {
      type: 'document';
      mediaType: 'application/pdf';
      data: ConsentedBase64;
      consentEventId: string;
      sizeBytes: number;
      title?: string;
    };

export interface RedactedMessage {
  role: 'user' | 'assistant';
  content: RedactedText | RedactedBlock[];
}

/** A static tool definition, written by developers (never derived from user/NPI data). */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RedactedRequest {
  tier: ModelTier;
  /** Becomes `llm_audit.event`, e.g. 'chat', 'router', 'memory_extract'. */
  purpose: string;
  system: RedactedText;
  messages: RedactedMessage[];
  tools?: ToolDef[];
  /** Default: 4096 for economy, 16000 for advanced. */
  maxTokens?: number;
  /** When set, ask for structured JSON output matching this schema. */
  jsonSchema?: Record<string, unknown>;
  /** Advanced tier only. */
  effort?: 'low' | 'medium' | 'high';
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  tokensIn: number;
  tokensOut: number;
  modelId: string;
}

export interface ProviderCall {
  modelId: string;
  timeoutMs: number;
  request: RedactedRequest;
}

export interface ModelProvider {
  readonly name: 'anthropic';
  complete(call: ProviderCall): Promise<ModelResponse>;
}
