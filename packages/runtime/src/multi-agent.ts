import {
  AgentOSError,
  err,
  isJsonObject,
  newId,
  type AgentMessageRecord,
  type ExecutionRecord,
  type JsonObject,
  type JsonValue,
  type Principal,
  type TaskRecord,
} from '@agentos/core';
import type { ToolDefinition } from '@agentos/tools';
import type { RuntimeContext } from './context.js';
import { ExecutionEngine } from './engine.js';
import { ExecutionService } from './execution-service.js';

export interface CreateTaskInput {
  agentRef: string;
  title: string;
  input: JsonValue;
  dependsOn?: string[];
  parentTaskId?: string | null;
  labels?: Record<string, string>;
}

/**
 * Task graph over agent executions.
 *
 * A task is the unit of intent; an execution is one attempt at it. Dependencies
 * are explicit, and a task only becomes runnable when every task it depends on
 * has completed — there is no implicit ordering by creation time.
 */
export class TaskService {
  private readonly executions: ExecutionService;

  constructor(private readonly ctx: RuntimeContext) {
    this.executions = new ExecutionService(ctx);
  }

  async create(principal: Principal, input: CreateTaskInput): Promise<TaskRecord> {
    const agent =
      (await this.ctx.store.agents.getBySlug(principal.orgId, input.agentRef)) ??
      (await this.ctx.store.agents.get(principal.orgId, input.agentRef));
    if (!agent) throw err.notFound('agent', input.agentRef);

    const dependsOn = input.dependsOn ?? [];
    for (const dependency of dependsOn) {
      const found = await this.ctx.store.tasks.get(principal.orgId, dependency);
      if (!found) throw err.invalid(`task depends on unknown task ${dependency}`);
    }

    const now = this.ctx.clock.now();
    const task = await this.ctx.store.tasks.create({
      id: newId('task'),
      orgId: principal.orgId,
      agentId: agent.id,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      status: dependsOn.length > 0 ? 'blocked' : 'created',
      input: input.input,
      output: null,
      error: null,
      dependsOn,
      executionId: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      createdBy: principal.userId,
      labels: input.labels ?? {},
    });

    if (task.status === 'created') await this.dispatch(principal, task);
    return task;
  }

  /** Turn a runnable task into a queued execution. */
  async dispatch(principal: Principal, task: TaskRecord): Promise<ExecutionRecord> {
    const execution = await this.executions.run(principal, {
      agentRef: task.agentId,
      input: task.input,
      taskId: task.id,
      trigger: { type: 'api', sourceId: task.id, actor: principal.userId },
      idempotencyKey: `task:${task.id}`,
      labels: { task: task.title },
    });
    await this.ctx.store.tasks.update(principal.orgId, task.id, {
      status: 'queued',
      executionId: execution.id,
      updatedAt: this.ctx.clock.now(),
    });
    return execution;
  }

  /**
   * Reconcile tasks against their executions: finish tasks whose run ended and
   * dispatch any that have become unblocked. Idempotent, so it is safe to call
   * on a timer.
   */
  async reconcile(orgId: string): Promise<{ completed: number; dispatched: number }> {
    const now = this.ctx.clock.now();
    let completed = 0;

    const active = await this.ctx.store.tasks.list(orgId, { status: ['queued', 'running'], limit: 200 });
    for (const task of active.items) {
      if (!task.executionId) continue;
      const execution = await this.ctx.store.executions.get(orgId, task.executionId);
      if (!execution) continue;

      if (execution.status === 'completed') {
        await this.ctx.store.tasks.update(orgId, task.id, {
          status: 'completed', output: execution.output, finishedAt: now, updatedAt: now,
        });
        completed += 1;
      } else if (execution.status === 'failed' || execution.status === 'cancelled') {
        await this.ctx.store.tasks.update(orgId, task.id, {
          status: execution.status === 'failed' ? 'failed' : 'cancelled',
          error: execution.error, finishedAt: now, updatedAt: now,
        });
        completed += 1;
      } else if (execution.status === 'running' && task.status !== 'running') {
        await this.ctx.store.tasks.update(orgId, task.id, { status: 'running', updatedAt: now });
      }
    }

    const unblocked = await this.ctx.store.tasks.findUnblocked(orgId, now);
    let dispatched = 0;
    for (const task of unblocked) {
      await this.dispatch({ userId: task.createdBy, orgId, role: 'developer' }, task);
      dispatched += 1;
    }

    return { completed, dispatched };
  }

  async send(principal: Principal, message: Omit<AgentMessageRecord, 'id' | 'createdAt' | 'status' | 'deliveredAt'>): Promise<AgentMessageRecord> {
    return this.ctx.store.messages.send({
      ...message,
      id: newId('message'),
      status: 'pending',
      createdAt: this.ctx.clock.now(),
      deliveredAt: null,
    });
  }
}

/** How deep a delegation chain may go before the runtime refuses. */
export const DEFAULT_MAX_DELEGATION_DEPTH = 3;

async function delegationDepth(ctx: RuntimeContext, orgId: string, executionId: string): Promise<number> {
  let depth = 0;
  let current = await ctx.store.executions.get(orgId, executionId);
  while (current?.parentExecutionId && depth < 32) {
    depth += 1;
    current = await ctx.store.executions.get(orgId, current.parentExecutionId);
  }
  return depth;
}

