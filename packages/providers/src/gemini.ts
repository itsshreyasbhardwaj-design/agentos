import { AgentOSError, isJsonObject, type JsonObject, type JsonValue, type Message, type ToolCall } from '@agentos/core';
import { GEMINI_MODELS, unknownModel } from './catalog.js';
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

export interface GeminiOptions {
  apiKey: () => string | undefined;
  baseUrl?: string;
  models?: ModelInfo[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  id?: string;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
}

const FINISH_MAP: Record<string, FinishReason> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
};

/** Google Gemini `generateContent` adapter. */
export class GeminiProvider implements ModelProvider {
  readonly id: string;
  readonly remote = true;

  constructor(private readonly options: GeminiOptions) {
    this.id = options.id ?? 'gemini';
  }

  supports(model: string): boolean {
    return model.startsWith('gemini') || this.listModels().some((m) => m.id === model);
  }

  listModels(): ModelInfo[] {
    return this.options.models ?? GEMINI_MODELS;
  }

  info(model: string): ModelInfo {
    return this.listModels().find((m) => m.id === model) ?? unknownModel(model);
  }

  private translate(messages: Message[]): { system: string; contents: JsonValue } {
    const system: string[] = [];
    const contents: JsonObject[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system.push(m.content);
      } else if (m.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: m.content }] });
      } else if (m.role === 'assistant') {
        const parts: JsonObject[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const call of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: call.name, args: call.arguments } });
        }
        contents.push({ role: 'model', parts: parts as unknown as JsonValue });
      } else {
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: m.name, response: { content: m.content } } }] as unknown as JsonValue,
        });
      }
    }
    return { system: system.join('\n\n'), contents: contents as unknown as JsonValue };
  }

  async generate(request: ModelRequest, context: GenerateContext = {}): Promise<ModelResponse> {
    if (context.offlineOnly) {
      throw new AgentOSError('policy_denied', 'gemini provider is remote and this execution is offline-only');
    }
    const started = Date.now();
    const key = this.options.apiKey();
    if (!key) throw new AgentOSError('secret_missing', 'gemini api key is not configured');

    const { system, contents } = this.translate(request.messages);
    const body: JsonObject = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.stopSequences ? { stopSequences: request.stopSequences } : {}),
      },
      ...(request.tools && request.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema as JsonValue,
                })),
              },
            ],
          }
        : {}),
    };

    const base = this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const payload = await httpJson<Record<string, unknown>>(`${base}/models/${request.model}:generateContent`, {
      // The key goes in a header, never in the URL, so it cannot leak via logs.
      headers: { 'x-goog-api-key': key },
      body,
      signal: context.signal,
      timeoutMs: this.options.timeoutMs,
      fetchImpl: this.options.fetchImpl,
    });

    const candidate = (payload['candidates'] as Array<Record<string, unknown>> | undefined)?.[0];
    const parts = ((candidate?.['content'] as Record<string, unknown> | undefined)?.['parts'] as GeminiPart[]) ?? [];
    const text = parts.map((p) => p.text ?? '').join('');
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `call_${i}`,
        name: p.functionCall?.name ?? 'unknown',
        arguments: isJsonObject(p.functionCall?.args) ? p.functionCall.args : {},
      }));

    const meta = (payload['usageMetadata'] ?? {}) as Record<string, number>;
    const usage = {
      inputTokens: meta['promptTokenCount'] ?? estimateMessageTokens(request.messages),
      outputTokens: meta['candidatesTokenCount'] ?? estimateTokens(text),
    };

    return {
      provider: this.id,
      model: request.model,
      content: text || null,
      toolCalls,
      finishReason:
        FINISH_MAP[String(candidate?.['finishReason'] ?? 'STOP')] ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage,
      costMicroUsd: estimateCost(this.info(request.model), usage),
      latencyMs: Date.now() - started,
    };
  }
}

export function geminiProvider(apiKey: () => string | undefined, overrides: Partial<GeminiOptions> = {}) {
  return new GeminiProvider({ apiKey, ...overrides });
}
