import { AgentOSError, type JsonObject, type Message } from '@agentos/core';
import { unknownModel } from './catalog.js';
import {
  estimateMessageTokens,
  estimateTokens,
  type FinishReason,
  type GenerateContext,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from './types.js';

export interface ScriptedTurn {
  content?: string | null;
  toolCalls?: Array<{ name: string; arguments: JsonObject }>;
  finishReason?: FinishReason;
  /** Simulated latency, so timeout and concurrency paths are exercisable. */
  latencyMs?: number;
  /** Throw instead of answering — used to test retry, fallback and circuits. */
  error?: { code: 'provider_error' | 'provider_unavailable' | 'timeout' | 'rate_limited'; message: string };
}

export interface ScriptContext {
  messages: Message[];
  /** Zero-based index of this call within the provider instance. */
  turn: number;
  request: ModelRequest;
}

export type ScriptFn = (context: ScriptContext) => ScriptedTurn;

export interface ScriptedProviderOptions {
  id?: string;
  /** Per-model scripts. A plain array is consumed one turn at a time. */
  scripts?: Record<string, ScriptedTurn[] | ScriptFn>;
  /** Used when no script is registered for the requested model. */
  fallback?: ScriptFn;
  models?: ModelInfo[];
  /** Price per 1M tokens, so cost-limit behaviour can be tested deterministically. */
  pricePerMTokens?: { input: number; output: number };
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A deterministic, fully local model provider.
 *
 * It is a real implementation of {@link ModelProvider} — the runtime executes it
 * through exactly the same path as a hosted model — but its answers come from a
 * script instead of an LLM. That is what makes the test suite, the benchmarks and
 * the demo agents runnable with no network access and no API spend. Anything it
 * produces is labelled `scripted` in the trace so it can never be mistaken for a
 * real model response.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id: string;
  readonly remote = false;
  private readonly cursors = new Map<string, number>();
  private readonly scripts: Record<string, ScriptedTurn[] | ScriptFn>;
  private fallbackFn: ScriptFn | undefined;
  private readonly price: { input: number; output: number };
  private calls = 0;

  constructor(private readonly options: ScriptedProviderOptions = {}) {
    this.id = options.id ?? 'scripted';
    this.scripts = options.scripts ?? {};
    this.fallbackFn = options.fallback;
    this.price = options.pricePerMTokens ?? { input: 1_000_000, output: 3_000_000 };
  }

  get callCount(): number {
    return this.calls;
  }

  supports(model: string): boolean {
    if (model in this.scripts) return true;
    if (this.fallbackFn) return true;
    return (this.options.models ?? []).some((m) => m.id === model);
  }

  listModels(): ModelInfo[] {
    if (this.options.models) return this.options.models;
    return Object.keys(this.scripts).map((id) => this.info(id) as ModelInfo);
  }

  info(model: string): ModelInfo {
    const declared = (this.options.models ?? []).find((m) => m.id === model);
    if (declared) return declared;
    return {
      ...unknownModel(model),
      displayName: `${model} (scripted)`,
      inputPricePerMTokens: this.price.input,
      outputPricePerMTokens: this.price.output,
    };
  }

  reset(): void {
    this.cursors.clear();
    this.calls = 0;
  }

  /** Replace the fallback script. Lets a test drive several agents from one provider. */
  setFallback(fn: ScriptFn): void {
    this.fallbackFn = fn;
  }

  async generate(request: ModelRequest, context: GenerateContext = {}): Promise<ModelResponse> {
    const started = Date.now();
    this.calls += 1;
    const turnIndex = this.cursors.get(request.model) ?? 0;
    this.cursors.set(request.model, turnIndex + 1);

    const script = this.scripts[request.model] ?? this.fallbackFn;
    if (!script) {
      throw new AgentOSError('provider_error', `no script registered for model ${request.model}`, {
        details: { model: request.model },
      });
    }

    const turn: ScriptedTurn =
      typeof script === 'function'
        ? script({ messages: request.messages, turn: turnIndex, request })
        : (script[turnIndex] ?? script[script.length - 1] ?? { content: '' });

    if (turn.latencyMs && turn.latencyMs > 0) {
      const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await sleep(turn.latencyMs);
    }

    if (context.signal?.aborted) {
      throw new AgentOSError('timeout', 'scripted call aborted');
    }

    if (turn.error) {
      throw new AgentOSError(turn.error.code, turn.error.message, { details: { provider: this.id } });
    }

    const toolCalls = (turn.toolCalls ?? []).map((call, i) => ({
      // Deterministic within a run: same script, same ids, so replays line up.
      id: `call_${turnIndex}_${i}`,
      name: call.name,
      arguments: call.arguments,
    }));

    const inputTokens = estimateMessageTokens(request.messages);
    const outputTokens =
      estimateTokens(turn.content ?? '') +
      toolCalls.reduce((sum, c) => sum + estimateTokens(JSON.stringify(c.arguments)) + 4, 0);
    const info = this.info(request.model);

    return {
      provider: this.id,
      model: request.model,
      content: turn.content ?? null,
      toolCalls,
      finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage: { inputTokens, outputTokens },
      costMicroUsd: Math.round(
        (inputTokens * info.inputPricePerMTokens) / 1_000_000 +
          (outputTokens * info.outputPricePerMTokens) / 1_000_000,
      ),
      latencyMs: Date.now() - started,
      raw: { scripted: true, turn: turnIndex },
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/** Convenience: a provider that always replies with the same text and stops. */
export function echoProvider(id = 'scripted'): ScriptedProvider {
  return new ScriptedProvider({
    id,
    fallback: ({ messages }) => {
      const last = [...messages].reverse().find((m) => m.role === 'user');
      return { content: last && last.role === 'user' ? last.content : '', finishReason: 'stop' };
    },
  });
}
