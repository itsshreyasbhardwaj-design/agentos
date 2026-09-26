import type { JsonSchema, JsonValue, Logger, Message, MicroUsd, TokenUsage, ToolCall } from '@agentos/core';

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type ToolChoice = 'auto' | 'none' | 'required';

export interface ModelRequest {
  /** Model id as the provider knows it, without the `provider:` prefix. */
  model: string;
  messages: Message[];
  tools?: ModelToolSpec[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseFormat?: { type: 'text' } | { type: 'json_schema'; schema: JsonSchema };
  /** Opaque tags forwarded to providers that support them. Never secrets. */
  metadata?: Record<string, string>;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';

export interface ModelResponse {
  provider: string;
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: TokenUsage;
  costMicroUsd: MicroUsd;
  latencyMs: number;
  /** Provider-specific extras, already redacted. Useful for debugging only. */
  raw?: JsonValue;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsJsonSchema: boolean;
  /** Price in micro-USD per 1M tokens. */
  inputPricePerMTokens: MicroUsd;
  outputPricePerMTokens: MicroUsd;
}

export interface GenerateContext {
  signal?: AbortSignal;
  logger?: Logger;
  /** Set for executions that must not reach a paid API. */
  offlineOnly?: boolean;
}

export interface ModelProvider {
  readonly id: string;
  /** True when this provider can serve the given bare model id. */
  supports(model: string): boolean;
  listModels(): ModelInfo[];
  info(model: string): ModelInfo | null;
  generate(request: ModelRequest, context?: GenerateContext): Promise<ModelResponse>;
  /** Cheap liveness probe used by the router's health tracking. */
  healthCheck?(): Promise<boolean>;
  /** True when calls leave the machine (and therefore may cost money). */
  readonly remote: boolean;
}

export function estimateCost(info: ModelInfo | null, usage: TokenUsage): MicroUsd {
  if (!info) return 0;
  const input = (usage.inputTokens * info.inputPricePerMTokens) / 1_000_000;
  const output = (usage.outputTokens * info.outputPricePerMTokens) / 1_000_000;
  return Math.round(input + output);
}

/**
 * Rough token estimate used when a provider does not report usage, and for
 * pre-flight cost projection. Deliberately conservative (over-counts slightly).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // role/framing overhead
    if (m.role === 'assistant') {
      total += estimateTokens(m.content ?? '');
      for (const call of m.toolCalls ?? []) {
        total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments));
      }
    } else {
      total += estimateTokens(m.content);
    }
  }
  return total;
}

/** `provider:model` → parts. A bare id resolves against the default provider. */
export function parseModelId(qualified: string): { provider: string | null; model: string } {
  const idx = qualified.indexOf(':');
  if (idx === -1) return { provider: null, model: qualified };
  return { provider: qualified.slice(0, idx), model: qualified.slice(idx + 1) };
}

export function qualifyModelId(provider: string, model: string): string {
  return `${provider}:${model}`;
}
