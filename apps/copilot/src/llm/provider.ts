// Provider-agnostic types for the copilot's LLM boundary. Everything text
// that crosses this boundary must already be a `RedactedText` — that is
// enforced by the type of `RedactedRequest.system`/`.messages`, not by any
// runtime check here.
import type { RedactedText } from '../privacy/pseudonymizer';

export type ModelTier = 'economy' | 'advanced';

export type RedactedBlock =
  | { type: 'text'; text: RedactedText }
  // The model's own earlier tool call, echoed back on a later turn.
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: RedactedText; isError?: boolean };

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
