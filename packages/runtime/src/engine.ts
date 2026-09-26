import {
  addUsage,
  AgentOSError,
  anyHostMatch,
  assistantMessage,
  checkLimits,
  clampLimits,
  emptyExecutionState,
  isJsonObject,
  newId,
  toolMessage,
  validateSchema,
  type AgentVersionRecord,
  type ApprovalRecord,
  type ExecutionRecord,
  type ExecutionState,
  type JsonObject,
  type JsonValue,
  type LimitBreach,
  type Message,
  type ToolCall,
  type UsageTotals,
} from '@agentos/core';
import { EventEmitter } from '@agentos/events';
import { MemoryManager } from '@agentos/memory';
import type { Policy, PolicyRequest } from '@agentos/policy';
import type { ToolDefinition } from '@agentos/tools';
import { toolFacts, wrapUntrusted } from '@agentos/tools';
import type { RuntimeContext } from './context.js';
import { buildInitialMessages } from './prompt.js';
import type { ReplaySource } from './replay.js';

export interface AdvanceOptions {
  workerId: string;
  signal?: AbortSignal;
  /** Supplies recorded model responses and tool outputs during a replay. */
  replaySource?: ReplaySource;
}

export interface AdvanceResult {
  execution: ExecutionRecord;
  /** Why the engine handed control back. */
  outcome: 'completed' | 'failed' | 'awaiting_approval' | 'cancelled' | 'limit_exceeded' | 'yielded';
}

interface StepContext {
  execution: ExecutionRecord;
  version: AgentVersionRecord;
  policies: Policy[];
  emitter: EventEmitter;
  state: ExecutionState;
  usage: UsageTotals;
  tools: ToolDefinition[];
  startedAt: number;
}

/**
 * Executes an agent.
 *
 * Two properties drive the design:
 *
 *  1. **The model proposes; the runtime decides.** Every tool call is put
 *     through the policy engine before anything runs, using facts derived from
 *     the call's own arguments. A model that invents a tool name, widens a URL
 *     or ignores its instructions changes nothing about what is permitted.
 *
 *  2. **Progress is durable.** State is persisted after each transition and the
 *     execution is held under a renewable lease, so a worker that dies mid-run
 *     leaves a resumable execution rather than a lost one.
 */
export class ExecutionEngine {
  constructor(private readonly ctx: RuntimeContext) {}

