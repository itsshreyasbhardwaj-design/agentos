import { AgentOSError, isJsonObject, type JsonObject, type JsonValue, type Message, type ToolCall } from '@agentos/core';
import { catalogFor, unknownModel } from './catalog.js';
import { httpJson } from './http.js';
import {
  estimateMessageTokens,
  estimateTokens,
  estimateCost,
  type FinishReason,
  type GenerateContext,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from './types.js';

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  /** Resolved lazily so a key is never held in a definition or a log line. */
  apiKey?: () => string | undefined;
  models?: ModelInfo[];
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

function toOpenAIMessages(messages: Message[]): JsonValue {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  }) as JsonValue;
}

function parseArguments(raw: string | undefined, callId: string): JsonObject {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isJsonObject(parsed)) return parsed;
    return { value: parsed as JsonValue };
  } catch {
    // A model that emits malformed JSON is a normal failure mode, not a crash.
    throw new AgentOSError('provider_error', `model returned non-JSON arguments for tool call ${callId}`, {
      details: { raw: raw.slice(0, 500) },
      retryable: true,
    });
  }
}

const FINISH_MAP: Record<string, FinishReason> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  length: 'length',
  content_filter: 'content_filter',
};

/**
 * Adapter for every OpenAI-shaped `/chat/completions` endpoint: OpenAI itself,
 * OpenRouter, Together, Groq, vLLM, LM Studio and anything else that copies the
 * schema. Pointing `baseUrl` at a local server is all a self-hosted model needs.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly remote = true;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
  }

  supports(model: string): boolean {
    const known = this.listModels();
    return known.length === 0 || known.some((m) => m.id === model);
  }

  listModels(): ModelInfo[] {
    return this.options.models ?? catalogFor(this.options.id);
  }

  info(model: string): ModelInfo {
    return this.listModels().find((m) => m.id === model) ?? unknownModel(model);
  }

  async generate(request: ModelRequest, context: GenerateContext = {}): Promise<ModelResponse> {
    if (context.offlineOnly) {
      throw new AgentOSError('policy_denied', `provider ${this.id} is remote and this execution is offline-only`);
    }
    const started = Date.now();
    const key = this.options.apiKey?.();
    const body: JsonObject = {
      model: request.model,
      messages: toOpenAIMessages(request.messages) as JsonValue,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.stopSequences ? { stop: request.stopSequences } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema as JsonValue },
            })),
            tool_choice: request.toolChoice ?? 'auto',
          }
        : {}),
      ...(request.responseFormat?.type === 'json_schema'
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'output', schema: request.responseFormat.schema as JsonValue, strict: true },
            },
          }
        : {}),
    };

    const payload = await httpJson<Record<string, unknown>>(`${this.options.baseUrl}/chat/completions`, {
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(this.options.extraHeaders ?? {}),
      },
      body,
      signal: context.signal,
      timeoutMs: this.options.timeoutMs,
      fetchImpl: this.options.fetchImpl,
    });

    const choice = (payload['choices'] as Array<Record<string, unknown>> | undefined)?.[0];
    const message = (choice?.['message'] ?? {}) as Record<string, unknown>;
    const rawToolCalls = (message['tool_calls'] as OpenAIToolCall[] | undefined) ?? [];
    const toolCalls: ToolCall[] = rawToolCalls.map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? 'unknown',
      arguments: parseArguments(c.function?.arguments, c.id ?? `call_${i}`),
    }));

    const usageRaw = (payload['usage'] ?? {}) as Record<string, number>;
    const content = typeof message['content'] === 'string' ? message['content'] : null;
    const usage = {
      inputTokens: usageRaw['prompt_tokens'] ?? estimateMessageTokens(request.messages),
      outputTokens: usageRaw['completion_tokens'] ?? estimateTokens(content ?? ''),
    };
    const finish = String(choice?.['finish_reason'] ?? 'stop');

    return {
      provider: this.id,
      model: request.model,
      content,
      toolCalls,
      finishReason: FINISH_MAP[finish] ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage,
      costMicroUsd: estimateCost(this.info(request.model), usage),
      latencyMs: Date.now() - started,
    };
  }
}

/** OpenAI itself. */
export function openAIProvider(apiKey: () => string | undefined, overrides: Partial<OpenAICompatibleOptions> = {}) {
  return new OpenAICompatibleProvider({
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey,
    ...overrides,
  });
}

/**
 * OpenRouter. Model ids are namespaced upstream (`anthropic/claude-sonnet-4.5`),
 * so the catalogue is left open and cost falls back to whatever is configured.
 */
export function openRouterProvider(
  apiKey: () => string | undefined,
  overrides: Partial<OpenAICompatibleOptions> = {},
) {
  return new OpenAICompatibleProvider({
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    extraHeaders: {
      'HTTP-Referer': process.env['AGENTOS_PUBLIC_URL'] ?? 'https://github.com/itsshreyasbhardwaj-design/agentos',
      'X-Title': 'AgentOS',
    },
    models: [],
    ...overrides,
  });
}

/** Any local OpenAI-compatible server (vLLM, LM Studio, llama.cpp, Jan). */
export function localOpenAIProvider(baseUrl: string, overrides: Partial<OpenAICompatibleOptions> = {}) {
  return new OpenAICompatibleProvider({ id: 'local', baseUrl, models: [], ...overrides });
}
