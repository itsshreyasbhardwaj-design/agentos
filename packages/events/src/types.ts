import type { JsonObject, JsonValue, ToolCall, ToolOperation, UsageTotals } from '@agentos/core';

/**
 * The canonical event vocabulary. Everything the dashboard shows is derived from
 * these records — there is no second, prettier source of truth.
 */
export const EVENT_TYPES = [
  'execution.created',
  'execution.queued',
  'execution.started',
  'execution.resumed',
  'execution.paused',
  'execution.continued',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'execution.lease_acquired',
  'execution.lease_expired',
  'execution.limit_exceeded',
  'model.call_started',
  'model.call_succeeded',
  'model.call_failed',
  'model.call_retried',
  'model.fallback_used',
  'model.circuit_opened',
  'tool.requested',
  'tool.denied',
  'tool.started',
  'tool.succeeded',
  'tool.failed',
  'tool.rate_limited',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.expired',
  'memory.read',
  'memory.written',
  'policy.evaluated',
  'security.alert',
  'task.created',
  'task.queued',
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'agent.message_sent',
  'agent.message_delivered',
  'schedule.fired',
  'webhook.received',
  'webhook.rejected',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventPayloads {
  'execution.created': { input: JsonValue; mode: string; trigger: JsonObject };
  'execution.queued': { jobId: string; runAt: number };
  'execution.started': { workerId: string; attempt: number };
  'execution.resumed': { workerId: string; from: string };
  'execution.paused': { reason: string };
  'execution.continued': { step: number };
  'execution.completed': { output: JsonValue; usage: UsageTotals; durationMs: number };
  'execution.failed': { code: string; message: string; retryable: boolean };
  'execution.cancelled': { by: string; reason: string };
  'execution.lease_acquired': { workerId: string; expiresAt: number };
  'execution.lease_expired': { workerId: string; reclaimedBy: string };
  'execution.limit_exceeded': { limit: string; configured: number; observed: number; action: string };
  'model.call_started': { provider: string; model: string; messageCount: number; toolCount: number };
  'model.call_succeeded': {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
    finishReason: string;
    toolCallCount: number;
  };
  'model.call_failed': { provider: string; model: string; code: string; message: string; retryable: boolean };
  'model.call_retried': { provider: string; model: string; attempt: number; delayMs: number; code: string };
  'model.fallback_used': { from: string; to: string; reason: string };
  'model.circuit_opened': { provider: string; model: string };
  'tool.requested': { toolCall: ToolCall };
  'tool.denied': { toolName: string; reason: string; ruleId: string | null };
  'tool.started': { toolCallId: string; toolName: string; arguments: JsonValue };
  'tool.succeeded': { toolCallId: string; toolName: string; output: JsonValue; durationMs: number };
  'tool.failed': { toolCallId: string; toolName: string; code: string; message: string; durationMs: number };
  'tool.rate_limited': { toolName: string; retryAfterMs: number; scope: string };
  'approval.requested': {
    approvalId: string;
    toolCall: ToolCall;
    reason: string;
    impact: string;
    operations: ToolOperation[];
    destructive: boolean;
  };
  'approval.approved': { approvalId: string; by: string; edited: boolean; note: string | null };
  'approval.rejected': { approvalId: string; by: string; note: string | null };
  'approval.expired': { approvalId: string };
  'memory.read': { scope: string; namespace: string; query: string; hits: number };
  'memory.written': { scope: string; namespace: string; key: string };
  'policy.evaluated': {
    subject: string;
    decision: 'allow' | 'deny' | 'require_approval';
    ruleId: string | null;
    reason: string;
  };
  'security.alert': {
    kind: 'prompt_injection' | 'exfiltration' | 'unauthorized_tool' | 'secret_in_output' | 'untrusted_instruction';
    severity: 'low' | 'medium' | 'high';
    detail: string;
    source: string;
  };
  'task.created': { title: string; dependsOn: string[] };
  'task.queued': { executionId: string };
  'task.started': { executionId: string };
  'task.completed': { output: JsonValue };
  'task.failed': { code: string; message: string };
  'task.cancelled': { by: string };
  'agent.message_sent': { messageId: string; toAgentId: string; kind: string };
  'agent.message_delivered': { messageId: string; toExecutionId: string };
  'schedule.fired': { scheduleId: string; executionId: string | null; firedFor: number };
  'webhook.received': { endpointId: string; dedupeKey: string; executionId: string | null };
  'webhook.rejected': { endpointId: string | null; reason: string };
}

export interface EventRecord<T extends EventType = EventType> {
  id: string;
  orgId: string;
  /** Monotonic within an execution; the ordering the trace view relies on. */
  seq: number;
  type: T;
  at: number;
  executionId: string | null;
  agentId: string | null;
  taskId: string | null;
  /** Correlates every event produced by one logical run, including replays. */
  traceId: string;
  spanId: string | null;
  parentSpanId: string | null;
  durationMs: number | null;
  payload: EventPayloads[T];
}

export type AnyEvent = { [T in EventType]: EventRecord<T> }[EventType];

export interface EventFilter {
  orgId?: string;
  executionId?: string;
  agentId?: string;
  taskId?: string;
  types?: EventType[];
  sinceSeq?: number;
}

export function matchesFilter(event: EventRecord, filter: EventFilter): boolean {
  if (filter.orgId && event.orgId !== filter.orgId) return false;
  if (filter.executionId && event.executionId !== filter.executionId) return false;
  if (filter.agentId && event.agentId !== filter.agentId) return false;
  if (filter.taskId && event.taskId !== filter.taskId) return false;
  if (filter.types && !filter.types.includes(event.type)) return false;
  if (filter.sinceSeq !== undefined && event.seq <= filter.sinceSeq) return false;
  return true;
}
