import type { JsonValue } from '@agentos/core';
import type { AnyEvent, EventRecord } from './types.js';

export type TraceNodeKind = 'execution' | 'model' | 'tool' | 'memory' | 'approval' | 'event';
export type TraceNodeStatus = 'ok' | 'error' | 'pending' | 'denied' | 'waiting';

export interface TraceNode {
  id: string;
  kind: TraceNodeKind;
  name: string;
  status: TraceNodeStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  input: JsonValue | null;
  output: JsonValue | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  detail: string | null;
  children: TraceNode[];
  /** Sequence of the event that opened this node, for stable ordering. */
  seq: number;
}

export interface Trace {
  executionId: string;
  traceId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  nodes: TraceNode[];
  eventCount: number;
}

function node(partial: Partial<TraceNode> & Pick<TraceNode, 'id' | 'kind' | 'name' | 'startedAt' | 'seq'>): TraceNode {
  return {
    status: 'pending',
    endedAt: null,
    durationMs: null,
    input: null,
    output: null,
    inputTokens: null,
    outputTokens: null,
    costMicroUsd: null,
    detail: null,
    children: [],
    ...partial,
  };
}

/**
 * Rebuild an execution trace purely from its event log. Nothing is synthesised:
 * a node exists only because a real event produced it, and an unfinished node
 * stays `pending` rather than being given a plausible end time.
 */
export function buildTrace(events: AnyEvent[]): Trace {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const first = ordered[0];
  const nodes: TraceNode[] = [];
  const bySpan = new Map<string, TraceNode>();
  const byToolCall = new Map<string, TraceNode>();
  let endedAt: number | null = null;

  const openSpan = (event: EventRecord, n: TraceNode) => {
    nodes.push(n);
    if (event.spanId) bySpan.set(event.spanId, n);
  };

  for (const event of ordered) {
    switch (event.type) {
      case 'model.call_started': {
        const p = event.payload;
        openSpan(
          event,
          node({
            id: event.spanId ?? event.id,
            kind: 'model',
            name: `${p.provider}:${p.model}`,
            startedAt: event.at,
            seq: event.seq,
            input: { messages: p.messageCount, tools: p.toolCount },
          }),
        );
        break;
      }
      case 'model.call_succeeded': {
        const target = (event.spanId && bySpan.get(event.spanId)) || null;
        const p = event.payload;
        if (target) {
          target.status = 'ok';
          target.endedAt = event.at;
          target.durationMs = event.durationMs ?? event.at - target.startedAt;
          target.inputTokens = p.inputTokens;
          target.outputTokens = p.outputTokens;
          target.costMicroUsd = p.costMicroUsd;
          target.detail = `${p.finishReason}${p.toolCallCount > 0 ? ` · ${p.toolCallCount} tool call(s)` : ''}`;
        }
        break;
      }
      case 'model.call_failed': {
        const target = (event.spanId && bySpan.get(event.spanId)) || null;
        if (target) {
          target.status = 'error';
          target.endedAt = event.at;
          target.durationMs = event.durationMs ?? event.at - target.startedAt;
          target.detail = `${event.payload.code}: ${event.payload.message}`;
        }
        break;
      }
      case 'tool.started': {
        const p = event.payload;
        const n = node({
          id: p.toolCallId,
          kind: 'tool',
          name: p.toolName,
          startedAt: event.at,
          seq: event.seq,
          input: p.arguments,
        });
        nodes.push(n);
        byToolCall.set(p.toolCallId, n);
        break;
      }
      case 'tool.succeeded': {
        const target = byToolCall.get(event.payload.toolCallId);
        if (target) {
          target.status = 'ok';
          target.endedAt = event.at;
          target.durationMs = event.payload.durationMs;
          target.output = event.payload.output;
        }
        break;
      }
      case 'tool.failed': {
        const target = byToolCall.get(event.payload.toolCallId);
        if (target) {
          target.status = 'error';
          target.endedAt = event.at;
          target.durationMs = event.payload.durationMs;
          target.detail = `${event.payload.code}: ${event.payload.message}`;
        }
        break;
      }
      case 'tool.denied': {
        nodes.push(
          node({
            id: event.id,
            kind: 'tool',
            name: event.payload.toolName,
            startedAt: event.at,
            endedAt: event.at,
            durationMs: 0,
            seq: event.seq,
            status: 'denied',
            detail: event.payload.reason,
          }),
        );
        break;
      }
      case 'approval.requested': {
        nodes.push(
          node({
            id: event.payload.approvalId,
            kind: 'approval',
            name: `approval: ${event.payload.toolCall.name}`,
            startedAt: event.at,
            seq: event.seq,
            status: 'waiting',
            input: event.payload.toolCall.arguments,
            detail: event.payload.reason,
          }),
        );
        break;
      }
      case 'approval.approved':
      case 'approval.rejected':
      case 'approval.expired': {
        const target = nodes.find((n) => n.id === event.payload.approvalId);
        if (target) {
          target.status = event.type === 'approval.approved' ? 'ok' : 'denied';
          target.endedAt = event.at;
          target.durationMs = event.at - target.startedAt;
          target.detail = event.type.split('.')[1] ?? null;
        }
        break;
      }
      case 'memory.read': {
        nodes.push(
          node({
            id: event.id,
            kind: 'memory',
            name: `memory.read (${event.payload.scope})`,
            startedAt: event.at,
            endedAt: event.at,
            durationMs: event.durationMs ?? 0,
            seq: event.seq,
            status: 'ok',
            detail: `${event.payload.hits} hit(s)`,
          }),
        );
        break;
      }
      case 'memory.written': {
        nodes.push(
          node({
            id: event.id,
            kind: 'memory',
            name: `memory.write (${event.payload.scope})`,
            startedAt: event.at,
            endedAt: event.at,
            durationMs: 0,
            seq: event.seq,
            status: 'ok',
            detail: event.payload.key,
          }),
        );
        break;
      }
      case 'execution.completed':
      case 'execution.failed':
      case 'execution.cancelled':
        endedAt = event.at;
        break;
      default:
        break;
    }
  }

  const startedAt = first?.at ?? 0;
  return {
    executionId: first?.executionId ?? '',
    traceId: first?.traceId ?? '',
    startedAt,
    endedAt,
    durationMs: endedAt === null ? null : endedAt - startedAt,
    nodes: nodes.sort((a, b) => a.seq - b.seq),
    eventCount: ordered.length,
  };
}
