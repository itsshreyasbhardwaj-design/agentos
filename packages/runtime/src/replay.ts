import {
  AgentOSError,
  emptyExecutionState,
  emptyUsage,
  newId,
  type ExecutionRecord,
  type JsonValue,
  type Message,
  type ToolCall,
} from '@agentos/core';
import type { RuntimeContext } from './context.js';

export interface RecordedTurn {
  provider: string;
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
}

export interface ReplaySource {
  /** The model's answer at this step in the original run, if there was one. */
  modelResponse(step: number): RecordedTurn | null;
}

/**
 * Replays an execution from the transcript the original run persisted.
 *
 * The messages are the exact assistant turns and tool results the first run
 * produced, so a replay reproduces the original decision path without buying
 * tokens again. A replay that runs past the recorded transcript stops rather
 * than inventing a continuation.
 */
export class MessageReplaySource implements ReplaySource {
  private readonly turns: RecordedTurn[];

  constructor(messages: Message[], provider = 'recorded', model = 'recorded') {
    this.turns = messages
      .filter((m): m is Extract<Message, { role: 'assistant' }> => m.role === 'assistant')
      .map((m) => ({ provider, model, content: m.content, toolCalls: m.toolCalls ?? [] }));
  }

  modelResponse(step: number): RecordedTurn | null {
    return this.turns[step - 1] ?? null;
  }

  get length(): number {
    return this.turns.length;
  }
}

/** Map every recorded tool call id to the output the original run observed. */
export function recordedToolOutputs(messages: Message[]): Record<string, JsonValue> {
  const outputs: Record<string, JsonValue> = {};
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    outputs[message.toolCallId] = message.content;
  }
  return outputs;
}

export interface CreateReplayOptions {
  userId: string | null;
  /**
   * `recorded` (default) reuses the original model answers — deterministic and
   * free. `live-model` re-asks the model with the same input, which costs money
   * and may diverge; tools are still never executed in either mode.
   */
  strategy?: 'recorded' | 'live-model';
  labels?: Record<string, string>;
}

/**
 * Create a replay execution.
 *
 * The replay is a new execution with `mode: 'replay'` and a link back to the
 * original — never a mutation of the original record. Side-effecting tools are
 * blocked by the baseline policy, and the engine serves recorded outputs
 * instead of calling them, so a replay cannot re-send an email or re-delete a
 * repository.
 */
export async function createReplayExecution(
  ctx: RuntimeContext,
  original: ExecutionRecord,
  options: CreateReplayOptions,
): Promise<ExecutionRecord> {
  if (original.mode === 'replay') {
    throw new AgentOSError('invalid_request', 'cannot replay a replay; replay the original execution instead', {
      details: { originalId: original.replayOfExecutionId },
    });
  }

  const now = ctx.clock.now();
  const state = emptyExecutionState();
  state.scratch = { __replayOutputs: recordedToolOutputs(original.state.messages) };

  const replay: ExecutionRecord = {
    id: newId('execution'),
    orgId: original.orgId,
    agentId: original.agentId,
    // Pinned to the exact version the original ran, not the current published one.
    agentVersionId: original.agentVersionId,
    versionNumber: original.versionNumber,
    status: 'queued',
    mode: 'replay',
    replayOfExecutionId: original.id,
    parentExecutionId: null,
    taskId: null,
    trigger: { type: 'replay', sourceId: original.id, actor: options.userId ?? 'system' },
    userId: options.userId,
    input: original.input,
    output: null,
    error: null,
    state,
    usage: emptyUsage(),
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
    lease: null,
    attempt: 0,
    idempotencyKey: null,
    labels: { ...options.labels, replay_of: original.id, replay_strategy: options.strategy ?? 'recorded' },
  };

  return ctx.store.executions.create(replay);
}

export function replaySourceFor(original: ExecutionRecord, strategy: 'recorded' | 'live-model'): ReplaySource | undefined {
  if (strategy === 'live-model') return undefined;
  return new MessageReplaySource(original.state.messages);
}
