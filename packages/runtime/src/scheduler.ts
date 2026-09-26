import { err, newId, type JsonValue, type Logger, type Principal, type ScheduleRecord } from '@agentos/core';
import type { RuntimeContext } from './context.js';
import { nextRunAt } from './cron.js';
import { ExecutionService } from './execution-service.js';

export interface CreateScheduleInput {
  agentRef: string;
  name: string;
  kind: ScheduleRecord['kind'];
  expression: string;
  timezone?: string;
  input?: JsonValue;
  enabled?: boolean;
}

/**
 * Fires scheduled agent runs.
 *
 * Two safeguards make this safe to run on several nodes at once: a schedule is
 * claimed with a compare-and-set on its `nextRunAt`, and the execution it
 * creates carries an idempotency key derived from the firing instant. Either
 * one alone would prevent a duplicate run; together they also survive a crash
 * between the claim and the enqueue.
 */
export class Scheduler {
  private readonly executions: ExecutionService;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly options: { intervalMs?: number; batchSize?: number } = {},
  ) {
    this.executions = new ExecutionService(ctx);
    this.logger = ctx.logger.child({ component: 'scheduler' });
  }

  async create(principal: Principal, input: CreateScheduleInput): Promise<ScheduleRecord> {
    const agent = await this.ctx.store.agents.getBySlug(principal.orgId, input.agentRef)
      ?? await this.ctx.store.agents.get(principal.orgId, input.agentRef);
    if (!agent) throw err.notFound('agent', input.agentRef);

    const now = this.ctx.clock.now();
    const timezone = input.timezone ?? 'UTC';
    // Validates the expression as a side effect: an unparseable cron throws here
    // rather than silently never firing.
    const next = nextRunAt(input.kind, input.expression, now, timezone);

    return this.ctx.store.schedules.create({
      id: newId('schedule'),
      orgId: principal.orgId,
      agentId: agent.id,
      name: input.name,
      kind: input.kind,
      expression: input.expression,
      timezone,
      input: input.input ?? {},
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: next,
      createdBy: principal.userId,
    });
  }

  async setEnabled(principal: Principal, scheduleId: string, enabled: boolean): Promise<ScheduleRecord> {
    const schedule = await this.ctx.store.schedules.get(principal.orgId, scheduleId);
    if (!schedule) throw err.notFound('schedule', scheduleId);
    const now = this.ctx.clock.now();
    return this.ctx.store.schedules.update(principal.orgId, scheduleId, {
      enabled,
      updatedAt: now,
      // Re-arming a disabled schedule must not fire for every missed slot.
      nextRunAt: enabled ? nextRunAt(schedule.kind, schedule.expression, now, schedule.timezone) : null,
    });
  }

  /** Fire every schedule that is due. Returns how many runs were started. */
  async tick(): Promise<number> {
    const now = this.ctx.clock.now();
    const due = await this.ctx.store.schedules.due(now, this.options.batchSize ?? 100);
    let fired = 0;

    for (const schedule of due) {
      const firedFor = schedule.nextRunAt;
      if (firedFor === null) continue;
      const next = nextRunAt(schedule.kind, schedule.expression, now, schedule.timezone);

      const claimed = await this.ctx.store.schedules.claim(schedule.id, firedFor, next);
      if (!claimed) continue; // another scheduler won the race

      try {
        const principal = {
          userId: schedule.createdBy,
          orgId: schedule.orgId,
          role: 'developer' as const,
        };
        const execution = await this.executions.run(principal, {
          agentRef: schedule.agentId,
          input: schedule.input,
          trigger: { type: 'schedule', sourceId: schedule.id, actor: schedule.createdBy },
          // Same schedule + same slot can only ever produce one execution.
          idempotencyKey: `schedule:${schedule.id}:${firedFor}`,
          labels: { schedule: schedule.name },
        });
        fired += 1;
        this.logger.info('schedule fired', { scheduleId: schedule.id, executionId: execution.id, firedFor });
      } catch (error) {
        this.logger.error('schedule firing failed', {
          scheduleId: schedule.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return fired;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error('scheduler tick failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }, this.options.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
