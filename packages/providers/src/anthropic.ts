import { AgentOSError, isJsonObject, type JsonObject, type JsonValue, type Message, type ToolCall } from '@agentos/core';
import { ANTHROPIC_MODELS, unknownModel } from './catalog.js';
import { httpJson } from './http.js';
import {
  estimateCost,
  estimateMessageTokens,
  estimateTokens,
  type FinishReason,
  type GenerateContext,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from './types.js';

export interface AnthropicOptions {
  apiKey: () => string | undefined;
  baseUrl?: string;
  version?: string;
  models?: ModelInfo[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  id?: string;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

const STOP_MAP: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  refusal: 'content_filter',
};

/**
 * Anthropic Messages API adapter. The wire format differs enough from the
 * OpenAI shape (system prompt hoisted out, content blocks, tool_result blocks)
 * that it gets its own translation rather than a compatibility shim.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly remote = true;

  constructor(private readonly options: AnthropicOptions) {
    this.id = options.id ?? 'anthropic';
  }

  supports(model: string): boolean {
    return this.listModels().length === 0 || this.listModels().some((m) => m.id === model) || model.startsWith('claude');
  }

  listModels(): ModelInfo[] {
    return this.options.models ?? ANTHROPIC_MODELS;
  }

  info(model: string): ModelInfo {
    return this.listModels().find((m) => m.id === model) ?? unknownModel(model);
  }

  private translate(messages: Message[]): { system: string; messages: JsonValue } {
    const system: string[] = [];
    const out: JsonObject[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        system.push(m.content);
        continue;
      }
      if (m.role === 'user') {
        out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
        continue;
      }
      if (m.role === 'assistant') {
        const blocks: JsonObject[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const call of m.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
        }
        out.push({ role: 'assistant', content: blocks as unknown as JsonValue });
        continue;
      }
      // Tool results must be attached to a user turn in this API.
      const block: JsonObject = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      if (last && last['role'] === 'user' && Array.isArray(last['content'])) {
        (last['content'] as JsonValue[]).push(block as unknown as JsonValue);
      } else {
        out.push({ role: 'user', content: [block] as unknown as JsonValue });
      }
    }

    return { system: system.join('\n\n'), messages: out as unknown as JsonValue };
  }

  async generate(request: ModelRequest, context: GenerateContext = {}): Promise<ModelResponse> {
    if (context.offlineOnly) {
      throw new AgentOSError('policy_denied', 'anthropic provider is remote and this execution is offline-only');
    }
    const started = Date.now();
    const key = this.options.apiKey();
    if (!key) throw new AgentOSError('secret_missing', 'anthropic api key is not configured');

    const { system, messages } = this.translate(request.messages);
    const info = this.info(request.model);
    const body: JsonObject = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? Math.min(info.maxOutputTokens, 4_096),
      messages,
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.stopSequences ? { stop_sequences: request.stopSequences } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as JsonValue,
            })),
            ...(request.toolChoice === 'required'
              ? { tool_choice: { type: 'any' } }
              : request.toolChoice === 'none'
                ? { tool_choice: { type: 'none' } }
                : { tool_choice: { type: 'auto' } }),
          }
        : {}),
    };

    const payload = await httpJson<Record<string, unknown>>(
      `${this.options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      {
        headers: {
          'x-api-key': key,
          'anthropic-version': this.options.version ?? '2023-06-01',
        },
        body,
        signal: context.signal,
        timeoutMs: this.options.timeoutMs,
        fetchImpl: this.options.fetchImpl,
      },
    );

    const blocks = (payload['content'] as AnthropicBlock[] | undefined) ?? [];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b, i) => ({
        id: b.id ?? `call_${i}`,
        name: b.name ?? 'unknown',
        arguments: isJsonObject(b.input) ? b.input : {},
      }));

    const usageRaw = (payload['usage'] ?? {}) as Record<string, number>;
    const usage = {
      inputTokens: usageRaw['input_tokens'] ?? estimateMessageTokens(request.messages),
      outputTokens: usageRaw['output_tokens'] ?? estimateTokens(text),
      ...(usageRaw['cache_read_input_tokens'] !== undefined
        ? { cachedInputTokens: usageRaw['cache_read_input_tokens'] }
        : {}),
    };

    return {
      provider: this.id,
      model: request.model,
      content: text || null,
      toolCalls,
      finishReason: STOP_MAP[String(payload['stop_reason'] ?? 'end_turn')] ?? 'stop',
      usage,
      costMicroUsd: estimateCost(info, usage),
      latencyMs: Date.now() - started,
    };
  }
}

export function anthropicProvider(apiKey: () => string | undefined, overrides: Partial<AnthropicOptions> = {}) {
  return new AnthropicProvider({ apiKey, ...overrides });
}
