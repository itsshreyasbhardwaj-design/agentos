import {
  DEFAULT_LIMITS,
  MemorySecretResolver,
  newId,
  nullLogger,
  Redactor,
  systemClock,
  type AgentSpec,
  type Principal,
} from '@agentos/core';
import { InMemoryMemoryProvider, MemoryManager } from '@agentos/memory';
import { baselinePolicy, PolicyEngine } from '@agentos/policy';
import { ModelRouter, ProviderRegistry, ScriptedProvider, type ScriptFn } from '@agentos/providers';
import { InMemoryQueue } from '@agentos/queue';
import { AgentService, createRuntimeContext, ExecutionService, ExecutionWorker } from '@agentos/runtime';
import { InMemoryStore } from '@agentos/store';
import { BUILTIN_TOOLS, ToolExecutor, ToolRegistry } from '@agentos/tools';

export const ORG = 'org_bench';
export const PRINCIPAL: Principal = { userId: 'usr_bench', orgId: ORG, role: 'owner' };

export interface BenchStack {
  ctx: ReturnType<typeof createRuntimeContext>;
  store: InMemoryStore;
  queue: InMemoryQueue;
  executions: ExecutionService;
  provider: ScriptedProvider;
  worker(id: string, concurrency: number): ExecutionWorker;
  publish(slug: string, spec?: Partial<AgentSpec>): Promise<string>;
}

/**
 * A complete runtime on in-memory infrastructure with a deterministic model.
 *
 * The scripted provider answers in microseconds, which is the point: these
 * numbers measure AgentOS's own overhead — queueing, leasing, policy
 * evaluation, persistence, event emission — with the model's latency removed.
 * Real-world latency is dominated by the model and is not what this measures.
 */
export async function createBenchStack(script?: ScriptFn): Promise<BenchStack> {
  const store = new InMemoryStore();
  await store.init();
  const queue = new InMemoryQueue();
  const provider = new ScriptedProvider({
    id: 'scripted',
    fallback: script ?? (() => ({ content: 'ok', finishReason: 'stop' })),
  });
  const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);

  const ctx = createRuntimeContext({
    store,
    queue,
    registry,
    executor: new ToolExecutor({ registry }),
    router: new ModelRouter({ registry: new ProviderRegistry().register(provider), clock: systemClock }),
    policy: new PolicyEngine(),
    memory: new MemoryManager().register(new InMemoryMemoryProvider()),
    secrets: new MemorySecretResolver({}),
    logger: nullLogger,
    redactor: new Redactor(),
  });

  await store.orgs.create({ id: ORG, name: 'Bench', slug: 'bench', createdAt: Date.now() });
  await store.users.upsert({ id: 'usr_bench', email: 'b@bench.local', name: 'Bench', createdAt: Date.now() });
  await store.users.addMember({ orgId: ORG, userId: 'usr_bench', role: 'owner', createdAt: Date.now() });
  await store.policies.create(baselinePolicy(ORG, Date.now()));

  const agents = new AgentService(ctx);
  const executions = new ExecutionService(ctx);

  return {
    ctx,
    store,
    queue,
    executions,
    provider,
    worker: (id, concurrency) => new ExecutionWorker(ctx, { workerId: id, concurrency, logger: nullLogger }),
    async publish(slug, spec = {}) {
      await agents.create(PRINCIPAL, {
        slug,
        name: slug,
        spec: {
          model: { primary: 'scripted:bench' },
          instructions: 'Benchmark agent.',
          limits: { ...DEFAULT_LIMITS, maxSteps: 32, maxToolCalls: 64 },
          permissions: { allowedTools: [], allowedOperations: [] },
          ...spec,
        } as never,
      });
      const agent = await agents.getBySlugOrId(ORG, slug);
      await agents.publish(PRINCIPAL, agent.id);
      return slug;
    },
  };
}

export interface Sample {
  name: string;
  unit: string;
  value: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summarise(name: string, durationsMs: number[]): Sample[] {
  return [
    { name: `${name} p50`, unit: 'ms', value: Number(percentile(durationsMs, 50).toFixed(3)) },
    { name: `${name} p95`, unit: 'ms', value: Number(percentile(durationsMs, 95).toFixed(3)) },
    { name: `${name} p99`, unit: 'ms', value: Number(percentile(durationsMs, 99).toFixed(3)) },
  ];
}

export const newRunId = () => newId('execution');
