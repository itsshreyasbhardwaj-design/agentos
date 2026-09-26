import { FastClock, type JsonObject } from '@agentos/core';
import { createRedisQueue, InMemoryQueue, type Queue } from '@agentos/queue';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const REDIS_URL = process.env['REDIS_URL'];

/**
 * The Redis queue against a real Redis.
 *
 * Skipped without `REDIS_URL` so the default suite needs no services. CI runs it
 * with a Redis service container; if you are reading this because you want to
 * trust the Redis adapter, this is the suite that establishes it:
 *
 *     docker run --rm -p 6379:6379 redis:7-alpine
 *     REDIS_URL=redis://127.0.0.1:6379 pnpm test:integration
 *
 * The assertions are deliberately the same behaviours the in-memory queue's
 * unit tests cover, because the two must be interchangeable.
 */
describe.skipIf(!REDIS_URL)('RedisQueue', () => {
  const org = 'org_redis_test';
  let queue: Queue;

  beforeEach(async () => {
    queue = await createRedisQueue(REDIS_URL as string, { namespace: `agentos-test-${process.pid}` });
    await queue.purge();
  });

  afterAll(async () => {
    await queue?.purge();
    await queue?.close();
  });

  it('enqueues and reserves', async () => {
    await queue.enqueue({ orgId: org, type: 'execution.run', payload: { n: 1 } as JsonObject });
    const [job] = await queue.reserve({ workerId: 'w1', leaseMs: 5_000 });
    expect(job?.payload).toEqual({ n: 1 });
    expect(job?.status).toBe('inflight');
    expect(job?.attempt).toBe(1);
  });

  it('gives a job to exactly one of two racing workers', async () => {
    await queue.enqueue({ orgId: org, type: 'execution.run', payload: {} });
    const [a, b] = await Promise.all([
      queue.reserve({ workerId: 'w1', leaseMs: 5_000 }),
      queue.reserve({ workerId: 'w2', leaseMs: 5_000 }),
    ]);
    expect(a.length + b.length).toBe(1);
  });

  it('collapses duplicate enqueues on an idempotency key', async () => {
    const first = await queue.enqueue({ orgId: org, type: 'execution.run', payload: {}, idempotencyKey: 'k1' });
    const second = await queue.enqueue({ orgId: org, type: 'execution.run', payload: {}, idempotencyKey: 'k1' });
    expect(second.id).toBe(first.id);
  });

  it('only lets the lease holder ack', async () => {
    await queue.enqueue({ orgId: org, type: 'execution.run', payload: {} });
    const [job] = await queue.reserve({ workerId: 'w1', leaseMs: 5_000 });
    expect(await queue.ack(job?.id as string, 'w2')).toBe(false);
    expect(await queue.ack(job?.id as string, 'w1')).toBe(true);
  });

  it('retries on nack then dead-letters', async () => {
    await queue.enqueue({ orgId: org, type: 'execution.run', payload: {}, maxAttempts: 2 });
    const [first] = await queue.reserve({ workerId: 'w1', leaseMs: 5_000 });
    const afterFirst = await queue.nack(first?.id as string, 'w1', { delayMs: 0, error: 'boom' });
    expect(afterFirst?.status).toBe('delayed');

    const [second] = await queue.reserve({ workerId: 'w1', leaseMs: 5_000 });
    expect(second?.id).toBe(first?.id);
    const afterSecond = await queue.nack(second?.id as string, 'w1', { error: 'again' });
    expect(afterSecond?.status).toBe('dead');
    expect((await queue.deadLetter()).map((j) => j.id)).toContain(first?.id);
  });

  it('reclaims a job whose worker stopped heartbeating', async () => {
    await queue.enqueue({ orgId: org, type: 'execution.run', payload: {} });
    const [job] = await queue.reserve({ workerId: 'dead', leaseMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await queue.reclaimExpired()).toBe(1);
    const [reclaimed] = await queue.reserve({ workerId: 'w2', leaseMs: 5_000 });
    expect(reclaimed?.id).toBe(job?.id);
  });

  it('filters by job type', async () => {
    await queue.enqueue({ orgId: org, type: 'execution.run', payload: {} });
    await queue.enqueue({ orgId: org, type: 'schedule.fire', payload: {} });
    const reserved = await queue.reserve({ workerId: 'w1', leaseMs: 5_000, types: ['schedule.fire'], max: 10 });
    expect(reserved.map((j) => j.type)).toEqual(['schedule.fire']);
  });

  it('reports depth by state', async () => {
    await queue.enqueue({ orgId: org, type: 'execution.run', payload: {} });
    await queue.enqueue({ orgId: org, type: 'execution.run', payload: {}, runAt: Date.now() + 60_000 });
    await queue.reserve({ workerId: 'w1', leaseMs: 5_000 });
    const stats = await queue.stats();
    expect(stats.inflight).toBe(1);
    expect(stats.delayed).toBe(1);
  });

  it('behaves the same as the in-memory queue for the same sequence', async () => {
    // Guards against the two implementations drifting apart.
    const memory = new InMemoryQueue({ clock: new FastClock() });
    for (const q of [queue, memory]) {
      await q.purge();
      await q.enqueue({ orgId: org, type: 'execution.run', payload: { a: 1 } });
      const [job] = await q.reserve({ workerId: 'w1', leaseMs: 5_000 });
      expect(job?.attempt, q.kind).toBe(1);
      expect(await q.ack(job?.id as string, 'w1'), q.kind).toBe(true);
      expect((await q.stats()).ready, q.kind).toBe(0);
    }
  });
});

describe.skipIf(REDIS_URL)('RedisQueue (skipped)', () => {
  it('reports why it did not run', () => {
    expect(REDIS_URL).toBeUndefined();
    // Visible in the report rather than silently absent.
    console.info('RedisQueue tests skipped: set REDIS_URL to run them against a real Redis.');
  });
});
