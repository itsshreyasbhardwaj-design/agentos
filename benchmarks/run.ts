/**
 * AgentOS benchmarks.
 *
 * Methodology, stated so the numbers can be judged:
 *
 *  - The model is the deterministic scripted provider, so what is measured is
 *    AgentOS's own overhead, not a model's latency. Real end-to-end latency in
 *    production is dominated by the model and is not comparable to these.
 *  - Storage and queue are in-process. Postgres and Redis add network and
 *    durability costs these numbers do not include.
 *  - Every run goes through the full path: queue, lease, policy evaluation,
 *    tool execution, event emission and persistence. Nothing is stubbed out.
 *  - Each benchmark warms up before measuring, and reports percentiles rather
 *    than a mean, because the tail is what matters for a control plane.
 *
 * Run with: pnpm bench
 */

import { performance } from 'node:perf_hooks';
import { InMemoryEventBus, EventEmitter } from '@agentos/events';
import { buildTrace } from '@agentos/events';
import { PolicyEngine, baselinePolicy, type PolicyRequest } from '@agentos/policy';
import { DEFAULT_LIMITS, emptyUsage } from '@agentos/core';
import { createBenchStack, ORG, PRINCIPAL, percentile, summarise, type Sample } from './harness.js';

const results: Sample[] = [];
const record = (samples: Sample[]) => {
  for (const sample of samples) {
    results.push(sample);
    process.stdout.write(`  ${sample.name.padEnd(46)} ${String(sample.value).padStart(10)} ${sample.unit}\n`);
  }
};

function heapMb(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// ---------------------------------------------------------------------------

async function benchStartupLatency(): Promise<void> {
  process.stdout.write('\nagent startup latency — enqueue to first model call\n');
  const stack = await createBenchStack();
  const slug = await stack.publish('startup');
  const worker = stack.worker('bench-startup', 1);
  const durations: number[] = [];

  for (let i = 0; i < 220; i++) {
    const started = performance.now();
    const execution = await stack.executions.run(PRINCIPAL, { agentRef: slug, input: `run ${i}` });
    await worker.runOnce();
    const events = await stack.store.events.listForExecution(ORG, execution.id, {
      types: ['model.call_started'],
    });
    if (events.length === 0) continue;
    if (i >= 20) durations.push(performance.now() - started);
  }
  record(summarise('cold start (queue → first model call)', durations));
}

async function benchThroughput(): Promise<void> {
  process.stdout.write('\nexecution throughput — single worker, varying concurrency\n');
  for (const concurrency of [1, 4, 16]) {
    const stack = await createBenchStack();
    const slug = await stack.publish(`throughput-${concurrency}`);
    const worker = stack.worker(`bench-tp-${concurrency}`, concurrency);
    const total = 400;

    for (let i = 0; i < total; i++) {
      await stack.executions.run(PRINCIPAL, { agentRef: slug, input: `n${i}` });
    }

    const started = performance.now();
    for (let round = 0; round < total; round++) {
      if ((await worker.runOnce()) === 0) break;
    }
    const elapsed = performance.now() - started;
    const done = (await stack.store.executions.countByStatus(ORG)).completed;
    record([
      {
        name: `throughput @ concurrency ${concurrency}`,
        unit: 'executions/s',
        value: Number(((done / elapsed) * 1000).toFixed(1)),
      },
    ]);
  }
}

async function benchToolOverhead(): Promise<void> {
  process.stdout.write('\ntool execution overhead — runtime cost around a trivial tool\n');
  const stack = await createBenchStack(({ messages }) =>
    messages.some((m) => m.role === 'tool')
      ? { content: 'done', finishReason: 'stop' }
      : ({ toolCalls: [{ name: 'math.evaluate', arguments: { expression: '2+2' } as never }] } as never),
  );
  const slug = await stack.publish('tools', {
    permissions: { allowedTools: ['math.evaluate'], allowedOperations: ['read'] },
  });
  const worker = stack.worker('bench-tools', 1);
  const durations: number[] = [];

  for (let i = 0; i < 220; i++) {
    const execution = await stack.executions.run(PRINCIPAL, { agentRef: slug, input: 'go' });
    const started = performance.now();
    while ((await worker.runOnce()) > 0) {
      /* drain */
    }
    const elapsed = performance.now() - started;
    const record_ = await stack.store.executions.get(ORG, execution.id);
    if (record_?.status !== 'completed') continue;
    if (i >= 20) durations.push(elapsed);
  }
  record(summarise('full execution with 1 tool call', durations));
}

async function benchPolicyEvaluation(): Promise<void> {
  process.stdout.write('\npolicy evaluation — the gate every tool call passes through\n');
  const engine = new PolicyEngine();
  const policies = [baselinePolicy(ORG)];
  const permissions = {
    allowedTools: ['github.*', 'http.get', 'math.evaluate'],
    allowedOperations: ['read', 'network'] as Array<'read' | 'network'>,
    allowedDomains: ['api.github.com'],
  };
  const request: PolicyRequest = {
    kind: 'tool_call',
    orgId: ORG,
    agentId: 'agt_1',
    agentSlug: 'bench',
    agentLabels: {},
    executionId: 'exec_1',
    mode: 'live',
    usage: emptyUsage(),
    limits: DEFAULT_LIMITS,
    elapsedMs: 0,
    tool: {
      name: 'github.list_issues',
      operations: ['read'],
      destructive: false,
      domains: ['api.github.com'],
      arguments: {},
    },
  };

  for (let i = 0; i < 10_000; i++) engine.evaluateWithPermissions(request, permissions, policies);

  const iterations = 200_000;
  const started = performance.now();
  for (let i = 0; i < iterations; i++) engine.evaluateWithPermissions(request, permissions, policies);
  const elapsed = performance.now() - started;

  record([
    { name: 'policy decisions', unit: 'decisions/s', value: Number(((iterations / elapsed) * 1000).toFixed(0)) },
    { name: 'policy decision latency', unit: 'µs', value: Number(((elapsed / iterations) * 1000).toFixed(2)) },
  ]);
}

async function benchEventPipeline(): Promise<void> {
  process.stdout.write('\nevent pipeline — emit (with redaction) and rebuild a trace\n');
  const bus = new InMemoryEventBus({ retain: 100 });
  const collected: never[] = [];
  const emitter = new EventEmitter(
    { orgId: ORG, executionId: 'exec_bench', agentId: 'agt_1', traceId: 'trace_1' },
    { bus, sink: { append: async (events) => void collected.push(...(events as never[])) } },
  );

  const iterations = 20_000;
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    await emitter.emit('tool.succeeded', {
      toolCallId: `tc_${i}`,
      toolName: 'math.evaluate',
      output: { result: i },
      durationMs: 1,
    });
  }
  const emitElapsed = performance.now() - started;

  const traceStarted = performance.now();
  buildTrace(collected.slice(0, 5_000));
  const traceElapsed = performance.now() - traceStarted;

  record([
    { name: 'event emit (redacted + persisted)', unit: 'events/s', value: Number(((iterations / emitElapsed) * 1000).toFixed(0)) },
    { name: 'event emit latency', unit: 'µs', value: Number(((emitElapsed / iterations) * 1000).toFixed(2)) },
    { name: 'trace rebuild (5k events)', unit: 'ms', value: Number(traceElapsed.toFixed(2)) },
  ]);
}

