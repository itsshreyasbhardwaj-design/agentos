import { AgentOSError, isJsonObject, type JsonObject, type JsonValue, type Message, type ToolCall } from '@agentos/core';
import { LOCAL_MODELS, unknownModel } from './catalog.js';
import { httpJson } from './http.js';
import {
  estimateMessageTokens,
  estimateTokens,
  type GenerateContext,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from './types.js';

export interface OllamaOptions {
  baseUrl?: string;
  models?: ModelInfo[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  id?: string;
}

/**
 * Local Ollama adapter. Marked `remote: false` because nothing leaves the host,
 * which lets offline-only executions use a real model instead of a script.
 */
export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly remote = false;
  private readonly baseUrl: string;

  constructor(private readonly options: OllamaOptions = {}) {
    this.id = options.id ?? 'ollama';
    this.baseUrl = options.baseUrl ?? process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';
  }

  supports(_model: string): boolean {
    return true;
  }

  listModels(): ModelInfo[] {
    return this.options.models ?? LOCAL_MODELS;
  }

  info(model: string): ModelInfo {
    return this.listModels().find((m) => m.id === model) ?? { ...unknownModel(model), inputPricePerMTokens: 0, outputPricePerMTokens: 0 };
  }

  async generate(request: ModelRequest, context: GenerateContext = {}): Promise<ModelResponse> {
    const started = Date.now();
    const messages = request.messages.map((m) => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.content ?? '',
          ...(m.toolCalls && m.toolCalls.length > 0
            ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }
            : {}),
        };
      }
      if (m.role === 'tool') return { role: 'tool', content: m.content };
      return { role: m.role, content: m.content };
    });

    const body: JsonObject = {
      model: request.model,
      messages: messages as unknown as JsonValue,
      stream: false,
      options: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { num_predict: request.maxOutputTokens } : {}),
      },
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema as JsonValue },
            })),
          }
        : {}),
    };

    const payload = await httpJson<Record<string, unknown>>(`${this.baseUrl}/api/chat`, {
      body,
      signal: context.signal,
      timeoutMs: this.options.timeoutMs ?? 120_000,
      fetchImpl: this.options.fetchImpl,
    });

    const message = (payload['message'] ?? {}) as Record<string, unknown>;
    const raw = (message['tool_calls'] as Array<{ function?: { name?: string; arguments?: unknown } }>) ?? [];
    const toolCalls: ToolCall[] = raw.map((c, i) => ({
      id: `call_${i}`,
      name: c.function?.name ?? 'unknown',
      arguments: isJsonObject(c.function?.arguments) ? c.function.arguments : {},
    }));
    const content = typeof message['content'] === 'string' && message['content'] ? message['content'] : null;

    return {
      provider: this.id,
      model: request.model,
      content,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: Number(payload['prompt_eval_count'] ?? estimateMessageTokens(request.messages)),
        outputTokens: Number(payload['eval_count'] ?? estimateTokens(content ?? '')),
      },
      costMicroUsd: 0,
      latencyMs: Date.now() - started,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await httpJson(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        timeoutMs: 2_000,
        fetchImpl: this.options.fetchImpl,
      });
      return true;
    } catch (error) {
      if (AgentOSError.is(error)) return false;
      return false;
    }
  }
}
