import {
  backoffDelay,
  DEFAULT_RETRY,
  newId,
  systemClock,
  type Clock,
  type JsonObject,
  type RetryPolicy,
} from '@agentos/core';
import type { EnqueueRequest, Job, Queue, QueueStats, ReserveRequest } from './types.js';

export interface InMemoryQueueOptions {
  clock?: Clock;
  retry?: RetryPolicy;
  defaultMaxAttempts?: number;
}

/**
 * Single-process queue with the same lease/ack/nack semantics as the Redis
 * implementation, so the worker code path is identical in both. Reservation is
 * synchronous within the event loop, which makes it atomic here by construction.
 */
export class InMemoryQueue implements Queue {
  readonly kind = 'memory';
  private readonly jobs = new Map<string, Job>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly clock: Clock;
  private readonly retry: RetryPolicy;
  private readonly defaultMaxAttempts: number;

  constructor(options: InMemoryQueueOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
  }

  async enqueue<T extends JsonObject>(request: EnqueueRequest<T>): Promise<Job<T>> {
    const now = this.clock.now();
    if (request.idempotencyKey) {
      const key = `${request.orgId}:${request.type}:${request.idempotencyKey}`;
      const existingId = this.byIdempotency.get(key);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing) return existing as Job<T>;
    }
    const runAt = request.runAt ?? now;
    const job: Job<T> = {
      id: newId('job'),
      orgId: request.orgId,
      type: request.type,
      payload: request.payload,
      attempt: 0,
      maxAttempts: request.maxAttempts ?? this.defaultMaxAttempts,
      runAt,
      createdAt: now,
      updatedAt: now,
      status: runAt > now ? 'delayed' : 'ready',
      idempotencyKey: request.idempotencyKey ?? null,
      leaseExpiresAt: null,
      workerId: null,
      lastError: null,
      priority: request.priority ?? 0,
    };
    this.jobs.set(job.id, job as Job);
    if (request.idempotencyKey) {
      this.byIdempotency.set(`${request.orgId}:${request.type}:${request.idempotencyKey}`, job.id);
    }
    return job;
  }

  async reserve(request: ReserveRequest): Promise<Job[]> {
    const now = this.clock.now();
    const max = request.max ?? 1;
    const candidates = [...this.jobs.values()]
      .filter((job) => {
        if (job.status !== 'ready' && job.status !== 'delayed') return false;
        if (job.runAt > now) return false;
        if (request.types && !request.types.includes(job.type)) return false;
        return true;
      })
      .sort((a, b) => b.priority - a.priority || a.runAt - b.runAt || (a.id < b.id ? -1 : 1))
      .slice(0, max);

    return candidates.map((job) => {
      const reserved: Job = {
        ...job,
        status: 'inflight',
        attempt: job.attempt + 1,
        workerId: request.workerId,
        leaseExpiresAt: now + request.leaseMs,
        updatedAt: now,
      };
      this.jobs.set(job.id, reserved);
      return reserved;
    });
  }

  async heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId || job.status !== 'inflight') return false;
    this.jobs.set(jobId, { ...job, leaseExpiresAt: this.clock.now() + leaseMs, updatedAt: this.clock.now() });
    return true;
  }

  async ack(jobId: string, workerId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    // A worker that lost its lease must not be able to ack someone else's work.
    if (!job || job.workerId !== workerId || job.status !== 'inflight') return false;
    this.jobs.set(jobId, { ...job, status: 'completed', workerId: null, leaseExpiresAt: null, updatedAt: this.clock.now() });
    return true;
  }

  async nack(
    jobId: string,
    workerId: string,
    options: { delayMs?: number; error?: string; retry?: boolean } = {},
  ): Promise<Job | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId || job.status !== 'inflight') return null;
    const now = this.clock.now();
    const retry = options.retry !== false && job.attempt < job.maxAttempts;
    const updated: Job = retry
      ? {
          ...job,
          status: 'delayed',
          runAt: now + (options.delayMs ?? backoffDelay(this.retry, job.attempt)),
          workerId: null,
          leaseExpiresAt: null,
          lastError: options.error ?? null,
          updatedAt: now,
        }
      : {
          ...job,
          status: 'dead',
          workerId: null,
          leaseExpiresAt: null,
          lastError: options.error ?? null,
          updatedAt: now,
        };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async reclaimExpired(now = this.clock.now()): Promise<number> {
    let reclaimed = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== 'inflight') continue;
      if (job.leaseExpiresAt !== null && job.leaseExpiresAt > now) continue;
      const exhausted = job.attempt >= job.maxAttempts;
      this.jobs.set(job.id, {
        ...job,
        status: exhausted ? 'dead' : 'ready',
        workerId: null,
        leaseExpiresAt: null,
        lastError: 'worker lease expired',
        updatedAt: now,
      });
      reclaimed += 1;
    }
    return reclaimed;
  }

  async get(jobId: string): Promise<Job | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async stats(): Promise<QueueStats> {
    const now = this.clock.now();
    const stats: QueueStats = { ready: 0, delayed: 0, inflight: 0, dead: 0 };
    for (const job of this.jobs.values()) {
      if (job.status === 'completed') continue;
      if (job.status === 'inflight') stats.inflight += 1;
      else if (job.status === 'dead') stats.dead += 1;
      else if (job.runAt > now) stats.delayed += 1;
      else stats.ready += 1;
    }
    return stats;
  }

  async deadLetter(limit = 50): Promise<Job[]> {
    return [...this.jobs.values()].filter((j) => j.status === 'dead').slice(0, limit);
  }

  async purge(): Promise<void> {
    this.jobs.clear();
    this.byIdempotency.clear();
  }

  async close(): Promise<void> {}
}
