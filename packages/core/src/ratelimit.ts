export interface RateLimitSpec {
  /** Allowed operations per window. */
  limit: number;
  windowMs: number;
  /** Burst capacity; defaults to `limit`. */
  burst?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token-bucket limiter. Used at every level the spec calls for (user, org,
 * agent, tool, model, API) by varying the key.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly clock: { now(): number } = Date) {}

  check(key: string, spec: RateLimitSpec, cost = 1): RateLimitResult {
    const capacity = spec.burst ?? spec.limit;
    const now = this.clock.now();
    const refillPerMs = spec.limit / spec.windowMs;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);

    if (tokens < cost) {
      const deficit = cost - tokens;
      this.buckets.set(key, { tokens, updatedAt: now });
      return {
        allowed: false,
        remaining: Math.floor(tokens),
        retryAfterMs: Math.ceil(deficit / refillPerMs),
        limit: spec.limit,
      };
    }

    this.buckets.set(key, { tokens: tokens - cost, updatedAt: now });
    return { allowed: true, remaining: Math.floor(tokens - cost), retryAfterMs: 0, limit: spec.limit };
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  /** Drop buckets that have been full and idle, so the map cannot grow forever. */
  sweep(idleMs = 600_000): number {
    const cutoff = this.clock.now() - idleMs;
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}
