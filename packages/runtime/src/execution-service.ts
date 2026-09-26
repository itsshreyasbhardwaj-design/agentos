import {
  AgentOSError,
  emptyExecutionState,
  emptyUsage,
  err,
  isTerminal,
  newId,
  type ApprovalRecord,
  type ExecutionRecord,
  type ExecutionTrigger,
  type JsonObject,
  type JsonValue,
  type Principal,
} from '@agentos/core';
import { EventEmitter } from '@agentos/events';
import type { RuntimeContext } from './context.js';
import { AgentService } from './agent-service.js';
import { createReplayExecution, type CreateReplayOptions } from './replay.js';

export const EXECUTION_JOB = 'execution.run';

export interface RunAgentInput {
  agentRef: string;
  input: JsonValue;
  trigger?: ExecutionTrigger;
  idempotencyKey?: string | null;
  labels?: Record<string, string>;
  taskId?: string | null;
  parentExecutionId?: string | null;
  /** Run against a specific version instead of the published one. */
  versionId?: string;
  mode?: 'live' | 'demo';
}

/**
 * Creates and controls executions.
 *
 * Nothing here runs an agent inline: `run` persists an execution and enqueues a
 * job. That is what keeps a long agent off the HTTP request lifecycle and what
 * makes a crashed worker recoverable rather than a lost run.
 */
export class ExecutionService {
  private readonly agents: AgentService;

  constructor(private readonly ctx: RuntimeContext) {
    this.agents = new AgentService(ctx);
  }

  async run(principal: Principal, input: RunAgentInput): Promise<ExecutionRecord> {
    const agent = await this.agents.getBySlugOrId(principal.orgId, input.agentRef);
    if (agent.archived) throw err.conflict(`agent ${agent.slug} is archived`);

    const version = input.versionId
      ? await this.ctx.store.agents.getVersion(principal.orgId, input.versionId)
      : await this.agents.publishedVersion(principal.orgId, agent);
    if (!version) throw err.notFound('agent version', input.versionId);

    if (input.idempotencyKey) {
      const existing = await this.ctx.store.executions.getByIdempotencyKey(principal.orgId, input.idempotencyKey);
      if (existing) return existing;
    }

    const now = this.ctx.clock.now();
    const execution = await this.ctx.store.executions.create({
      id: newId('execution'),
      orgId: principal.orgId,
      agentId: agent.id,
      agentVersionId: version.id,
      versionNumber: version.version,
      status: 'queued',
      mode: input.mode ?? 'live',
      replayOfExecutionId: null,
      parentExecutionId: input.parentExecutionId ?? null,
      taskId: input.taskId ?? null,
      trigger: input.trigger ?? { type: 'api', actor: principal.userId },
      userId: principal.userId,
      input: input.input,
      output: null,
      error: null,
      state: emptyExecutionState(),
      usage: emptyUsage(),
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      finishedAt: null,
      lease: null,
      attempt: 0,
      idempotencyKey: input.idempotencyKey ?? null,
      labels: input.labels ?? {},
    });

    await this.emit(execution, 'execution.created', {
      input: input.input,
      mode: execution.mode,
      trigger: execution.trigger as unknown as JsonObject,
    });
    await this.enqueue(execution);
    return execution;
  }

  /**
   * Hand an execution to a worker.
   *
   * Deliberately not deduplicated at the queue level: an execution is enqueued
   * again every time it wakes (resume, approval decided, lease recovered), and
   * any key stable enough to dedupe those would also collapse them into one.
   * Duplicate jobs are harmless — the execution lease admits exactly one worker
   * and the losers ack immediately — whereas a swallowed wake-up would strand
   * the run forever.
   */
  async enqueue(execution: ExecutionRecord, runAt?: number): Promise<void> {
    const job = await this.ctx.queue.enqueue({
      orgId: execution.orgId,
      type: EXECUTION_JOB,
      payload: { executionId: execution.id, orgId: execution.orgId },
      ...(runAt !== undefined ? { runAt } : {}),
    });
    await this.emit(execution, 'execution.queued', { jobId: job.id, runAt: job.runAt });
  }

  async get(orgId: string, executionId: string): Promise<ExecutionRecord> {
    const execution = await this.ctx.store.executions.get(orgId, executionId);
    if (!execution) throw err.notFound('execution', executionId);
    return execution;
  }

  async cancel(principal: Principal, executionId: string, reason = 'cancelled by user'): Promise<ExecutionRecord> {
    const execution = await this.get(principal.orgId, executionId);
    if (isTerminal(execution.status)) {
      throw err.conflict(`execution is already ${execution.status}`, { status: execution.status });
    }
    const cancelled = await this.ctx.store.executions.update(principal.orgId, executionId, {
      patch: {
        status: 'cancelled',
        finishedAt: this.ctx.clock.now(),
        updatedAt: this.ctx.clock.now(),
        lease: null,
      },
    });
    await this.emit(cancelled, 'execution.cancelled', { by: principal.userId, reason });
    return cancelled;
  }

  async pause(principal: Principal, executionId: string, reason = 'paused by user'): Promise<ExecutionRecord> {
    const execution = await this.get(principal.orgId, executionId);
    if (isTerminal(execution.status)) throw err.conflict(`execution is already ${execution.status}`);
    const paused = await this.ctx.store.executions.update(principal.orgId, executionId, {
      patch: { status: 'paused', updatedAt: this.ctx.clock.now() },
    });
    await this.emit(paused, 'execution.paused', { reason });
    return paused;
  }

