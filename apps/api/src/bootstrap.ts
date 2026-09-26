import {
  EnvSecretResolver,
  JsonLogger,
  MemorySecretResolver,
  Redactor,
  systemClock,
  type Logger,
  type SecretResolver,
} from '@agentos/core';
import { InMemoryEventBus } from '@agentos/events';
import { HashingEmbeddingProvider, InMemoryMemoryProvider, MemoryManager } from '@agentos/memory';
import { PolicyEngine } from '@agentos/policy';
import {
  anthropicProvider,
  geminiProvider,
  ModelRouter,
  OllamaProvider,
  openAIProvider,
  openRouterProvider,
  ProviderRegistry,
  ScriptedProvider,
} from '@agentos/providers';
import { InMemoryQueue, createRedisQueue, type Queue } from '@agentos/queue';
import { createRuntimeContext, createDelegateTool, createSendMessageTool, type RuntimeContext } from '@agentos/runtime';
import { InMemoryStore, PgDriver, SqlStore, type Store } from '@agentos/store';
import { BUILTIN_TOOLS, McpManager, ToolExecutor, ToolRegistry } from '@agentos/tools';
import { demoScript } from './demo-model.js';

export interface BootstrapOptions {
  databaseUrl?: string | undefined;
  redisUrl?: string | undefined;
  logger?: Logger;
  /** Refuse every remote model provider. Useful for air-gapped runs and CI. */
  offlineOnly?: boolean;
}

export interface Bootstrapped {
  ctx: RuntimeContext;
  bus: InMemoryEventBus;
  store: Store;
  queue: Queue;
  mcp: McpManager;
  shutdown(): Promise<void>;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Register every model provider that has credentials configured, plus a
 * deterministic local provider that is always available.
 *
 * Missing credentials are not an error: a deployment with no keys still runs,
 * it just cannot route to the providers it has no access to.
 */
export function buildProviderRegistry(logger: Logger): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Always present: deterministic, local, free. Backs demos and offline runs.
  registry.register(new ScriptedProvider({ id: 'scripted', fallback: demoScript }), { asDefault: true });
  registry.register(new OllamaProvider());

  const configured: string[] = ['scripted', 'ollama'];
  if (env('OPENAI_API_KEY')) {
    registry.register(openAIProvider(() => env('OPENAI_API_KEY')));
    configured.push('openai');
  }
  if (env('ANTHROPIC_API_KEY')) {
    registry.register(anthropicProvider(() => env('ANTHROPIC_API_KEY')));
    configured.push('anthropic');
  }
  if (env('GEMINI_API_KEY')) {
    registry.register(geminiProvider(() => env('GEMINI_API_KEY')));
    configured.push('gemini');
  }
  if (env('OPENROUTER_API_KEY')) {
    registry.register(openRouterProvider(() => env('OPENROUTER_API_KEY')));
    configured.push('openrouter');
  }

  logger.info('model providers registered', { providers: configured });
  return registry;
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<Bootstrapped> {
  const logger = options.logger ?? new JsonLogger({ base: { service: 'agentos' } });
  const databaseUrl = options.databaseUrl ?? env('DATABASE_URL');
  const redisUrl = options.redisUrl ?? env('REDIS_URL');

  const store: Store = databaseUrl ? new SqlStore(await PgDriver.connect(databaseUrl)) : new InMemoryStore();
  await store.init();
  logger.info('store ready', { kind: store.kind });

  const queue: Queue = redisUrl ? await createRedisQueue(redisUrl) : new InMemoryQueue();
  logger.info('queue ready', { kind: queue.kind });

  if (!databaseUrl || !redisUrl) {
    logger.warn(
      'running with in-process infrastructure; state is lost on restart and workers cannot scale out',
      { store: store.kind, queue: queue.kind },
    );
  }

  const bus = new InMemoryEventBus({ retain: 2_000 });
  const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
  const providers = buildProviderRegistry(logger);

  const secrets: SecretResolver = env('AGENTOS_SECRETS_INLINE')
    ? new MemorySecretResolver(JSON.parse(env('AGENTOS_SECRETS_INLINE') as string) as Record<string, string>)
    : new EnvSecretResolver();

  const ctx = createRuntimeContext({
    store,
    queue,
    registry,
    executor: new ToolExecutor({ registry, logger }),
    router: new ModelRouter({
      registry: providers,
      clock: systemClock,
      timeoutMs: Number(env('AGENTOS_MODEL_TIMEOUT_MS') ?? 120_000),
    }),
    policy: new PolicyEngine(),
    memory: new MemoryManager().register(
      new InMemoryMemoryProvider({ embeddings: new HashingEmbeddingProvider() }),
    ),
    secrets,
    bus,
    logger,
    redactor: new Redactor(),
    leaseMs: Number(env('AGENTOS_LEASE_MS') ?? 30_000),
    ...(options.offlineOnly || env('AGENTOS_OFFLINE') === 'true' ? { offlineOnly: true } : {}),
  });

  // Registered after the context exists: these tools call back into the runtime.
  registry.registerAll([createDelegateTool(ctx), createSendMessageTool(ctx)]);

  const mcp = new McpManager({ logger });
  const mcpConfig = env('AGENTOS_MCP_SERVERS');
  if (mcpConfig) {
    for (const server of JSON.parse(mcpConfig) as Array<Parameters<McpManager['connect']>[0]>) {
      try {
        await mcp.connect(server);
        registry.registerAll(await mcp.discover(server.id));
      } catch (error) {
        logger.error('could not attach MCP server', {
          server: server.alias,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    ctx,
    bus,
    store,
    queue,
    mcp,
    async shutdown() {
      await mcp.disconnectAll();
      await queue.close();
      await store.close();
    },
  };
}
