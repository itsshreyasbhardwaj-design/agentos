import type { Clock } from './clock.js';
import { AgentOSError } from './errors.js';

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  /** Fraction of the delay randomised, to avoid synchronised retry storms. */
  jitter: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 10_000,
  multiplier: 2,
  jitter: 0.2,
};

export function backoffDelay(policy: RetryPolicy, attempt: number, random = Math.random): number {
  const raw = policy.initialDelayMs * policy.multiplier ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  const jitterRange = capped * policy.jitter;
  return Math.round(capped - jitterRange / 2 + random() * jitterRange);
}

export interface RetryContext {
  attempt: number;
  error: unknown;
}

export interface RetryOptions {
  policy?: RetryPolicy;
  clock?: Clock;
  signal?: AbortSignal;
  /**
   * Gate on retryability. Defaults to retrying only errors flagged retryable —
   * a non-idempotent operation must never be retried blindly.
   */
  shouldRetry?: (ctx: RetryContext) => boolean;
  onRetry?: (ctx: RetryContext & { delayMs: number }) => void;
  random?: () => number;
}

const defaultShouldRetry = ({ error }: RetryContext): boolean =>
  AgentOSError.is(error) ? error.retryable : false;

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= policy.maxAttempts || !shouldRetry({ attempt, error })) throw error;
      const delayMs = backoffDelay(policy, attempt, options.random);
      options.onRetry?.({ attempt, error, delayMs });
      if (options.clock) await options.clock.sleep(delayMs, options.signal);
    }
  }
  throw lastError;
}

/** Reject with a `timeout` error if the promise has not settled in time. */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label = 'operation',
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new AgentOSError('timeout', `${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            const reason = controller.signal.reason;
            reject(
              AgentOSError.is(reason)
                ? reason
                : new AgentOSError('timeout', `${label} timed out after ${timeoutMs}ms`),
            );
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  /** How long to stay open before letting a single probe through. */
  resetTimeoutMs: number;
  /** Consecutive successes in half-open needed to close again. */
  successThreshold: number;
}

export const DEFAULT_CIRCUIT: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  successThreshold: 2,
};

/**
 * Per-target circuit breaker. A provider that is down stops being retried until
 * the reset window elapses, which is what keeps one bad provider from consuming
 * the whole worker pool.
 */
export class CircuitBreaker {
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';

  constructor(
    private readonly options: CircuitBreakerOptions = DEFAULT_CIRCUIT,
    private readonly clock: { now(): number } = Date,
  ) {}

  get status(): CircuitState {
    return this.state;
  }

  canAttempt(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.clock.now() - this.openedAt >= this.options.resetTimeoutMs) {
        this.state = 'half_open';
        this.successes = 0;
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.successes += 1;
      if (this.successes >= this.options.successThreshold) this.reset();
      return;
    }
    this.failures = 0;
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.clock.now();
    this.successes = 0;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
  }
}
