import { describe, expect, it, vi } from 'vitest';
import { TestClock } from './clock.js';
import { AgentOSError } from './errors.js';
import { checkLimits, clampLimits, DEFAULT_LIMITS } from './limits.js';
import { TokenBucketLimiter } from './ratelimit.js';
import { backoffDelay, CircuitBreaker, DEFAULT_RETRY, withRetry, withTimeout } from './retry.js';
import { emptyUsage } from './usage.js';

describe('backoff', () => {
  it('grows exponentially and respects the cap', () => {
    const policy = { ...DEFAULT_RETRY, jitter: 0 };
    expect(backoffDelay(policy, 1)).toBe(200);
    expect(backoffDelay(policy, 2)).toBe(400);
    expect(backoffDelay(policy, 3)).toBe(800);
    expect(backoffDelay({ ...policy, maxDelayMs: 500 }, 5)).toBe(500);
  });
});

describe('withRetry', () => {
  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn(async () => {
      throw new AgentOSError('policy_denied', 'nope');
    });
    await expect(withRetry(fn)).rejects.toMatchObject({ code: 'policy_denied' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries retryable errors up to maxAttempts', async () => {
    const clock = new TestClock();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new AgentOSError('provider_unavailable', 'down');
        return 'ok';
      },
      { clock, policy: { ...DEFAULT_RETRY, initialDelayMs: 10, jitter: 0 } },
    );
    // Drain the scheduled sleeps.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      clock.advance(100);
    }
    await expect(promise).resolves.toBe('ok');
    expect(calls).toBe(3);
  });
});

describe('withTimeout', () => {
  it('rejects with a timeout error and aborts the inner signal', async () => {
    let aborted = false;
    await expect(
      withTimeout(
        (signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
            setTimeout(resolve, 1_000);
          }),
        20,
        'model call',
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(aborted).toBe(true);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and half-opens after the reset window', () => {
    const clock = new TestClock(0);
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1_000, successThreshold: 1 }, clock);
    expect(breaker.canAttempt()).toBe(true);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.status).toBe('open');
    expect(breaker.canAttempt()).toBe(false);
    clock.advance(1_000);
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.status).toBe('half_open');
    breaker.recordSuccess();
    expect(breaker.status).toBe('closed');
  });

  it('re-opens if the half-open probe fails', () => {
    const clock = new TestClock(0);
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, successThreshold: 2 }, clock);
    breaker.recordFailure();
    clock.advance(100);
    breaker.canAttempt();
    breaker.recordFailure();
    expect(breaker.status).toBe('open');
  });
});

describe('TokenBucketLimiter', () => {
  it('allows up to the limit and then refuses with a retry hint', () => {
    const clock = new TestClock(0);
    const limiter = new TokenBucketLimiter(clock);
    const spec = { limit: 3, windowMs: 1_000 };
    expect(limiter.check('k', spec).allowed).toBe(true);
    expect(limiter.check('k', spec).allowed).toBe(true);
    expect(limiter.check('k', spec).allowed).toBe(true);
    const denied = limiter.check('k', spec);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time and isolates keys', () => {
    const clock = new TestClock(0);
    const limiter = new TokenBucketLimiter(clock);
    const spec = { limit: 1, windowMs: 1_000 };
    expect(limiter.check('a', spec).allowed).toBe(true);
    expect(limiter.check('a', spec).allowed).toBe(false);
    expect(limiter.check('b', spec).allowed).toBe(true);
    clock.advance(1_000);
    expect(limiter.check('a', spec).allowed).toBe(true);
  });

  it('sweeps idle buckets', () => {
    const clock = new TestClock(0);
    const limiter = new TokenBucketLimiter(clock);
    limiter.check('a', { limit: 1, windowMs: 10 });
    clock.advance(700_000);
    expect(limiter.sweep()).toBe(1);
    expect(limiter.size).toBe(0);
  });
});

describe('limits', () => {
  it('detects the first breached limit', () => {
    const usage = { ...emptyUsage(), costMicroUsd: 600_000 };
    const breach = checkLimits(DEFAULT_LIMITS, usage, 0);
    expect(breach?.limit).toBe('maxCostMicroUsd');
  });

  it('supports projecting a call before it is made', () => {
    const usage = { ...emptyUsage(), toolCalls: DEFAULT_LIMITS.maxToolCalls };
    expect(checkLimits(DEFAULT_LIMITS, usage, 0)).toBeNull();
    expect(checkLimits(DEFAULT_LIMITS, usage, 0, { toolCalls: 1 })?.limit).toBe('maxToolCalls');
  });

  it('lets an org ceiling tighten but never loosen a limit', () => {
    const clamped = clampLimits({ ...DEFAULT_LIMITS, maxCostMicroUsd: 10_000_000 }, { maxCostMicroUsd: 100_000 });
    expect(clamped.maxCostMicroUsd).toBe(100_000);
    const unchanged = clampLimits({ ...DEFAULT_LIMITS, maxCostMicroUsd: 1_000 }, { maxCostMicroUsd: 100_000 });
    expect(unchanged.maxCostMicroUsd).toBe(1_000);
  });
});
