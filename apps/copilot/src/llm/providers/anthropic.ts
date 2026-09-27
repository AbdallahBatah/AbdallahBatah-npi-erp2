// Anthropic provider: the only concrete `ModelProvider` implementation.
// Every request/response mapping here must match the installed
// `@anthropic-ai/sdk` (0.128.0) request/response shapes exactly — see the
// `claude-api` skill's TypeScript README/tool-use docs for the verified
// shapes this file follows (no sampling parameters, no `thinking`,
// `output_config.effort` only on the advanced tier, structured output via
// `output_config.format`, per-request timeout in milliseconds).
import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelProvider,
  ModelResponse,
  ProviderCall,
  RedactedBlock,
  RedactedMessage,
  StopReason,
  ToolCall,
} from '../provider';
import type { RedactedText } from '../../privacy/pseudonymizer';
import { LlmError } from '../client';

/**
 * The minimal shape of the Anthropic SDK client this provider actually
 * calls. Declared as our own interface (rather than importing the SDK's
 * `Anthropic` class type) so tests can inject a plain fake object without
 * constructing a real client.
 */
export interface AnthropicLike {
  messages: {
    create(params: unknown, options?: { timeout?: number }): Promise<unknown>;
  };
}

export interface CreateAnthropicProviderOptions {
  client?: AnthropicLike;
  /**
   * Accepted for interface shape parity only. Per the design, the real
   * client's key is read exclusively from `process.env.ANTHROPIC_API_KEY` —
   * this field is intentionally never read at runtime.
   */
  apiKey?: string;
}

interface AnthropicResponseContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface AnthropicMessageResponse {
  content?: AnthropicResponseContentBlock[];
  stop_reason?: string | null;
  model?: string;
  usage?: AnthropicResponseUsage;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function mapContentBlock(block: RedactedBlock): Record<string, unknown> {
  if (block.type === 'text') {
    return { type: 'text', text: block.text as unknown as string };
  }
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
  // tool_result
  return {
    type: 'tool_result',
    tool_use_id: block.toolUseId,
    content: block.content as unknown as string,
    ...(block.isError ? { is_error: true } : {}),
  };
}

function mapMessageContent(content: RedactedText | RedactedBlock[]): unknown {
  if (typeof content === 'string') {
    return content as unknown as string;
  }
  return content.map(mapContentBlock);
}

function mapMessages(messages: RedactedMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => ({ role: m.role, content: mapMessageContent(m.content) }));
}

function mapSdkError(err: unknown): LlmError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError('not_configured', describe(err));
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError('rate_limited', describe(err));
  }
  // Must come before the generic APIConnectionError check: it's a subclass.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('timeout', describe(err));
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError('network', describe(err));
  }
  if (err instanceof Anthropic.APIError) {
    if (typeof err.status === 'number' && err.status >= 500) {
      return new LlmError('provider_down', describe(err));
    }
    return new LlmError('bad_request', describe(err));
  }
  return new LlmError('network', describe(err));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAnthropicProvider(opts?: CreateAnthropicProviderOptions): ModelProvider {
  let cachedClient: AnthropicLike | undefined = opts?.client;

  function getClient(): AnthropicLike {
    if (cachedClient) return cachedClient;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new LlmError('not_configured', 'ANTHROPIC_API_KEY is not set.');
    }
    cachedClient = new Anthropic({ apiKey, maxRetries: 0 }) as unknown as AnthropicLike;
    return cachedClient;
  }

  return {
    name: 'anthropic',
    async complete(call: ProviderCall): Promise<ModelResponse> {
      const anthropicClient = getClient();
      const { request } = call;

      const params: Record<string, unknown> = {
        model: call.modelId,
        max_tokens: request.maxTokens ?? (request.tier === 'advanced' ? 16000 : 4096),
        system: request.system as unknown as string,
        messages: mapMessages(request.messages),
      };

      if (request.tools && request.tools.length > 0) {
        params.tools = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }));
      }

      const outputConfig: Record<string, unknown> = {};
      if (request.tier === 'advanced' && request.effort) {
        outputConfig.effort = request.effort;
      }
      if (request.jsonSchema) {
        outputConfig.format = { type: 'json_schema', schema: request.jsonSchema };
      }
      if (Object.keys(outputConfig).length > 0) {
        params.output_config = outputConfig;
      }

      let response: AnthropicMessageResponse;
      try {
        response = (await anthropicClient.messages.create(params, {
          timeout: call.timeoutMs,
        })) as AnthropicMessageResponse;
      } catch (err) {
        if (err instanceof LlmError) throw err;
        throw mapSdkError(err);
      }

      const toolCalls: ToolCall[] = [];
      let text = '';
      for (const block of response.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        } else if (block.type === 'tool_use' && block.id && block.name) {
          toolCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      const usage = response.usage ?? {};
      const tokensIn =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      const tokensOut = usage.output_tokens ?? 0;

      return {
        text,
        toolCalls,
        stopReason: mapStopReason(response.stop_reason),
        tokensIn,
        tokensOut,
        modelId: response.model ?? call.modelId,
      };
    },
  };
}
