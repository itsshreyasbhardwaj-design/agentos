import type { JsonObject } from '@agentos/core';

export type JobStatus = 'ready' | 'delayed' | 'inflight' | 'completed' | 'dead';

export interface Job<T extends JsonObject = JsonObject> {
  id: string;
  orgId: string;
  type: string;
  payload: T;
  attempt: number;
  maxAttempts: number;
  /** Earliest time this job may be reserved. */
  runAt: number;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  /** Duplicate enqueues with the same key collapse into one job. */
  idempotencyKey: string | null;
  leaseExpiresAt: number | null;
  workerId: string | null;
  lastError: string | null;
  /** Higher runs first among jobs that are ready at the same moment. */
  priority: number;
}

export interface EnqueueRequest<T extends JsonObject = JsonObject> {
  orgId: string;
  type: string;
  payload: T;
  runAt?: number;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  priority?: number;
}

export interface ReserveRequest {
  workerId: string;
  leaseMs: number;
  /** Only reserve these job types. Omitted means any. */
  types?: string[];
  max?: number;
}

export interface QueueStats {
  ready: number;
  delayed: number;
  inflight: number;
  dead: number;
}

export interface Queue {
  readonly kind: string;
  /** Returns the existing job when the idempotency key was already used. */
  enqueue<T extends JsonObject>(request: EnqueueRequest<T>): Promise<Job<T>>;
  reserve(request: ReserveRequest): Promise<Job[]>;
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean>;
  /** Mark done. Only the lease holder may ack. */
  ack(jobId: string, workerId: string): Promise<boolean>;
  /** Return to the queue with a delay, or move to dead-letter when exhausted. */
  nack(jobId: string, workerId: string, options?: { delayMs?: number; error?: string; retry?: boolean }): Promise<Job | null>;
  /** Re-queue jobs whose worker stopped heartbeating. Returns how many. */
  reclaimExpired(now?: number): Promise<number>;
  get(jobId: string): Promise<Job | null>;
  stats(): Promise<QueueStats>;
  deadLetter(limit?: number): Promise<Job[]>;
  purge(): Promise<void>;
  close(): Promise<void>;
}
