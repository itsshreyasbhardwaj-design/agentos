import { AgentOSError, isTerminal, type Logger } from '@agentos/core';
import type { Job } from '@agentos/queue';
import type { RuntimeContext } from './context.js';
import { ExecutionEngine } from './engine.js';
import { EXECUTION_JOB, ExecutionService } from './execution-service.js';
import { replaySourceFor } from './replay.js';

export interface WorkerOptions {
  workerId?: string;
  /** Executions processed in parallel by this worker. */
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  /** Lease renewal interval; must be well under leaseMs. */
  heartbeatMs?: number;
  logger?: Logger;
}

/**
 * Pulls executions off the queue and runs them.
 *
 * The queue job and the execution lease are separate on purpose: the job says
 * "someone should look at this", the lease says "I am the one working on it".
 * A worker that dies loses its lease, another worker reclaims the execution
 * with its persisted state intact, and the run continues from the last
 * completed step rather than from the beginning.
 */
export class ExecutionWorker {
  readonly workerId: string;
  private readonly engine: ExecutionEngine;
  private readonly executions: ExecutionService;
  private readonly logger: Logger;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private inFlight = 0;

  constructor(
    private readonly ctx: RuntimeContext,
    options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.engine = new ExecutionEngine(ctx);
    this.executions = new ExecutionService(ctx);
    this.logger = (options.logger ?? ctx.logger).child({ workerId: this.workerId });
    this.leaseMs = options.leaseMs ?? ctx.leaseMs;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.concurrency = options.concurrency ?? 4;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
  }

  get busy(): number {
    return this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    this.logger.info('worker started', { concurrency: this.concurrency, leaseMs: this.leaseMs });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loopPromise?.catch(() => undefined);
    this.logger.info('worker stopped');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.runOnce();
        if (processed === 0) await this.ctx.clock.sleep(this.pollIntervalMs, this.abort.signal);
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.logger.error('worker loop error', { error: error instanceof Error ? error.message : String(error) });
        await this.ctx.clock.sleep(this.pollIntervalMs, this.abort.signal).catch(() => undefined);
      }
    }
  }

  /** Reserve and process one batch. Exposed so tests can step deterministically. */
  async runOnce(): Promise<number> {
    const capacity = Math.max(0, this.concurrency - this.inFlight);
    if (capacity === 0) return 0;

    const jobs = await this.ctx.queue.reserve({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
      types: [EXECUTION_JOB],
      max: capacity,
    });
    if (jobs.length === 0) return 0;

    await Promise.all(jobs.map((job) => this.process(job)));
    return jobs.length;
  }

  private async process(job: Job): Promise<void> {
    this.inFlight += 1;
    const executionId = String(job.payload['executionId'] ?? '');
    const orgId = String(job.payload['orgId'] ?? '');
    const logger = this.logger.child({ executionId, jobId: job.id });
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    try {
      const execution = await this.ctx.store.executions.get(orgId, executionId);
      if (!execution) {
        logger.warn('job references a missing execution; dropping');
        await this.ctx.queue.ack(job.id, this.workerId);
        return;
      }
      if (isTerminal(execution.status)) {
        await this.ctx.queue.ack(job.id, this.workerId);
        return;
      }

      const leased = await this.ctx.store.executions.acquireLease(
        orgId,
        executionId,
        this.workerId,
        this.leaseMs,
        this.ctx.clock.now(),
      );
      if (!leased) {
        // Another worker holds it. Drop this job rather than duplicating work.
        logger.debug('execution is leased elsewhere; skipping');
        await this.ctx.queue.ack(job.id, this.workerId);
        return;
      }

      heartbeat = setInterval(() => {
        void Promise.all([
          this.ctx.store.executions.renewLease(orgId, executionId, this.workerId, this.leaseMs, this.ctx.clock.now()),
          this.ctx.queue.heartbeat(job.id, this.workerId, this.leaseMs),
        ]).catch((error: unknown) => {
          logger.warn('heartbeat failed', { error: error instanceof Error ? error.message : String(error) });
        });
      }, this.heartbeatMs);
      heartbeat.unref?.();

      const original = leased.replayOfExecutionId
        ? await this.ctx.store.executions.get(orgId, leased.replayOfExecutionId)
        : null;
      const strategy = leased.labels['replay_strategy'] === 'live-model' ? 'live-model' : 'recorded';
      const replaySource = original ? replaySourceFor(original, strategy) : undefined;

      const result = await this.engine.advance(leased, {
        workerId: this.workerId,
        signal: this.abort.signal,
        ...(replaySource ? { replaySource } : {}),
      });

      logger.info('execution advanced', { outcome: result.outcome, status: result.execution.status });
      await this.ctx.store.executions.releaseLease(orgId, executionId, this.workerId);
      await this.ctx.queue.ack(job.id, this.workerId);

      // A yield means the worker is shutting down mid-run; hand it straight back.
      if (result.outcome === 'yielded') await this.executions.enqueue(result.execution);
    } catch (error) {
      const agentError = AgentOSError.from(error);
      logger.error('execution failed in worker', { code: agentError.code, error: agentError.message });
      await this.ctx.store.executions.releaseLease(orgId, executionId, this.workerId).catch(() => undefined);
      await this.ctx.queue.nack(job.id, this.workerId, {
        error: agentError.message,
        retry: agentError.retryable,
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.inFlight -= 1;
    }
  }
}

export interface RecoveryOptions {
  intervalMs?: number;
  batchSize?: number;
  logger?: Logger;
}

/**
 * Finds work that was dropped on the floor: queue jobs whose worker stopped
 * heartbeating, and executions still marked running under an expired lease.
 */
export class RecoveryService {
  private readonly executions: ExecutionService;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly options: RecoveryOptions = {},
  ) {
    this.executions = new ExecutionService(ctx);
    this.logger = (options.logger ?? ctx.logger).child({ component: 'recovery' });
  }

  async sweep(): Promise<{ jobsReclaimed: number; executionsRecovered: number; approvalsExpired: number }> {
    const now = this.ctx.clock.now();
    const jobsReclaimed = await this.ctx.queue.reclaimExpired(now);

    const stale = await this.ctx.store.executions.findExpiredLeases(now, this.options.batchSize ?? 50);
    let executionsRecovered = 0;
    for (const execution of stale) {
      try {
        const requeued = await this.ctx.store.executions.update(execution.orgId, execution.id, {
          expectedStatus: ['running'],
          patch: {
            status: 'queued',
            lease: null,
            attempt: execution.attempt + 1,
            updatedAt: now,
          },
        });
        await this.executions.enqueue(requeued);
        executionsRecovered += 1;
        this.logger.warn('recovered execution from an expired lease', {
          executionId: execution.id,
          previousWorker: execution.lease?.workerId ?? null,
          attempt: requeued.attempt,
        });
      } catch (error) {
        this.logger.error('could not recover execution', {
          executionId: execution.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const approvalsExpired = await this.executions.expireApprovals();
    await this.ctx.store.idempotency.purge(now);

    return { jobsReclaimed, executionsRecovered, approvalsExpired };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger.error('recovery sweep failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }, this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
