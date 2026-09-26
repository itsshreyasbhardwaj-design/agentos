import { TestClock, Redactor } from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';
import { BufferedEventSink, EventEmitter, InMemoryEventBus } from './bus.js';
import { buildTrace } from './trace.js';
import type { AnyEvent } from './types.js';

const ctx = { orgId: 'org_1', executionId: 'exec_1', agentId: 'agt_1', traceId: 'trace_1' };

describe('EventEmitter', () => {
  it('assigns monotonic sequence numbers', async () => {
    const seen: AnyEvent[] = [];
    const emitter = new EventEmitter(ctx, {
      clock: new TestClock(1000),
      sink: { append: async (e) => void seen.push(...e) },
    });
    await emitter.emit('execution.created', { input: 'hi', mode: 'live', trigger: { type: 'api' } });
    await emitter.emit('execution.started', { workerId: 'w1', attempt: 1 });
    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
    expect(seen[0]?.traceId).toBe('trace_1');
  });

  it('redacts payloads before they reach the sink', async () => {
    const seen: AnyEvent[] = [];
    const emitter = new EventEmitter(ctx, {
      redactor: new Redactor({ literals: ['super-secret-value'] }),
      sink: { append: async (e) => void seen.push(...e) },
    });
    await emitter.emit('tool.started', {
      toolCallId: 'tc_1',
      toolName: 'http.request',
      arguments: { authorization: 'super-secret-value', note: 'uses super-secret-value' },
    });
    const payload = seen[0]?.payload as { arguments: Record<string, string> };
    expect(payload.arguments['authorization']).toBe('[redacted]');
    expect(payload.arguments['note']).not.toContain('super-secret-value');
  });
});

describe('InMemoryEventBus', () => {
  it('delivers only matching events', async () => {
    const bus = new InMemoryEventBus();
    const mine = vi.fn();
    const other = vi.fn();
    bus.subscribe({ executionId: 'exec_1' }, mine);
    bus.subscribe({ executionId: 'exec_2' }, other);
    const emitter = new EventEmitter(ctx, { bus });
    await emitter.emit('execution.started', { workerId: 'w', attempt: 1 });
    expect(mine).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it('keeps publishing when a subscriber throws', async () => {
    const bus = new InMemoryEventBus();
    const good = vi.fn();
    bus.subscribe({}, () => {
      throw new Error('boom');
    });
    bus.subscribe({}, good);
    const emitter = new EventEmitter(ctx, { bus });
    await emitter.emit('execution.started', { workerId: 'w', attempt: 1 });
    expect(good).toHaveBeenCalledOnce();
  });
});

describe('BufferedEventSink', () => {
  it('retains events when the inner sink fails', async () => {
    let fail = true;
    const inner = {
      append: async () => {
        if (fail) throw new Error('db down');
      },
    };
    const sink = new BufferedEventSink(inner);
    const emitter = new EventEmitter(ctx, { sink });
    await expect(
      emitter.emit('execution.started', { workerId: 'w', attempt: 1 }),
    ).rejects.toThrow('db down');
    expect(sink.pending).toBe(1);
    fail = false;
    await sink.append([]);
    expect(sink.pending).toBe(0);
  });
});

describe('buildTrace', () => {
  it('pairs started/succeeded events into spans', async () => {
    const collected: AnyEvent[] = [];
    const clock = new TestClock(0);
    const emitter = new EventEmitter(ctx, { clock, sink: { append: async (e) => void collected.push(...e) } });
    await emitter.emit(
      'model.call_started',
      { provider: 'scripted', model: 'test', messageCount: 2, toolCount: 1 },
      { spanId: 'span_1' },
    );
    clock.advance(120);
    await emitter.emit(
      'model.call_succeeded',
      {
        provider: 'scripted',
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        costMicroUsd: 42,
        finishReason: 'tool_calls',
        toolCallCount: 1,
      },
      { spanId: 'span_1', durationMs: 120 },
    );
    await emitter.emit('tool.started', { toolCallId: 'tc_1', toolName: 'math.eval', arguments: { expr: '1+1' } });
    clock.advance(5);
    await emitter.emit('tool.succeeded', { toolCallId: 'tc_1', toolName: 'math.eval', output: 2, durationMs: 5 });
    await emitter.emit('execution.completed', {
      output: 'done',
      usage: {
        modelCalls: 1, toolCalls: 1, inputTokens: 10, outputTokens: 5,
        totalTokens: 15, costMicroUsd: 42, retries: 0, approvals: 0, steps: 1,
      },
      durationMs: 125,
    });

    const trace = buildTrace(collected);
    expect(trace.nodes).toHaveLength(2);
    expect(trace.nodes[0]).toMatchObject({ kind: 'model', status: 'ok', durationMs: 120, costMicroUsd: 42 });
    expect(trace.nodes[1]).toMatchObject({ kind: 'tool', name: 'math.eval', status: 'ok', output: 2 });
    expect(trace.durationMs).toBe(125);
  });

  it('leaves an unfinished span pending rather than inventing an end', async () => {
    const collected: AnyEvent[] = [];
    const emitter = new EventEmitter(ctx, { sink: { append: async (e) => void collected.push(...e) } });
    await emitter.emit('tool.started', { toolCallId: 'tc_9', toolName: 'http.request', arguments: {} });
    const trace = buildTrace(collected);
    expect(trace.nodes[0]?.status).toBe('pending');
    expect(trace.nodes[0]?.endedAt).toBeNull();
    expect(trace.endedAt).toBeNull();
  });
});