  async resume(principal: Principal, executionId: string): Promise<ExecutionRecord> {
    const execution = await this.get(principal.orgId, executionId);
    if (execution.status !== 'paused' && execution.status !== 'awaiting_approval') {
      throw err.conflict(`only paused or awaiting_approval executions can be resumed (this one is ${execution.status})`);
    }
    const resumed = await this.ctx.store.executions.update(principal.orgId, executionId, {
      patch: { status: 'queued', updatedAt: this.ctx.clock.now() },
    });
    await this.enqueue(resumed);
    return resumed;
  }

  /**
   * Re-run a finished execution from the start with the same input. A retry is
   * a fresh execution: the original stays intact for comparison.
   */
  async retry(principal: Principal, executionId: string): Promise<ExecutionRecord> {
    const original = await this.get(principal.orgId, executionId);
    if (!isTerminal(original.status)) {
      throw err.conflict('only a finished execution can be retried');
    }
    return this.run(principal, {
      agentRef: original.agentId,
      input: original.input,
      versionId: original.agentVersionId,
      trigger: { type: 'api', sourceId: original.id, actor: principal.userId },
      labels: { ...original.labels, retry_of: original.id },
    });
  }

  async replay(principal: Principal, executionId: string, options: Partial<CreateReplayOptions> = {}): Promise<ExecutionRecord> {
    const original = await this.get(principal.orgId, executionId);
    const replay = await createReplayExecution(this.ctx, original, {
      userId: principal.userId,
      strategy: options.strategy ?? 'recorded',
      ...(options.labels ? { labels: options.labels } : {}),
    });
    await this.emit(replay, 'execution.created', {
      input: replay.input,
      mode: 'replay',
      trigger: replay.trigger as unknown as JsonObject,
    });
    await this.enqueue(replay);
    return replay;
  }

  // -------------------------------------------------------------------------
  // Human approval
  // -------------------------------------------------------------------------

  async listPendingApprovals(orgId: string, agentId?: string) {
    return this.ctx.store.approvals.listPending(orgId, agentId ? { agentId } : {});
  }

  async decideApproval(
    principal: Principal,
    approvalId: string,
    decision: { approve: boolean; note?: string; editedArguments?: JsonObject | null },
  ): Promise<{ approval: ApprovalRecord; execution: ExecutionRecord }> {
    const approval = await this.ctx.store.approvals.get(principal.orgId, approvalId);
    if (!approval) throw err.notFound('approval', approvalId);

    const decided = await this.ctx.store.approvals.decide(principal.orgId, approvalId, {
      status: decision.approve ? 'approved' : 'rejected',
      by: principal.userId,
      note: decision.note ?? null,
      editedArguments: decision.editedArguments ?? null,
      at: this.ctx.clock.now(),
    });

    const execution = await this.get(principal.orgId, approval.executionId);
    await this.emit(
      execution,
      decision.approve ? 'approval.approved' : 'approval.rejected',
      decision.approve
        ? { approvalId, by: principal.userId, edited: Boolean(decision.editedArguments), note: decision.note ?? null }
        : { approvalId, by: principal.userId, note: decision.note ?? null },
    );

    await this.ctx.store.audit.record({
      id: newId('audit'),
      orgId: principal.orgId,
      actorId: principal.userId,
      actorType: principal.apiKeyId ? 'api_key' : 'user',
      action: decision.approve ? 'approval.approved' : 'approval.rejected',
      resourceType: 'approval',
      resourceId: approvalId,
      at: this.ctx.clock.now(),
      metadata: { executionId: approval.executionId, tool: approval.toolCall.name },
      ip: null,
    });

    // Only wake the execution once no approval it is waiting on is still pending.
    const outstanding = await this.ctx.store.approvals.listForExecution(principal.orgId, approval.executionId);
    const stillPending = outstanding.some((a) => a.status === 'pending');
    let resumed = execution;
    if (!stillPending && execution.status === 'awaiting_approval') {
      resumed = await this.ctx.store.executions.update(principal.orgId, execution.id, {
        expectedStatus: ['awaiting_approval'],
        patch: { status: 'queued', updatedAt: this.ctx.clock.now() },
      });
      await this.enqueue(resumed);
    }

    return { approval: decided, execution: resumed };
  }

  /** Expire stale approval requests and fail the executions waiting on them. */
  async expireApprovals(): Promise<number> {
    const expired = await this.ctx.store.approvals.expireOverdue(this.ctx.clock.now());
    for (const approval of expired) {
      const execution = await this.ctx.store.executions.get(approval.orgId, approval.executionId);
      if (!execution || execution.status !== 'awaiting_approval') continue;
      await this.emit(execution, 'approval.expired', { approvalId: approval.id });
      const requeued = await this.ctx.store.executions.update(approval.orgId, execution.id, {
        expectedStatus: ['awaiting_approval'],
        patch: { status: 'queued', updatedAt: this.ctx.clock.now() },
      });
      await this.enqueue(requeued);
    }
    return expired.length;
  }

  private async emit(
    execution: ExecutionRecord,
    type: Parameters<EventEmitter['emit']>[0],
    payload: never | Record<string, unknown>,
  ): Promise<void> {
    const seq = await this.ctx.store.events.maxSeq(execution.orgId, execution.id);
    const emitter = new EventEmitter(
      {
        orgId: execution.orgId,
        executionId: execution.id,
        agentId: execution.agentId,
        taskId: execution.taskId,
        traceId: execution.id,
      },
      {
        sink: this.ctx.eventSink,
        bus: this.ctx.bus,
        clock: this.ctx.clock,
        redactor: this.ctx.redactor,
        startSeq: seq,
      },
    );
    await emitter.emit(type, payload as never);
  }
}

export function assertNotTerminal(execution: ExecutionRecord): void {
  if (isTerminal(execution.status)) {
    throw new AgentOSError('conflict', `execution ${execution.id} is already ${execution.status}`);
  }
}
