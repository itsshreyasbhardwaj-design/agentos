import { TestClock } from '@agentos/core';
import { describe, expect, it } from 'vitest';
import { InMemoryQueue } from './in-memory.js';

const org = 'org_1';

describe('InMemoryQueue', () => {
  it('enqueues and reserves in priority then time order', async () => {
    const clock = new TestClock(1_000);
    const queue = new InMemoryQueue({ clock });
    await queue.enqueue({ orgId: org, type: 'run', payload: { n: 1 } });
    await queue.enqueue({ orgId: org, type: 'run', payload: { n: 2 }, priority: 5 });
    const [first] = await queue.reserve({ workerId: 'w1', leaseMs: 1_000 });
    expect(first?.payload).toEqual({ n: 2 });
    expect(first?.attempt).toBe(1);
    expect(first?.status).toBe('inflight');
  });

  it('collapses duplicate enqueues on an idempotency key', async () => {
    const queue = new InMemoryQueue();
    const a = await queue.enqueue({ orgId: org, type: 'run', payload: {}, idempotencyKey: 'k1' });
    const b = await queue.enqueue({ orgId: org, type: 'run', payload: {}, idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
    expect((await queue.stats()).ready).toBe(1);
  });

  it('does not release a delayed job before its time', async () => {
    const clock = new TestClock(0);
    const queue = new InMemoryQueue({ clock });
    await queue.enqueue({ orgId: org, type: 'run', payload: {}, runAt: 5_000 });
    expect(await queue.reserve({ workerId: 'w1', leaseMs: 100 })).toHaveLength(0);
    clock.advance(5_000);
    expect(await queue.reserve({ workerId: 'w1', leaseMs: 100 })).toHaveLength(1);
  });

  it('filters by job type', async () => {
    const queue = new InMemoryQueue();
    await queue.enqueue({ orgId: org, type: 'run', payload: {} });
    await queue.enqueue({ orgId: org, type: 'schedule', payload: {} });
    const reserved = await queue.reserve({ workerId: 'w1', leaseMs: 100, types: ['schedule'], max: 10 });
    expect(reserved.map((j) => j.type)).toEqual(['schedule']);
  });

  it('only lets the lease holder ack', async () => {
    const queue = new InMemoryQueue();
    await queue.enqueue({ orgId: org, type: 'run', payload: {} });
    const [job] = await queue.reserve({ workerId: 'w1', leaseMs: 1_000 });
    expect(await queue.ack(job?.id as string, 'w2')).toBe(false);
    expect(await queue.ack(job?.id as string, 'w1')).toBe(true);
  });

  it('retries on nack and dead-letters once attempts are exhausted', async () => {
    const clock = new TestClock(0);
    const queue = new InMemoryQueue({ clock, defaultMaxAttempts: 2 });
    await queue.enqueue({ orgId: org, type: 'run', payload: {} });

    const [first] = await queue.reserve({ workerId: 'w1', leaseMs: 1_000 });
    const afterFirst = await queue.nack(first?.id as string, 'w1', { delayMs: 10, error: 'boom' });
    expect(afterFirst?.status).toBe('delayed');

    clock.advance(20);
    const [second] = await queue.reserve({ workerId: 'w1', leaseMs: 1_000 });
    const afterSecond = await queue.nack(second?.id as string, 'w1', { error: 'boom again' });
    expect(afterSecond?.status).toBe('dead');
    expect(await queue.deadLetter()).toHaveLength(1);
  });

  it('reclaims a job whose worker stopped heartbeating', async () => {
    const clock = new TestClock(0);
    const queue = new InMemoryQueue({ clock });
    await queue.enqueue({ orgId: org, type: 'run', payload: {} });
    const [job] = await queue.reserve({ workerId: 'dead-worker', leaseMs: 1_000 });

    clock.advance(500);
    expect(await queue.reclaimExpired()).toBe(0);
    expect(await queue.heartbeat(job?.id as string, 'dead-worker', 1_000)).toBe(true);

    clock.advance(1_001);
    expect(await queue.reclaimExpired()).toBe(1);
    const [reclaimed] = await queue.reserve({ workerId: 'w2', leaseMs: 1_000 });
    expect(reclaimed?.id).toBe(job?.id);
    expect(reclaimed?.attempt).toBe(2);
  });

  it('reports queue depth by state', async () => {
    const clock = new TestClock(0);
    const queue = new InMemoryQueue({ clock });
    await queue.enqueue({ orgId: org, type: 'run', payload: {} });
    await queue.enqueue({ orgId: org, type: 'run', payload: {}, runAt: 10_000 });
    await queue.reserve({ workerId: 'w1', leaseMs: 1_000 });
    expect(await queue.stats()).toEqual({ ready: 0, delayed: 1, inflight: 1, dead: 0 });
  });
});