  async advance(execution: ExecutionRecord, options: AdvanceOptions): Promise<AdvanceResult> {
    const { store, clock } = this.ctx;
    const version = await store.agents.getVersion(execution.orgId, execution.agentVersionId);
    if (!version) {
      return this.fail(execution, new AgentOSError('not_found', `agent version ${execution.agentVersionId} is missing`));
    }

    const agent = await store.agents.get(execution.orgId, execution.agentId);
    const org = await store.orgs.get(execution.orgId);
    const policies = await store.policies.forAgent(execution.orgId, version.spec.policies ?? []);
    const seq = await store.events.maxSeq(execution.orgId, execution.id);

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
        clock,
        redactor: this.ctx.redactor,
        startSeq: seq,
      },
    );

    const limits = clampLimits(version.spec.limits, org?.limitCeiling ?? {});
    const permissions = version.spec.permissions;
    const labels = agent?.labels ?? {};
    const slug = agent?.slug ?? execution.agentId;

    let current = execution;
    if (current.status === 'queued') {
      current = await store.executions.update(current.orgId, current.id, {
        expectedStatus: ['queued', 'paused', 'awaiting_approval'],
        patch: { status: 'running', startedAt: current.startedAt ?? clock.now(), updatedAt: clock.now() },
      });
      await emitter.emit('execution.started', { workerId: options.workerId, attempt: current.attempt });
    } else {
      await emitter.emit('execution.resumed', { workerId: options.workerId, from: current.status });
      current = await store.executions.update(current.orgId, current.id, {
        expectedStatus: ['running', 'awaiting_approval', 'paused'],
        patch: { status: 'running', updatedAt: clock.now() },
      });
    }

    const ctx: StepContext = {
      execution: current,
      version,
      policies,
      emitter,
      state: current.state.messages.length > 0 ? current.state : emptyExecutionState(),
      usage: current.usage,
      tools: this.ctx.registry.forAgent(permissions.allowedTools, permissions.deniedTools ?? []),
      startedAt: current.startedAt ?? clock.now(),
    };

    if (ctx.state.messages.length === 0) {
      const recalled = await this.recall(current, version);
      ctx.state.messages = buildInitialMessages({
        spec: version.spec,
        input: current.input,
        recalled,
        mode: current.mode === 'demo' ? 'demo' : current.mode,
      });
    }

    try {
      return await this.loop(ctx, { ...options, slug, labels, limits });
    } catch (error) {
      if (options.signal?.aborted) {
        // The worker is shutting down. Leave the run resumable rather than
        // marking it failed for a reason that has nothing to do with the agent.
        const yielded = await this.persist(ctx, 'running');
        return { execution: yielded, outcome: 'yielded' };
      }
      return this.fail(ctx.execution, AgentOSError.from(error), ctx);
    }
  }

  private async recall(execution: ExecutionRecord, version: AgentVersionRecord): Promise<string | undefined> {
    const spec = version.spec.memory;
    if (!spec || !spec.scopes.includes('semantic')) return undefined;
    const query = typeof execution.input === 'string' ? execution.input : JSON.stringify(execution.input ?? '');
    const hits = await this.ctx.memory.search(spec, {
      orgId: execution.orgId,
      namespace: spec.namespace ?? execution.agentId,
      scope: 'semantic',
      query,
      limit: spec.recallLimit ?? 5,
    });
    return hits.length > 0 ? MemoryManager.render(hits) : undefined;
  }

  private async loop(
    ctx: StepContext,
    options: AdvanceOptions & { slug: string; labels: Record<string, string>; limits: ReturnType<typeof clampLimits> },
  ): Promise<AdvanceResult> {
    const { clock } = this.ctx;

    for (;;) {
      if (options.signal?.aborted) {
        const yielded = await this.persist(ctx, 'running');
        return { execution: yielded, outcome: 'yielded' };
      }

      const elapsed = clock.now() - ctx.startedAt;
      // Project the step we are about to take: the limit is a ceiling on steps
      // performed, so it must stop us before the work, not after it.
      const breach = checkLimits(options.limits, ctx.usage, elapsed, {
        steps: ctx.state.pendingToolCalls.length > 0 ? 0 : 1,
      });
      if (breach) return this.onLimitBreach(ctx, breach, options.limits.onExceeded);

      // Resolve any tool calls left over from an interrupted step first, so a
      // resumed execution never re-runs work it already completed.
      if (ctx.state.pendingToolCalls.length > 0) {
        const result = await this.resolveToolCalls(ctx, options);
        if (result) return result;
        continue;
      }

      ctx.state.step += 1;
      ctx.usage = addUsage(ctx.usage, { steps: 1 });

      const response = await this.callModel(ctx, options);
      if ('suspended' in response) return response.suspended;

      ctx.state.messages.push(assistantMessage(response.content, response.toolCalls));

      if (response.toolCalls.length === 0) {
        return this.complete(ctx, response.content ?? '');
      }

      ctx.state.pendingToolCalls = response.toolCalls;
      ctx.state.completedToolCallIds = [];
      await this.persist(ctx, 'running');
      await ctx.emitter.emit('execution.continued', { step: ctx.state.step });
    }
  }

  private async callModel(
    ctx: StepContext,
    options: AdvanceOptions & { limits: ReturnType<typeof clampLimits> },
  ): Promise<{ content: string | null; toolCalls: ToolCall[] } | { suspended: AdvanceResult }> {
    const { router, registry, clock } = this.ctx;
    const spanId = newId('modelCall');
    const modelSpecs = registry.toModelSpecs(ctx.tools);
    const started = clock.now();

    // Replay serves the recorded response so the trace is reproduced exactly
    // and no tokens are bought a second time.
    if (ctx.execution.mode === 'replay' && options.replaySource) {
      const recorded = options.replaySource.modelResponse(ctx.state.step);
      if (recorded) {
        await ctx.emitter.emit(
          'model.call_succeeded',
          {
            provider: `${recorded.provider} (recorded)`,
            model: recorded.model,
            inputTokens: 0,
            outputTokens: 0,
            costMicroUsd: 0,
            finishReason: recorded.toolCalls.length > 0 ? 'tool_calls' : 'stop',
            toolCallCount: recorded.toolCalls.length,
          },
          { spanId, durationMs: 0 },
        );
        return { content: recorded.content, toolCalls: recorded.toolCalls };
      }
    }

    const budget = Math.max(0, options.limits.maxCostMicroUsd - ctx.usage.costMicroUsd);

    await ctx.emitter.emit(
      'model.call_started',
      {
        provider: ctx.version.spec.model.primary.split(':')[0] ?? 'unknown',
        model: ctx.version.spec.model.primary,
        messageCount: ctx.state.messages.length,
        toolCount: modelSpecs.length,
      },
      { spanId },
    );

    try {
      const response = await router.generate(
        ctx.version.spec.model,
        {
          messages: ctx.state.messages,
          ...(modelSpecs.length > 0 ? { tools: modelSpecs } : {}),
        },
        {
          signal: options.signal,
          offlineOnly: this.ctx.offlineOnly,
          budgetMicroUsd: options.limits.maxCostMicroUsd < 0 ? undefined : budget,
        },
      );

      ctx.usage = addUsage(ctx.usage, {
        modelCalls: 1,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.inputTokens + response.usage.outputTokens,
        costMicroUsd: response.costMicroUsd,
        retries: Math.max(0, response.attempts - 1),
      });

      await ctx.emitter.emit(
        'model.call_succeeded',
        {
          provider: response.provider,
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          costMicroUsd: response.costMicroUsd,
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
        },
        { spanId, durationMs: clock.now() - started },
      );

      if (response.fellBackFrom) {
        await ctx.emitter.emit('model.fallback_used', {
          from: response.fellBackFrom,
          to: `${response.provider}:${response.model}`,
          reason: 'primary exhausted',
        });
      }

      return { content: response.content, toolCalls: response.toolCalls };
    } catch (error) {
      const agentError = AgentOSError.from(error, 'provider_error');
      await ctx.emitter.emit(
        'model.call_failed',
        {
          provider: ctx.version.spec.model.primary.split(':')[0] ?? 'unknown',
          model: ctx.version.spec.model.primary,
          code: agentError.code,
          message: agentError.message,
          retryable: agentError.retryable,
        },
        { spanId, durationMs: clock.now() - started },
      );
      if (agentError.code === 'limit_exceeded') {
        const suspended = await this.onLimitBreach(
          ctx,
          { limit: 'maxCostMicroUsd', configured: options.limits.maxCostMicroUsd, observed: ctx.usage.costMicroUsd },
          options.limits.onExceeded,
        );
        return { suspended };
      }
      throw agentError;
    }
  }

  /** Run (or refuse) every pending tool call for the current step. */
  private async resolveToolCalls(
    ctx: StepContext,
    options: AdvanceOptions & { slug: string; labels: Record<string, string>; limits: ReturnType<typeof clampLimits> },
  ): Promise<AdvanceResult | null> {
    const { store, clock } = this.ctx;

    for (const call of [...ctx.state.pendingToolCalls]) {
      if (ctx.state.completedToolCallIds.includes(call.id)) continue;

      const definition = this.ctx.registry.find(call.name);
      if (!definition) {
        // An unknown tool is the model's mistake, not a runtime failure: tell it
        // so it can choose a real one.
        await ctx.emitter.emit('tool.denied', { toolName: call.name, reason: 'tool is not registered', ruleId: null });
        this.appendToolResult(ctx, call, `Error: tool "${call.name}" does not exist.`, true);
        continue;
      }

      const existingApproval = await this.findApproval(ctx, call);
      const decisionOutcome = await this.authorise(ctx, call, definition, options, existingApproval);

      if (decisionOutcome.kind === 'denied') {
        this.appendToolResult(ctx, call, `Error: ${decisionOutcome.reason}`, true);
        continue;
      }

      if (decisionOutcome.kind === 'awaiting_approval') {
        await this.persist(ctx, 'running');
        const suspended = await store.executions.update(ctx.execution.orgId, ctx.execution.id, {
          expectedStatus: ['running'],
          patch: {
            status: 'awaiting_approval',
            state: { ...ctx.state, pendingApprovalIds: [decisionOutcome.approval.id] },
            usage: ctx.usage,
            updatedAt: clock.now(),
          },
        });
        ctx.execution = suspended;
        return { execution: suspended, outcome: 'awaiting_approval' };
      }

      await this.runTool(ctx, call, definition, decisionOutcome.args, options);
    }

    ctx.state.pendingToolCalls = [];
    ctx.state.completedToolCallIds = [];
    ctx.state.pendingApprovalIds = [];
    await this.persist(ctx, 'running');
    return null;
  }

  private async findApproval(ctx: StepContext, call: ToolCall): Promise<ApprovalRecord | null> {
    if (ctx.state.pendingApprovalIds.length === 0) return null;
    const approvals = await this.ctx.store.approvals.listForExecution(ctx.execution.orgId, ctx.execution.id);
    return approvals.find((a) => a.toolCall.id === call.id) ?? null;
  }

  /**
   * Decide whether a call may run. Returns the (possibly human-edited)
   * arguments when it may.
   */
  private async authorise(
    ctx: StepContext,
    call: ToolCall,
    definition: ToolDefinition,
    options: { slug: string; labels: Record<string, string>; limits: ReturnType<typeof clampLimits> },
    existingApproval: ApprovalRecord | null,
  ): Promise<
    | { kind: 'allowed'; args: JsonObject }
    | { kind: 'denied'; reason: string }
    | { kind: 'awaiting_approval'; approval: ApprovalRecord }
  > {
    const { clock, store } = this.ctx;
    const args = isJsonObject(call.arguments) ? call.arguments : {};
    const facts = toolFacts(definition, args);

    const perTool = ctx.version.spec.permissions.maxCallsPerTool ?? {};
    const used = ctx.state.toolCallCounts[definition.name] ?? 0;
    for (const [pattern, max] of Object.entries(perTool)) {
      if (pattern === definition.name && used >= max) {
        return { kind: 'denied', reason: `tool ${definition.name} has reached its per-execution limit of ${max}` };
      }
    }

    const request: PolicyRequest = {
      kind: 'tool_call',
      orgId: ctx.execution.orgId,
      agentId: ctx.execution.agentId,
      agentSlug: options.slug,
      agentLabels: options.labels,
      executionId: ctx.execution.id,
      mode: ctx.execution.mode,
      usage: ctx.usage,
      limits: options.limits,
      elapsedMs: clock.now() - ctx.startedAt,
      tool: facts,
    };

    const decision = this.ctx.policy.evaluateWithPermissions(
      request,
      ctx.version.spec.permissions,
      ctx.policies,
      { delegatesTo: ctx.version.spec.delegatesTo ?? [] },
    );

    await ctx.emitter.emit('policy.evaluated', {
      subject: `tool:${definition.name}`,
      decision: decision.effect,
      ruleId: decision.ruleId,
      reason: decision.reason,
    });

    if (decision.effect === 'deny') {
      await ctx.emitter.emit('tool.denied', {
        toolName: definition.name,
        reason: decision.reason,
        ruleId: decision.ruleId,
      });
      return { kind: 'denied', reason: `${definition.name} was denied by policy: ${decision.reason}` };
    }

    if (decision.effect === 'allow') return { kind: 'allowed', args };

    // require_approval — reuse an existing decision if the human already made one.
    if (existingApproval) {
      if (existingApproval.status === 'approved') {
        ctx.usage = addUsage(ctx.usage, { approvals: 1 });
        return { kind: 'allowed', args: existingApproval.editedArguments ?? args };
      }
      if (existingApproval.status === 'rejected') {
        return {
          kind: 'denied',
          reason: `${definition.name} was rejected by ${existingApproval.decidedBy ?? 'a reviewer'}${
            existingApproval.decisionNote ? `: ${existingApproval.decisionNote}` : ''
          }`,
        };
      }
      if (existingApproval.status === 'expired') {
        return { kind: 'denied', reason: `the approval request for ${definition.name} expired` };
      }
      return { kind: 'awaiting_approval', approval: existingApproval };
    }

    const approval = await store.approvals.create({
      id: newId('approval'),
      orgId: ctx.execution.orgId,
      executionId: ctx.execution.id,
      agentId: ctx.execution.agentId,
      toolCall: { ...call, arguments: args },
      reason: decision.reason,
      ruleId: decision.ruleId,
      impact: definition.describeImpact?.(args) ?? `run ${definition.name}`,
      operations: definition.operations,
      destructive: definition.destructive,
      status: 'pending',
      requestedAt: clock.now(),
      expiresAt: this.ctx.approvalTtlMs === null ? null : clock.now() + this.ctx.approvalTtlMs,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      editedArguments: null,
    });

    await ctx.emitter.emit('approval.requested', {
      approvalId: approval.id,
      toolCall: approval.toolCall,
      reason: approval.reason,
      impact: approval.impact,
      operations: approval.operations,
      destructive: approval.destructive,
    });

    return { kind: 'awaiting_approval', approval };
  }

  private async runTool(
    ctx: StepContext,
    call: ToolCall,
    definition: ToolDefinition,
    args: JsonObject,
    options: { limits: ReturnType<typeof clampLimits> },
  ): Promise<void> {
    const { clock, executor } = this.ctx;
    const started = clock.now();

    await ctx.emitter.emit('tool.started', { toolCallId: call.id, toolName: definition.name, arguments: args });

    // Replay never executes a tool; it returns what the original run recorded.
    if (ctx.execution.mode === 'replay') {
      const recorded = this.replayedOutput(ctx, call);
      await ctx.emitter.emit('tool.succeeded', {
        toolCallId: call.id,
        toolName: definition.name,
        output: recorded,
        durationMs: 0,
      });
      ctx.usage = addUsage(ctx.usage, { toolCalls: 1 });
      ctx.state.toolCallCounts[definition.name] = (ctx.state.toolCallCounts[definition.name] ?? 0) + 1;
      this.appendToolResult(ctx, call, recorded, false);
      return;
    }

    const allowedDomains = ctx.version.spec.permissions.allowedDomains ?? [];
    const remainingMs = Math.max(1_000, options.limits.maxDurationMs - (clock.now() - ctx.startedAt));

    try {
      const result = await executor.execute(
        { ...call, arguments: args },
        {
          orgId: ctx.execution.orgId,
          agentId: ctx.execution.agentId,
          executionId: ctx.execution.id,
          secrets: this.ctx.secrets,
          redactor: this.ctx.redactor,
          // Host checks route through the same allow-list the policy gate uses,
          // so a redirect cannot reach a host policy would have refused.
          isHostAllowed: (host) => anyHostMatch(allowedDomains, host),
          timeoutMs: Math.min(definition.timeoutMs, remainingMs),
          logger: this.ctx.logger,
        },
      );

      ctx.usage = addUsage(ctx.usage, { toolCalls: 1 });
      ctx.state.toolCallCounts[definition.name] = (ctx.state.toolCallCounts[definition.name] ?? 0) + 1;

      for (const warning of result.warnings) {
        if (warning.kind === 'prompt_injection' || warning.kind === 'secret_in_output') {
          await ctx.emitter.emit('security.alert', {
            kind: warning.kind === 'secret_in_output' ? 'secret_in_output' : 'prompt_injection',
            severity: warning.severity,
            detail: warning.detail,
            source: `tool:${definition.name}`,
          });
        }
      }

      await ctx.emitter.emit('tool.succeeded', {
        toolCallId: call.id,
        toolName: definition.name,
        output: result.output,
        durationMs: result.durationMs,
      });

      const flagged = result.warnings.some((w) => w.kind === 'prompt_injection');
      this.appendToolResult(ctx, call, result.output, false, flagged);
    } catch (error) {
      const agentError = AgentOSError.from(error, 'tool_error');
      ctx.usage = addUsage(ctx.usage, { toolCalls: 1 });
      await ctx.emitter.emit('tool.failed', {
        toolCallId: call.id,
        toolName: definition.name,
        code: agentError.code,
        message: agentError.message,
        durationMs: clock.now() - started,
      });
      // A failing tool is information for the model, not a dead execution.
      this.appendToolResult(ctx, call, `Error (${agentError.code}): ${agentError.message}`, true);
    }
  }

  private replayedOutput(ctx: StepContext, call: ToolCall): JsonValue {
    const source = (ctx.state.scratch['__replayOutputs'] ?? {}) as Record<string, JsonValue>;
    return (
      source[call.id] ?? `[replay] no recorded output for ${call.name}; the original run did not reach this call.`
    );
  }

  private appendToolResult(
    ctx: StepContext,
    call: ToolCall,
    output: JsonValue,
    isError: boolean,
    flagged = false,
  ): void {
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    ctx.state.messages.push(
      toolMessage(call, isError ? text : wrapUntrusted(call.name, text, flagged), {
        isError,
        trust: 'untrusted',
      }),
    );
    ctx.state.completedToolCallIds.push(call.id);
  }

  private async onLimitBreach(
    ctx: StepContext,
    breach: LimitBreach,
    action: 'terminate' | 'pause',
  ): Promise<AdvanceResult> {
    const { clock, store } = this.ctx;
    await ctx.emitter.emit('execution.limit_exceeded', {
      limit: breach.limit,
      configured: breach.configured,
      observed: breach.observed,
      action,
    });

    if (action === 'pause') {
      const paused = await store.executions.update(ctx.execution.orgId, ctx.execution.id, {
        patch: { status: 'paused', state: ctx.state, usage: ctx.usage, updatedAt: clock.now() },
      });
      await ctx.emitter.emit('execution.paused', { reason: `limit ${breach.limit} reached` });
      return { execution: paused, outcome: 'limit_exceeded' };
    }

    return this.fail(
      ctx.execution,
      new AgentOSError(
        'limit_exceeded',
        `execution stopped: ${breach.limit} limit of ${breach.configured} reached (observed ${breach.observed})`,
        { details: { ...breach }, retryable: false },
      ),
      ctx,
    );
  }

  private async complete(ctx: StepContext, content: string): Promise<AdvanceResult> {
    const { clock, store } = this.ctx;
    let output: JsonValue = content;

    const schema = ctx.version.spec.outputSchema;
    if (schema) {
      try {
        const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\n?|```$/g, '')) as JsonValue;
        const validation = validateSchema(parsed, schema as never);
        output = validation.valid
          ? parsed
          : { _schemaValid: false, _errors: validation.errors.map((e) => `${e.path}: ${e.message}`), raw: content };
      } catch {
        // Record the mismatch instead of discarding the answer or pretending.
        output = { _schemaValid: false, _errors: ['final answer was not valid JSON'], raw: content };
      }
    }

    await this.writeMemory(ctx, content);

    const finished = await store.executions.update(ctx.execution.orgId, ctx.execution.id, {
      expectedStatus: ['running'],
      patch: {
        status: 'completed',
        output,
        state: ctx.state,
        usage: ctx.usage,
        finishedAt: clock.now(),
        updatedAt: clock.now(),
        lease: null,
      },
    });

    await ctx.emitter.emit('execution.completed', {
      output,
      usage: ctx.usage,
      durationMs: clock.now() - ctx.startedAt,
    });
    return { execution: finished, outcome: 'completed' };
  }

  private async writeMemory(ctx: StepContext, content: string): Promise<void> {
    const spec = ctx.version.spec.memory;
    if (!spec || !spec.scopes.includes('episodic') || ctx.execution.mode === 'replay') return;
    const namespace = spec.namespace ?? ctx.execution.agentId;
    await this.ctx.memory.write(spec, {
      orgId: ctx.execution.orgId,
      agentId: ctx.execution.agentId,
      namespace,
      scope: 'episodic',
      content: `Task: ${JSON.stringify(ctx.execution.input)}\nOutcome: ${content.slice(0, 1_000)}`,
      sourceExecutionId: ctx.execution.id,
    });
    await ctx.emitter.emit('memory.written', { scope: 'episodic', namespace, key: ctx.execution.id });
  }

  private async fail(
    execution: ExecutionRecord,
    error: AgentOSError,
    ctx?: StepContext,
  ): Promise<AdvanceResult> {
    const { clock, store } = this.ctx;
    const failed = await store.executions.update(execution.orgId, execution.id, {
      patch: {
        status: 'failed',
        error: {
          code: error.code,
          message: error.message,
          details: error.details as JsonObject,
          retryable: error.retryable,
          at: clock.now(),
        },
        ...(ctx ? { state: ctx.state, usage: ctx.usage } : {}),
        finishedAt: clock.now(),
        updatedAt: clock.now(),
        lease: null,
      },
    });
    await ctx?.emitter.emit('execution.failed', {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
    return { execution: failed, outcome: 'failed' };
  }

  private async persist(ctx: StepContext, status: ExecutionRecord['status']): Promise<ExecutionRecord> {
    const updated = await this.ctx.store.executions.update(ctx.execution.orgId, ctx.execution.id, {
      patch: { status, state: ctx.state, usage: ctx.usage, updatedAt: this.ctx.clock.now() },
    });
    ctx.execution = updated;
    return updated;
  }
}

export function messagesOf(state: ExecutionState): Message[] {
  return state.messages;
}
