import { serve } from '@hono/node-server';
import { JsonLogger, newId, sha256 } from '@agentos/core';
import { ExecutionWorker, RecoveryService, Scheduler, TaskService } from '@agentos/runtime';
import { baselinePolicy } from '@agentos/policy';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { generateApiKey } from './auth.js';

const logger = new JsonLogger({ base: { service: 'agentos-api' } });

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 8787);
  const { ctx, bus, shutdown } = await bootstrap({ logger });

  // Single-process mode: run a worker, scheduler and recovery in-process so
  // `pnpm dev:api` is a complete system. Production runs these as their own
  // deployment (apps/worker) and sets AGENTOS_EMBED_WORKER=false.
  const embedWorker = process.env['AGENTOS_EMBED_WORKER'] !== 'false';
  const worker = new ExecutionWorker(ctx, { logger, concurrency: Number(process.env['AGENTOS_CONCURRENCY'] ?? 4) });
  const scheduler = new Scheduler(ctx);
  const recovery = new RecoveryService(ctx);
  const tasks = new TaskService(ctx);
  let taskTimer: ReturnType<typeof setInterval> | null = null;

  if (embedWorker) {
    worker.start();
    scheduler.start();
    recovery.start();
    taskTimer = setInterval(() => {
      void (async () => {
        for (const org of await ctx.store.orgs.list()) await tasks.reconcile(org.id);
      })().catch(() => undefined);
    }, 5_000);
    taskTimer.unref();
    logger.info('embedded worker, scheduler and recovery started');
  }

  // With the in-process store there is nothing to seed into ahead of time, so
  // the demo data is created at boot when asked for.
  if (process.env['AGENTOS_SEED_DEMO'] === 'true') {
    const { seedInto } = await import('./seed.js');
    const { apiKey } = await seedInto(ctx);
    logger.info('demo data seeded', { apiKey });
    process.stdout.write(`\nDEMO_API_KEY=${apiKey}\n\n`);
  }

  const app = createApp({ ctx, bus });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info('api listening', { port: info.port, url: `http://127.0.0.1:${info.port}` });
  });

  const stop = async (signal: string) => {
    logger.info('shutting down', { signal });
    if (taskTimer) clearInterval(taskTimer);
    scheduler.stop();
    recovery.stop();
    await worker.stop();
    server.close();
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

export { createApp, bootstrap, generateApiKey, baselinePolicy, newId, sha256 };

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((error: unknown) => {
    logger.error('failed to start', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
