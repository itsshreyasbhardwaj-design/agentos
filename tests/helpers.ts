import {
  DEFAULT_LIMITS,
  FastClock,
  MemorySecretResolver,
  newId,
  nullLogger,
  Redactor,
  sha256,
  type AgentSpec,
  type Role,
} from '@agentos/core';
import { InMemoryEventBus } from '@agentos/events';
import { InMemoryMemoryProvider, MemoryManager } from '@agentos/memory';
import { baselinePolicy, PolicyEngine } from '@agentos/policy';
import { ModelRouter, ProviderRegistry, ScriptedProvider, type ScriptFn } from '@agentos/providers';
import { InMemoryQueue } from '@agentos/queue';
import {
  AgentService,
  createDelegateTool,
  createRuntimeContext,
  createSendMessageTool,
  ExecutionWorker,
  type RuntimeContext,
} from '@agentos/runtime';
import { InMemoryStore } from '@agentos/store';
import { BUILTIN_TOOLS, ToolExecutor, ToolRegistry } from '@agentos/tools';
import { createApp } from '@agentos/api';

export interface TestOrg {
  orgId: string;
  userId: string;
  apiKey: string;
  role: Role;
}

export interface TestStack {
  app: ReturnType<typeof createApp>;
  ctx: RuntimeContext;
  store: InMemoryStore;
  clock: FastClock;
  provider: ScriptedProvider;
  worker: ExecutionWorker;
  orgs: Record<string, TestOrg>;
  /** Issue a key for a new org, or another key with a different role. */
  addOrg(name: string, role?: Role): Promise<TestOrg>;
  addKey(orgId: string, role: Role, userId?: string): Promise<string>;
  request(path: string, init?: RequestInit & { key?: string }): Promise<Response>;
  json<T>(path: string, init?: RequestInit & { key?: string }): Promise<T>;
  publishAgent(org: TestOrg, slug: string, spec: Partial<AgentSpec>): Promise<string>;
  drain(rounds?: number): Promise<void>;
}

export interface TestStackOptions {
  script?: ScriptFn;
  /** Stub for outbound HTTP made by tools. Defaults to a benign 200. */
  fetchImpl?: typeof fetch;
}

export async function createTestStack(
  scriptOrOptions?: ScriptFn | TestStackOptions,
): Promise<TestStack> {
  const options: TestStackOptions =
    typeof scriptOrOptions === 'function' ? { script: scriptOrOptions } : (scriptOrOptions ?? {});
  const script = options.script;
  const clock = new FastClock();
  const store = new InMemoryStore();
  await store.init();
  const queue = new InMemoryQueue({ clock });
  const bus = new InMemoryEventBus();
  const provider = new ScriptedProvider({
    id: 'scripted',
    fallback: script ?? (() => ({ content: 'done', finishReason: 'stop' })),
    sleep: (ms) => clock.sleep(ms),
  });
  const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);

  const ctx = createRuntimeContext({
    store,
    queue,
    registry,
    executor: new ToolExecutor({
      registry,
      clock,
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl:
        options.fetchImpl ??
        ((async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch),
    }),
    router: new ModelRouter({ registry: new ProviderRegistry().register(provider), clock }),
    policy: new PolicyEngine(),
    memory: new MemoryManager().register(new InMemoryMemoryProvider({ clock })),
    secrets: new MemorySecretResolver({ WH_SECRET: 'whsec_integration' }),
    bus,
    clock,
    logger: nullLogger,
    redactor: new Redactor(),
  });
  registry.registerAll([createDelegateTool(ctx), createSendMessageTool(ctx)]);

  const app = createApp({ ctx, bus });
  const worker = new ExecutionWorker(ctx, { workerId: 'worker-it', concurrency: 4 });
  const agents = new AgentService(ctx);
  const orgs: Record<string, TestOrg> = {};

  const stack: TestStack = {
    app,
    ctx,
    store,
    clock,
    provider,
    worker,
    orgs,

    async addKey(orgId, role, userId = `usr_${role}_${newId('user').slice(-6)}`) {
      await store.users.upsert({ id: userId, email: `${userId}@test.local`, name: userId, createdAt: clock.now() });
      await store.users.addMember({ orgId, userId, role, createdAt: clock.now() });
      const plaintext = `aos_test_${newId('apiKey').slice(-20)}`;
      await store.apiKeys.create({
        id: newId('apiKey'),
        orgId,
        userId,
        name: `${role}-key`,
        hash: sha256(plaintext),
        prefix: plaintext.slice(0, 12),
        role,
        createdAt: clock.now(),
        lastUsedAt: null,
        revokedAt: null,
      });
      return plaintext;
    },

    async addOrg(name, role: Role = 'owner') {
      const orgId = `org_${name}`;
      await store.orgs.create({ id: orgId, name, slug: name, createdAt: clock.now() });
      await store.policies.create(baselinePolicy(orgId, clock.now()));
      const userId = `usr_${name}`;
      const apiKey = await stack.addKey(orgId, role, userId);
      const org = { orgId, userId, apiKey, role };
      orgs[name] = org;
      return org;
    },

    async request(path, init = {}) {
      const { key, ...rest } = init;
      return app.fetch(
        new Request(`http://api.test${path}`, {
          ...rest,
          headers: {
            'content-type': 'application/json',
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...(rest.headers ?? {}),
          },
        }),
      );
    },

    async json<T>(path: string, init: RequestInit & { key?: string } = {}) {
      const response = await stack.request(path, init);
      return (await response.json()) as T;
    },

    async publishAgent(org, slug, spec) {
      const principal = { userId: org.userId, orgId: org.orgId, role: org.role };
      await agents.create(principal, {
        slug,
        name: slug,
        spec: {
          model: { primary: 'scripted:test' },
          instructions: 'Test agent.',
          limits: DEFAULT_LIMITS,
          permissions: { allowedTools: [], allowedOperations: [] },
          ...spec,
        } as never,
      });
      const agent = await agents.getBySlugOrId(org.orgId, slug);
      await agents.publish(principal, agent.id);
      return agent.id;
    },

    async drain(rounds = 20) {
      for (let i = 0; i < rounds; i++) {
        if ((await worker.runOnce()) === 0) return;
      }
    },
  };

  return stack;
}
