import {
  AgentOSError,
  CircuitBreaker,
  DEFAULT_CIRCUIT,
  DEFAULT_RETRY,
  backoffDelay,
  systemClock,
  type Clock,
  type CircuitBreakerOptions,
  type MicroUsd,
  type ModelSelector,
  type RetryPolicy,
  type TaskClass,
} from '@agentos/core';
import type { ProviderRegistry } from './registry.js';
import { estimateMessageTokens, type GenerateContext, type ModelRequest, type ModelResponse } from './types.js';

export interface RouterHooks {
  onCallStart?(info: { provider: string; model: string; attempt: number }): void | Promise<void>;
  onCallSuccess?(info: { provider: string; model: string; response: ModelResponse; attempt: number }): void | Promise<void>;
  onCallFailure?(info: {
    provider: string;
    model: string;
    error: AgentOSError;
    attempt: number;
    willRetry: boolean;
  }): void | Promise<void>;
  onRetry?(info: { provider: string; model: string; attempt: number; delayMs: number; code: string }): void | Promise<void>;
  onFallback?(info: { from: string; to: string; reason: string }): void | Promise<void>;
  onCircuitOpen?(info: { provider: string; model: string }): void | Promise<void>;
}

export interface ModelRouterOptions {
  registry: ProviderRegistry;
  retry?: RetryPolicy;
  timeoutMs?: number;
  circuit?: CircuitBreakerOptions;
  clock?: Clock;
  hooks?: RouterHooks;
  random?: () => number;
}

export interface RouteContext extends GenerateContext {
  taskClass?: TaskClass;
  /** Remaining budget. The router refuses a call it projects will exceed it. */
  budgetMicroUsd?: MicroUsd;
}

export interface RoutedResponse extends ModelResponse {
  /** Number of provider attempts made, including retries and fallbacks. */
  attempts: number;
  /** Set when the answer came from a fallback rather than the primary model. */
  fellBackFrom: string | null;
}

/**
 * Chooses a model, then keeps the call alive across transient failure.
 *
 * Order of operations per candidate: circuit check → cost projection → timed
 * call → retry on retryable errors only. When a candidate is exhausted the next
 * fallback is tried. Non-retryable errors (bad request, policy) fail fast
 * instead of burning the whole chain.
 */
export class ModelRouter {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly clock: Clock;

  constructor(private readonly options: ModelRouterOptions) {
    this.clock = options.clock ?? systemClock;
  }

  private breakerFor(qualified: string): CircuitBreaker {
    let breaker = this.breakers.get(qualified);
    if (!breaker) {
      breaker = new CircuitBreaker(this.options.circuit ?? DEFAULT_CIRCUIT, { now: () => this.clock.now() });
      this.breakers.set(qualified, breaker);
    }
    return breaker;
  }

  circuitStatus(qualified: string): string {
    return this.breakerFor(qualified).status;
  }

  health(): Array<{ model: string; circuit: string }> {
    return [...this.breakers.entries()].map(([model, breaker]) => ({ model, circuit: breaker.status }));
  }

  /** The ordered candidate chain for a selector and task class. */
  candidates(selector: ModelSelector, taskClass: TaskClass = 'default'): string[] {
    const head = selector.routes?.[taskClass] ?? selector.primary;
    const chain = [head, ...(selector.fallbacks ?? [])];
    if (head !== selector.primary) chain.splice(1, 0, selector.primary);
    return [...new Set(chain)];
  }

  /** Conservative pre-flight cost estimate: full input plus max output. */
  projectCost(qualified: string, request: Omit<ModelRequest, 'model'>, maxOutputTokens?: number): MicroUsd {
    const resolved = this.options.registry.resolve(qualified);
    const info = resolved.info;
    if (!info) return 0;
    const inputTokens = estimateMessageTokens(request.messages);
    const outputTokens = maxOutputTokens ?? Math.min(info.maxOutputTokens, 1_024);
    return Math.round(
      (inputTokens * info.inputPricePerMTokens) / 1_000_000 + (outputTokens * info.outputPricePerMTokens) / 1_000_000,
    );
  }