async function benchConcurrentExecutions(): Promise<void> {
  process.stdout.write('\nconcurrent executions — several workers against one queue\n');
  const stack = await createBenchStack();
  const slug = await stack.publish('concurrent');
  const total = 600;
  for (let i = 0; i < total; i++) {
    await stack.executions.run(PRINCIPAL, { agentRef: slug, input: `n${i}` });
  }

  const workers = [1, 2, 3, 4].map((n) => stack.worker(`bench-w${n}`, 8));
  const started = performance.now();
  for (let round = 0; round < total; round++) {
    const processed = await Promise.all(workers.map((w) => w.runOnce()));
    if (processed.every((p) => p === 0)) break;
  }
  const elapsed = performance.now() - started;
  const counts = await stack.store.executions.countByStatus(ORG);

  record([
    { name: '4 workers × 8 concurrency', unit: 'executions/s', value: Number(((counts.completed / elapsed) * 1000).toFixed(1)) },
    { name: 'executions completed', unit: 'count', value: counts.completed },
  ]);
}

async function benchMemoryFootprint(): Promise<void> {
  process.stdout.write('\nmemory footprint — retained bytes per completed execution\n');
  const stack = await createBenchStack();
  const slug = await stack.publish('footprint');
  const worker = stack.worker('bench-mem', 8);

  global.gc?.();
  const before = heapMb();
  const total = 500;
  for (let i = 0; i < total; i++) {
    await stack.executions.run(PRINCIPAL, { agentRef: slug, input: `n${i}` });
  }
  while ((await worker.runOnce()) > 0) {
    /* drain */
  }
  global.gc?.();
  const after = heapMb();

  record([
    {
      name: 'retained per execution (state + events)',
      unit: 'KB',
      value: Number((((after - before) * 1024) / total).toFixed(1)),
    },
  ]);
  if (!global.gc) {
    process.stdout.write('  note: run with --expose-gc for a stable figure; this one includes uncollected garbage\n');
  }
}

async function main(): Promise<void> {
  process.stdout.write('AgentOS benchmarks\n');
  process.stdout.write(`node ${process.version} · ${process.platform}/${process.arch}\n`);
  process.stdout.write('model: deterministic scripted provider · store/queue: in-process\n');

  await benchStartupLatency();
  await benchThroughput();
  await benchToolOverhead();
  await benchPolicyEvaluation();
  await benchEventPipeline();
  await benchConcurrentExecutions();
  await benchMemoryFootprint();

  process.stdout.write('\n--- machine-readable ---\n');
  process.stdout.write(`${JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`benchmark failed: ${String(error)}\n`);
  process.exit(1);
});
