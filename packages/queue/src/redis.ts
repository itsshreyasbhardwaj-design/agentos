import {
  AgentOSError,
  backoffDelay,
  DEFAULT_RETRY,
  newId,
  systemClock,
  type Clock,
  type JsonObject,
  type RetryPolicy,
} from '@agentos/core';
import type { EnqueueRequest, Job, Queue, QueueStats, ReserveRequest } from './types.js';

/** The slice of an ioredis client this adapter uses. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number, flag?: string): Promise<unknown>;
  zcount(key: string, min: string | number, max: string | number): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<unknown>;
}

export interface RedisQueueOptions {
  client: RedisLike;
  /** Key namespace, so several deployments can share one Redis. */
  namespace?: string;
  clock?: Clock;
  retry?: RetryPolicy;
  defaultMaxAttempts?: number;
  /** How long an idempotency key is remembered. */
  idempotencyTtlMs?: number;
  ownsClient?: boolean;
}

/**
 * Reserve N due jobs and put them in flight.
 *
 * Runs as one Lua script so the pop-from-ready and push-to-inflight pair is
 * atomic: two workers polling at the same instant cannot both take a job.
 */
const RESERVE_SCRIPT = `
local readyKey, inflightKey, jobPrefix = KEYS[1], KEYS[2], KEYS[3]
local now, leaseMs, maxJobs, workerId = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
local typeFilter = ARGV[5]
local ids = redis.call('ZRANGEBYSCORE', readyKey, '-inf', now, 'LIMIT', 0, maxJobs * 4)
local out = {}
for i = 1, #ids do
  if #out >= maxJobs then break end
  local id = ids[i]
  local raw = redis.call('GET', jobPrefix .. id)
  if raw then
    local job = cjson.decode(raw)
    if typeFilter == '' or string.find(typeFilter, '|' .. job.type .. '|', 1, true) then
      redis.call('ZREM', readyKey, id)
      job.status = 'inflight'
      job.attempt = job.attempt + 1
      job.workerId = workerId
      job.leaseExpiresAt = now + leaseMs
      job.updatedAt = now
      local encoded = cjson.encode(job)
      redis.call('SET', jobPrefix .. id, encoded)
      redis.call('ZADD', inflightKey, job.leaseExpiresAt, id)
      out[#out + 1] = encoded
    end
  else
    redis.call('ZREM', readyKey, id)
  end
end
return out
`;

/** Ack, nack and heartbeat all verify lease ownership before mutating. */
const ACK_SCRIPT = `
local inflightKey, jobPrefix = KEYS[1], KEYS[2]
local id, workerId, now = ARGV[1], ARGV[2], tonumber(ARGV[3])
local raw = redis.call('GET', jobPrefix .. id)
if not raw then return 0 end
local job = cjson.decode(raw)
if job.workerId ~= workerId or job.status ~= 'inflight' then return 0 end
job.status = 'completed'
job.workerId = cjson.null
job.leaseExpiresAt = cjson.null
job.updatedAt = now
redis.call('SET', jobPrefix .. id, cjson.encode(job), 'PX', 86400000)
redis.call('ZREM', inflightKey, id)
return 1
`;

const NACK_SCRIPT = `
local inflightKey, readyKey, deadKey, jobPrefix = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local id, workerId, now, delayMs, errMsg, forceDead = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5], ARGV[6]
local raw = redis.call('GET', jobPrefix .. id)
if not raw then return nil end
local job = cjson.decode(raw)
if job.workerId ~= workerId or job.status ~= 'inflight' then return nil end
job.workerId = cjson.null
job.leaseExpiresAt = cjson.null
job.lastError = errMsg
job.updatedAt = now
redis.call('ZREM', inflightKey, id)
if forceDead == '1' or job.attempt >= job.maxAttempts then
  job.status = 'dead'
  redis.call('ZADD', deadKey, now, id)
else
  job.status = 'delayed'
  job.runAt = now + delayMs
  redis.call('ZADD', readyKey, job.runAt, id)
end
redis.call('SET', jobPrefix .. id, cjson.encode(job))
return cjson.encode(job)
`;