  async generate(
    selector: ModelSelector,
    request: Omit<ModelRequest, 'model'>,
    context: RouteContext = {},
  ): Promise<RoutedResponse> {
    const retry = this.options.retry ?? DEFAULT_RETRY;
    const chain = this.candidates(selector, context.taskClass);
    if (chain.length === 0) throw new AgentOSError('invalid_request', 'model selector has no candidates');

    let attempts = 0;
    let lastError: AgentOSError | null = null;
    const primary = chain[0] as string;

    for (const qualified of chain) {
      const resolved = this.options.registry.resolve(qualified);
      const breaker = this.breakerFor(qualified);

      if (!breaker.canAttempt()) {
        lastError = new AgentOSError('provider_unavailable', `circuit open for ${qualified}`);
        await this.options.hooks?.onCircuitOpen?.({ provider: resolved.provider.id, model: resolved.model });
        await this.options.hooks?.onFallback?.({ from: qualified, to: 'next candidate', reason: 'circuit_open' });
        continue;
      }

      if (context.offlineOnly && resolved.provider.remote) {
        lastError = new AgentOSError('policy_denied', `${qualified} is a remote provider and this run is offline-only`);
        continue;
      }

      if (context.budgetMicroUsd !== undefined) {
        const projected = this.projectCost(qualified, request, selector.maxOutputTokens);
        if (projected > context.budgetMicroUsd) {
          throw new AgentOSError(
            'limit_exceeded',
            `projected model cost ${projected}µ$ exceeds remaining budget ${context.budgetMicroUsd}µ$`,
            { details: { model: qualified, projected, budget: context.budgetMicroUsd }, retryable: false },
          );
        }
      }

      for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        attempts += 1;
        await this.options.hooks?.onCallStart?.({ provider: resolved.provider.id, model: resolved.model, attempt });
        try {
          const response = await this.callWithTimeout(resolved.provider, resolved.model, request, selector, context);
          breaker.recordSuccess();
          await this.options.hooks?.onCallSuccess?.({
            provider: resolved.provider.id,
            model: resolved.model,
            response,
            attempt,
          });
          return { ...response, attempts, fellBackFrom: qualified === primary ? null : primary };
        } catch (error) {
          const agentError = AgentOSError.from(error, 'provider_error');
          lastError = agentError;
          const canRetry = agentError.retryable && attempt < retry.maxAttempts;
          await this.options.hooks?.onCallFailure?.({
            provider: resolved.provider.id,
            model: resolved.model,
            error: agentError,
            attempt,
            willRetry: canRetry,
          });
          if (agentError.retryable) breaker.recordFailure();

          if (!agentError.retryable) {
            // A malformed request will fail identically everywhere: stop now.
            throw agentError;
          }
          if (!canRetry) break;

          const delayMs = backoffDelay(retry, attempt, this.options.random);
          await this.options.hooks?.onRetry?.({
            provider: resolved.provider.id,
            model: resolved.model,
            attempt,
            delayMs,
            code: agentError.code,
          });
          await this.clock.sleep(delayMs, context.signal);
        }
      }

      const next = chain[chain.indexOf(qualified) + 1];
      if (next) {
        await this.options.hooks?.onFallback?.({
          from: qualified,
          to: next,
          reason: lastError?.code ?? 'exhausted',
        });
      }
    }

    throw (
      lastError ??
      new AgentOSError('provider_unavailable', `all model candidates failed: ${chain.join(', ')}`)
    );
  }

  private async callWithTimeout(
    provider: { generate(req: ModelRequest, ctx?: GenerateContext): Promise<ModelResponse> },
    model: string,
    request: Omit<ModelRequest, 'model'>,
    selector: ModelSelector,
    context: RouteContext,
  ): Promise<ModelResponse> {
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const full: ModelRequest = {
        ...request,
        model,
        ...(selector.temperature !== undefined && request.temperature === undefined
          ? { temperature: selector.temperature }
          : {}),
        ...(selector.maxOutputTokens !== undefined && request.maxOutputTokens === undefined
          ? { maxOutputTokens: selector.maxOutputTokens }
          : {}),
      };
      const call = provider.generate(full, { ...context, signal: controller.signal });
      const timeout = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new AgentOSError('timeout', `model call to ${model} timed out after ${timeoutMs}ms`)),
          { once: true },
        );
      });
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }
}
