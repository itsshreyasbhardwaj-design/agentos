import { JsonLogger } from '@agentos/core';
import { bootstrap } from '@agentos/api';
import { ExecutionWorker, RecoveryService, Scheduler, TaskService } from '@agentos/runtime';

const logger = new JsonLogger({ base: { service: 'agentos-worker' } });

/**
 * The execution tier.
 *
 * Runs separately from the API so that agent work — which can take minutes and
 * burn CPU — never shares a process with request handling, and so the two can
 * be scaled independently. Several instances can run against one database and
 * queue: leases keep them from colliding.
 */
async function main(): Promise<void> {
  const { ctx, shutdown } = await bootstrap({ logger });

  const concurrency = Number(process.env['AGENTOS_CONCURRENCY'] ?? 8);
  const worker = new ExecutionWorker(ctx, { logger, concurrency });
  const recovery = new RecoveryService(ctx, { intervalMs: 15_000 });
  const tasks = new TaskService(ctx);

  // One process in the fleet should own scheduling; the compare-and-set claim
  // makes it safe if more than one does.
  const runScheduler = process.env['AGENTOS_RUN_SCHEDULER'] !== 'false';
  const scheduler = new Scheduler(ctx, { intervalMs: 10_000 });

  worker.start();
  recovery.start();
  if (runScheduler) scheduler.start();

  const taskTimer = setInterval(() => {
    void (async () => {
      for (const org of await ctx.store.orgs.list()) await tasks.reconcile(org.id);
    })().catch((error: unknown) => {
      logger.error('task reconcile failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }, 5_000);
  taskTimer.unref();

  logger.info('worker online', { workerId: worker.workerId, concurrency, scheduler: runScheduler });

  let shuttingDown = false;
  const stop = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('draining', { signal, inFlight: worker.busy });
    clearInterval(taskTimer);
    scheduler.stop();
    recovery.stop();
    // Stopping the worker aborts in-flight runs; the engine persists their state
    // and re-queues them, so nothing is lost — it resumes on another worker.
    await worker.stop();
    await shutdown();
    logger.info('worker stopped cleanly');
    process.exit(0);
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.error('worker failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