const HEARTBEAT_SCRIPT = `
local inflightKey, jobPrefix = KEYS[1], KEYS[2]
local id, workerId, expiresAt = ARGV[1], ARGV[2], tonumber(ARGV[3])
local raw = redis.call('GET', jobPrefix .. id)
if not raw then return 0 end
local job = cjson.decode(raw)
if job.workerId ~= workerId or job.status ~= 'inflight' then return 0 end
job.leaseExpiresAt = expiresAt
redis.call('SET', jobPrefix .. id, cjson.encode(job))
redis.call('ZADD', inflightKey, expiresAt, id)
return 1
`;

/** Move jobs whose worker stopped heartbeating back to ready (or to dead). */
const RECLAIM_SCRIPT = `
local inflightKey, readyKey, deadKey, jobPrefix = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local now = tonumber(ARGV[1])
local ids = redis.call('ZRANGEBYSCORE', inflightKey, '-inf', now)
local count = 0
for i = 1, #ids do
  local id = ids[i]
  local raw = redis.call('GET', jobPrefix .. id)
  redis.call('ZREM', inflightKey, id)
  if raw then
    local job = cjson.decode(raw)
    job.workerId = cjson.null
    job.leaseExpiresAt = cjson.null
    job.lastError = 'worker lease expired'
    job.updatedAt = now
    if job.attempt >= job.maxAttempts then
      job.status = 'dead'
      redis.call('ZADD', deadKey, now, id)
    else
      job.status = 'ready'
      job.runAt = now
      redis.call('ZADD', readyKey, now, id)
    end
    redis.call('SET', jobPrefix .. id, cjson.encode(job))
    count = count + 1
  end
end
return count
`;

const ENQUEUE_SCRIPT = `
local readyKey, jobPrefix, idemKey = KEYS[1], KEYS[2], KEYS[3]
local encoded, id, runAt, idemTtl = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
if idemKey ~= '' then
  local existing = redis.call('GET', idemKey)
  if existing then
    local raw = redis.call('GET', jobPrefix .. existing)
    if raw then return raw end
  end
end
redis.call('SET', jobPrefix .. id, encoded)
redis.call('ZADD', readyKey, runAt, id)
if idemKey ~= '' then redis.call('SET', idemKey, id, 'PX', idemTtl) end
return encoded
`;

/**
 * Redis-backed queue for multi-worker deployments.
 *
 * NOTE: this adapter is exercised by `tests/integration/redis-queue.test.ts`,
 * which requires a reachable Redis (`REDIS_URL`) and skips when there is none.
 * The in-memory queue is the default and is covered by the unit suite.
 */
export class RedisQueue implements Queue {
  readonly kind = 'redis';
  private readonly ns: string;
  private readonly clock: Clock;
  private readonly retry: RetryPolicy;
  private readonly defaultMaxAttempts: number;
  private readonly idempotencyTtlMs: number;

  constructor(private readonly options: RedisQueueOptions) {
    this.ns = options.namespace ?? 'agentos';
    this.clock = options.clock ?? systemClock;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
  }

  private get readyKey() {
    return `${this.ns}:ready`;
  }
  private get inflightKey() {
    return `${this.ns}:inflight`;
  }
  private get deadKey() {
    return `${this.ns}:dead`;
  }
  private get jobPrefix() {
    return `${this.ns}:job:`;
  }

  async enqueue<T extends JsonObject>(request: EnqueueRequest<T>): Promise<Job<T>> {
    const now = this.clock.now();
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
    const idemKey = request.idempotencyKey
      ? `${this.ns}:idem:${request.orgId}:${request.type}:${request.idempotencyKey}`
      : '';
    // Priority folds into the score so higher-priority jobs sort earlier.
    const score = runAt - (request.priority ?? 0) * 1_000;
    const raw = await this.options.client.eval(
      ENQUEUE_SCRIPT,
      3,
      this.readyKey,
      this.jobPrefix,
      idemKey,
      JSON.stringify(job),
      job.id,
      score,
      this.idempotencyTtlMs,
    );
    return JSON.parse(String(raw)) as Job<T>;
  }

