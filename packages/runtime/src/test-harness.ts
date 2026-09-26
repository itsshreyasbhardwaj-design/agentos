import {
  DEFAULT_LIMITS,
  FastClock,
  MemorySecretResolver,
  newId,
  nullLogger,
  Redactor,
  type AgentSpec,
  type JsonValue,
  type Principal,
} from '@agentos/core';
import { InMemoryEventBus } from '@agentos/events';
import { InMemoryMemoryProvider, MemoryManager } from '@agentos/memory';
import { baselinePolicy, PolicyEngine } from '@agentos/policy';
import { ModelRouter, ProviderRegistry, ScriptedProvider, type ScriptedTurn } from '@agentos/providers';
import { InMemoryQueue } from '@agentos/queue';
import { InMemoryStore } from '@agentos/store';
import { BUILTIN_TOOLS, ToolExecutor, ToolRegistry, type ToolDefinition } from '@agentos/tools';
import { AgentService } from './agent-service.js';
import { createRuntimeContext, type RuntimeContext } from './context.js';
import { createDelegateTool, createSendMessageTool } from './multi-agent.js';
import { ExecutionService } from './execution-service.js';
import { ExecutionWorker, RecoveryService } from './worker.js';

export const ORG_ID = 'org_test';
export const USER_ID = 'usr_test';
export const PRINCIPAL: Principal = { userId: USER_ID, orgId: ORG_ID, role: 'admin' };

export interface HarnessOptions {
  /** Script the model follows, turn by turn. */
  turns?: ScriptedTurn[];
  tools?: ToolDefinition[];
  secrets?: Record<string, string>;
  /** Extra providers, e.g. a failing one to test fallback. */
  extraProviders?: ScriptedProvider[];
  includeBaselinePolicy?: boolean;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
}

export interface Harness {
  ctx: RuntimeContext;
  store: InMemoryStore;
  queue: InMemoryQueue;
  bus: InMemoryEventBus;
  clock: FastClock;
  provider: ScriptedProvider;
  agents: AgentService;
  executions: ExecutionService;
  worker: ExecutionWorker;
  recovery: RecoveryService;
  /** Create + publish an agent, returning its slug. */
  publishAgent(spec: Partial<AgentSpec>, slug?: string): Promise<string>;
  /** Run an agent and drain the queue until it settles. */
  runToCompletion(slug: string, input: JsonValue, maxRounds?: number): Promise<string>;
  drain(maxRounds?: number): Promise<void>;
}

/**
 * Wires a complete runtime with in-memory infrastructure and a scripted model.
 *
 * Everything in these tests is the real code path — real policy evaluation,
 * real tool execution, real persistence and a real worker — with only the model
 * and the outside network replaced. No API keys, no network, no spend.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new FastClock();
  const store = new InMemoryStore();
  await store.init();
  const queue = new InMemoryQueue({ clock });
  const bus = new InMemoryEventBus();

  const provider = new ScriptedProvider({
    id: 'scripted',
    ...(options.turns ? { scripts: { test: options.turns } } : { fallback: () => ({ content: 'done' }) }),
    sleep: (ms) => clock.sleep(ms),
  });

  const providers = new ProviderRegistry().register(provider);
  for (const extra of options.extraProviders ?? []) providers.register(extra);

  const registry = new ToolRegistry().registerAll([...BUILTIN_TOOLS, ...(options.tools ?? [])]);
  // Registered after the context exists, below, because the delegate tool needs it.
  const executor = new ToolExecutor({
    registry,
    clock,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
  });

  const ctx = createRuntimeContext({
    store,
    queue,
    registry,
    executor,
    router: new ModelRouter({
      registry: providers,
      clock,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2, jitter: 0 },
    }),
    secrets: new MemorySecretResolver(options.secrets ?? {}),
    memory: new MemoryManager().register(new InMemoryMemoryProvider({ clock })),
    policy: new PolicyEngine(),
    bus,
    clock,
    logger: nullLogger,
    redactor: new Redactor(),
    leaseMs: 30_000,
  });

  await store.orgs.create({ id: ORG_ID, name: 'Test Org', slug: 'test', createdAt: clock.now() });
  await store.users.upsert({ id: USER_ID, email: 'test@example.com', name: 'Tester', createdAt: clock.now() });
  await store.users.addMember({ orgId: ORG_ID, userId: USER_ID, role: 'admin', createdAt: clock.now() });
  if (options.includeBaselinePolicy !== false) {
    await store.policies.create(baselinePolicy(ORG_ID, clock.now()));
  }

  registry.registerAll([createDelegateTool(ctx), createSendMessageTool(ctx)]);

  const agents = new AgentService(ctx);
  const executions = new ExecutionService(ctx);
  const worker = new ExecutionWorker(ctx, { workerId: 'worker-test', concurrency: 4 });
  const recovery = new RecoveryService(ctx);

  const harness: Harness = {
    ctx,
    store,
    queue,
    bus,
    clock,
    provider,
    agents,
    executions,
    worker,
    recovery,

    async publishAgent(spec, slug = `agent-${newId('agent').slice(-6).toLowerCase()}`) {
      await agents.create(PRINCIPAL, {
        slug,
        name: slug,
        spec: {
          model: { primary: 'scripted:test' },
          instructions: 'You are a test agent.',
          limits: DEFAULT_LIMITS,
          permissions: { allowedTools: [], allowedOperations: [] },
          ...spec,
        },
      });
      const agent = await agents.getBySlugOrId(ORG_ID, slug);
      await agents.publish(PRINCIPAL, agent.id);
      return slug;
    },

    async drain(maxRounds = 20) {
      for (let i = 0; i < maxRounds; i++) {
        const processed = await worker.runOnce();
        if (processed === 0) return;
      }
    },

    async runToCompletion(slug, input, maxRounds = 20) {
      const execution = await executions.run(PRINCIPAL, { agentRef: slug, input });
      await harness.drain(maxRounds);
      return execution.id;
    },
  };

  return harness;
}

export function toolCallTurn(name: string, args: Record<string, unknown>): ScriptedTurn {
  return { toolCalls: [{ name, arguments: args as never }] };
}

export function answerTurn(content: string): ScriptedTurn {
  return { content, finishReason: 'stop' };
}