export interface DelegateToolOptions {
  maxDepth?: number;
}

/**
 * Lets one agent hand work to another.
 *
 * The child runs as its own execution with its own version, permissions, limits
 * and trace — delegation never widens what the child may do, and the parent
 * cannot borrow the child's permissions. Which agents may be delegated to is
 * declared in the parent's spec (`delegatesTo`) and enforced by the policy gate,
 * not by the model.
 */
export function createDelegateTool(ctx: RuntimeContext, options: DelegateToolOptions = {}): ToolDefinition {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;

  return {
    name: 'agent.delegate',
    description:
      'Hand a sub-task to another agent and wait for its answer. The sub-agent runs with its own ' +
      'permissions and limits. Returns its output, or its status if it needs human approval.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Slug of the agent to delegate to' },
        task: { type: 'string', description: 'What the sub-agent should do', maxLength: 8_000 },
        context: { type: 'object', description: 'Structured context for the sub-agent', additionalProperties: true },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
    operations: ['write'],
    destructive: false,
    idempotent: false,
    timeoutMs: 300_000,
    source: 'agent',
    describeImpact: (args) => `delegate to agent "${String(args['agent'])}"`,
    async handler(args, toolContext) {
      const targetSlug = String(args['agent']);
      const parent = await ctx.store.executions.get(toolContext.orgId, toolContext.executionId);
      if (!parent) throw err.notFound('execution', toolContext.executionId);

      const version = await ctx.store.agents.getVersion(toolContext.orgId, parent.agentVersionId);
      const allowed = version?.spec.delegatesTo ?? [];
      if (!allowed.includes(targetSlug)) {
        throw new AgentOSError(
          'policy_denied',
          `this agent may not delegate to "${targetSlug}" (allowed: ${allowed.join(', ') || 'none'})`,
        );
      }

      const depth = await delegationDepth(ctx, toolContext.orgId, toolContext.executionId);
      if (depth >= maxDepth) {
        throw new AgentOSError('limit_exceeded', `delegation depth limit of ${maxDepth} reached`);
      }

      const executions = new ExecutionService(ctx);
      const child = await executions.run(
        { userId: parent.userId ?? 'system', orgId: toolContext.orgId, role: 'developer' },
        {
          agentRef: targetSlug,
          input: {
            task: String(args['task']),
            context: isJsonObject(args['context']) ? args['context'] : {},
            delegatedBy: parent.agentId,
          },
          parentExecutionId: parent.id,
          taskId: parent.taskId,
          trigger: { type: 'agent', sourceId: parent.id, actor: parent.agentId },
          labels: { delegated_from: parent.id },
        },
      );

      // Run the child inline on this worker. It keeps the parent's tool call
      // synchronous while the child still gets its own record, events and
      // limits; if it suspends for approval, we report that instead of blocking.
      const engine = new ExecutionEngine(ctx);
      const result = await engine.advance(child, {
        workerId: `delegate:${parent.id}`,
        signal: toolContext.signal,
      });

      const summary: JsonObject = {
        agent: targetSlug,
        executionId: result.execution.id,
        status: result.execution.status,
        costMicroUsd: result.execution.usage.costMicroUsd,
      };

      if (result.outcome === 'completed') return { ...summary, output: result.execution.output };
      if (result.outcome === 'awaiting_approval') {
        return { ...summary, note: 'the sub-agent is waiting for human approval; its result is not available yet' };
      }
      return { ...summary, error: result.execution.error?.message ?? `sub-agent ${result.outcome}` };
    },
  };
}

/** Structured message passing between agents, with no free-form channel. */
export function createSendMessageTool(ctx: RuntimeContext): ToolDefinition {
  return {
    name: 'agent.send_message',
    description:
      'Send a structured message to another agent. Delivered to that agent’s inbox; it does not run the agent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Slug of the receiving agent' },
        kind: { enum: ['request', 'response', 'notification'], default: 'notification' },
        payload: { type: 'object', additionalProperties: true },
        correlationId: { type: 'string' },
      },
      required: ['to', 'payload'],
      additionalProperties: false,
    },
    operations: ['write'],
    destructive: false,
    idempotent: false,
    timeoutMs: 10_000,
    source: 'agent',
    describeImpact: (args) => `send a ${String(args['kind'] ?? 'notification')} to agent "${String(args['to'])}"`,
    async handler(args, toolContext) {
      const target = await ctx.store.agents.getBySlug(toolContext.orgId, String(args['to']));
      if (!target) throw err.notFound('agent', String(args['to']));
      const execution = await ctx.store.executions.get(toolContext.orgId, toolContext.executionId);

      const message = await ctx.store.messages.send({
        id: newId('message'),
        orgId: toolContext.orgId,
        taskId: execution?.taskId ?? null,
        fromAgentId: toolContext.agentId,
        fromExecutionId: toolContext.executionId,
        toAgentId: target.id,
        toExecutionId: null,
        kind: (String(args['kind'] ?? 'notification') as AgentMessageRecord['kind']),
        payload: isJsonObject(args['payload']) ? args['payload'] : {},
        status: 'pending',
        createdAt: ctx.clock.now(),
        deliveredAt: null,
        correlationId: args['correlationId'] === undefined ? null : String(args['correlationId']),
      });

      return { messageId: message.id, to: target.slug, status: message.status };
    },
  };
}