  async reserve(request: ReserveRequest): Promise<Job[]> {
    const filter = request.types && request.types.length > 0 ? `|${request.types.join('|')}|` : '';
    const raw = (await this.options.client.eval(
      RESERVE_SCRIPT,
      3,
      this.readyKey,
      this.inflightKey,
      this.jobPrefix,
      this.clock.now(),
      request.leaseMs,
      request.max ?? 1,
      request.workerId,
      filter,
    )) as string[];
    return (raw ?? []).map((entry) => JSON.parse(entry) as Job);
  }

  async heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.options.client.eval(
      HEARTBEAT_SCRIPT,
      2,
      this.inflightKey,
      this.jobPrefix,
      jobId,
      workerId,
      this.clock.now() + leaseMs,
    );
    return Number(result) === 1;
  }

  async ack(jobId: string, workerId: string): Promise<boolean> {
    const result = await this.options.client.eval(
      ACK_SCRIPT,
      2,
      this.inflightKey,
      this.jobPrefix,
      jobId,
      workerId,
      this.clock.now(),
    );
    return Number(result) === 1;
  }

  async nack(
    jobId: string,
    workerId: string,
    options: { delayMs?: number; error?: string; retry?: boolean } = {},
  ): Promise<Job | null> {
    const job = await this.get(jobId);
    const delayMs = options.delayMs ?? backoffDelay(this.retry, job?.attempt ?? 1);
    const raw = await this.options.client.eval(
      NACK_SCRIPT,
      4,
      this.inflightKey,
      this.readyKey,
      this.deadKey,
      this.jobPrefix,
      jobId,
      workerId,
      this.clock.now(),
      delayMs,
      options.error ?? '',
      options.retry === false ? '1' : '0',
    );
    return raw ? (JSON.parse(String(raw)) as Job) : null;
  }

  async reclaimExpired(now = this.clock.now()): Promise<number> {
    const result = await this.options.client.eval(
      RECLAIM_SCRIPT,
      4,
      this.inflightKey,
      this.readyKey,
      this.deadKey,
      this.jobPrefix,
      now,
    );
    return Number(result ?? 0);
  }

  async get(jobId: string): Promise<Job | null> {
    const raw = await this.options.client.get(`${this.jobPrefix}${jobId}`);
    return raw ? (JSON.parse(raw) as Job) : null;
  }

  async stats(): Promise<QueueStats> {
    const now = this.clock.now();
    const [ready, total, inflight, dead] = await Promise.all([
      this.options.client.zcount(this.readyKey, '-inf', now),
      this.options.client.zcard(this.readyKey),
      this.options.client.zcard(this.inflightKey),
      this.options.client.zcard(this.deadKey),
    ]);
    return { ready, delayed: Math.max(0, total - ready), inflight, dead };
  }

  async deadLetter(limit = 50): Promise<Job[]> {
    const ids = await this.options.client.zrange(this.deadKey, 0, limit - 1);
    const jobs = await Promise.all(ids.map((id) => this.get(id)));
    return jobs.filter((j): j is Job => j !== null);
  }

  async purge(): Promise<void> {
    const keys = await this.options.client.keys(`${this.ns}:*`);
    if (keys.length > 0) await this.options.client.del(...keys);
  }

  async close(): Promise<void> {
    if (this.options.ownsClient) await this.options.client.quit();
  }
}

/** Build a RedisQueue from a connection URL using ioredis. */
export async function createRedisQueue(
  url: string,
  options: Omit<RedisQueueOptions, 'client'> = {},
): Promise<RedisQueue> {
  let Redis: new (url: string) => RedisLike;
  try {
    const mod = (await import('ioredis')) as unknown as { default: new (url: string) => RedisLike };
    Redis = mod.default;
  } catch (error) {
    throw new AgentOSError('internal', 'ioredis is not installed; install it to use the Redis queue', {
      cause: error,
    });
  }
  return new RedisQueue({ ...options, client: new Redis(url), ownsClient: true });
}
