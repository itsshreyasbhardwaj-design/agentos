import { AgentOSError, type JsonValue } from '@agentos/core';
import type {
  AgentMetrics,
  AgentRecord,
  AgentVersionRecord,
  AnyEvent,
  ApiErrorBody,
  ApprovalRecord,
  CreateAgentRequest,
  DecideApprovalRequest,
  ExecutionRecord,
  ListExecutionsQuery,
  OrgOverview,
  Page,
  ReplayRequest,
  RunRequest,
  ScheduleRecord,
  TaskRecord,
  ToolSummary,
  Trace,
  UpdateAgentRequest,
} from './types.js';

export interface AgentOSClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extra headers, e.g. a tracing header. Never put credentials here. */
  headers?: Record<string, string>;
}

function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
    else search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/**
 * Typed client for the AgentOS REST API.
 *
 * Errors come back as {@link AgentOSError} with the server's code intact, so
 * callers can branch on `approval_required` or `limit_exceeded` rather than
 * parsing messages.
 */
export class AgentOSClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: AgentOSClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.doFetch = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
          ...this.options.headers,
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed: unknown = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const error = (parsed as ApiErrorBody | null)?.error;
        throw new AgentOSError(
          (error?.code ?? 'internal') as never,
          error?.message ?? `HTTP ${response.status}`,
          { details: error?.details ?? { status: response.status } },
        );
      }
      return parsed as T;
    } catch (error) {
      if (AgentOSError.is(error)) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AgentOSError('timeout', `request to ${path} timed out`);
      }
      throw new AgentOSError('provider_unavailable', `request to ${path} failed`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  readonly agents = {
    create: (request: CreateAgentRequest) => this.request<AgentRecord>('POST', '/v1/agents', request),
    list: (query: { limit?: number; cursor?: string | null; search?: string } = {}) =>
      this.request<Page<AgentRecord>>('GET', `/v1/agents${qs(query)}`),
    get: (agentRef: string) => this.request<AgentRecord>('GET', `/v1/agents/${encodeURIComponent(agentRef)}`),
    update: (agentRef: string, patch: UpdateAgentRequest) =>
      this.request<AgentRecord>('PATCH', `/v1/agents/${encodeURIComponent(agentRef)}`, patch),
    publish: (agentRef: string, options: { changelog?: string; force?: boolean } = {}) =>
      this.request<AgentVersionRecord>('POST', `/v1/agents/${encodeURIComponent(agentRef)}/publish`, options),
    rollback: (agentRef: string, versionId: string) =>
      this.request<AgentRecord>('POST', `/v1/agents/${encodeURIComponent(agentRef)}/rollback`, { versionId }),
    versions: (agentRef: string) =>
      this.request<AgentVersionRecord[]>('GET', `/v1/agents/${encodeURIComponent(agentRef)}/versions`),
    metrics: (agentRef: string, window: { since?: number; until?: number } = {}) =>
      this.request<AgentMetrics>('GET', `/v1/agents/${encodeURIComponent(agentRef)}/metrics${qs(window)}`),
    archive: (agentRef: string) =>
      this.request<{ archived: boolean }>('DELETE', `/v1/agents/${encodeURIComponent(agentRef)}`),
    /** Start a run. Returns immediately; the execution runs on a worker. */
    run: (agentRef: string, request: RunRequest) =>
      this.request<ExecutionRecord>(
        'POST',
        `/v1/agents/${encodeURIComponent(agentRef)}/run`,
        request,
        request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {},
      ),
  };

  readonly executions = {
    list: (query: ListExecutionsQuery = {}) =>
      this.request<Page<ExecutionRecord>>('GET', `/v1/executions${qs(query as Record<string, unknown>)}`),
    get: (executionId: string) => this.request<ExecutionRecord>('GET', `/v1/executions/${executionId}`),
    events: (executionId: string, query: { sinceSeq?: number; limit?: number } = {}) =>
      this.request<AnyEvent[]>('GET', `/v1/executions/${executionId}/events${qs(query)}`),
    trace: (executionId: string) => this.request<Trace>('GET', `/v1/executions/${executionId}/trace`),
    pause: (executionId: string, reason?: string) =>
      this.request<ExecutionRecord>('POST', `/v1/executions/${executionId}/pause`, { reason }),
    resume: (executionId: string) => this.request<ExecutionRecord>('POST', `/v1/executions/${executionId}/resume`),
    cancel: (executionId: string, reason?: string) =>
      this.request<ExecutionRecord>('POST', `/v1/executions/${executionId}/cancel`, { reason }),
    retry: (executionId: string) => this.request<ExecutionRecord>('POST', `/v1/executions/${executionId}/retry`),
    replay: (executionId: string, request: ReplayRequest = {}) =>
      this.request<ExecutionRecord>('POST', `/v1/executions/${executionId}/replay`, request),

    /** Poll until the execution leaves a non-terminal state. */
    async waitFor(
      this: void,
      client: AgentOSClient,
      executionId: string,
      options: { timeoutMs?: number; pollMs?: number; stopOnApproval?: boolean } = {},
    ): Promise<ExecutionRecord> {
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      const pollMs = options.pollMs ?? 500;
      for (;;) {
        const execution = await client.executions.get(executionId);
        const done = ['completed', 'failed', 'cancelled'].includes(execution.status);
        const blocked = options.stopOnApproval !== false && execution.status === 'awaiting_approval';
        if (done || blocked) return execution;
        if (Date.now() > deadline) {
          throw new AgentOSError('timeout', `execution ${executionId} did not finish in time`, {
            details: { status: execution.status },
          });
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };

  readonly approvals = {
    listPending: (query: { agentId?: string; limit?: number } = {}) =>
      this.request<Page<ApprovalRecord>>('GET', `/v1/approvals${qs(query)}`),
    get: (approvalId: string) => this.request<ApprovalRecord>('GET', `/v1/approvals/${approvalId}`),
    decide: (approvalId: string, decision: DecideApprovalRequest) =>
      this.request<{ approval: ApprovalRecord; execution: ExecutionRecord }>(
        'POST',
        `/v1/approvals/${approvalId}/decide`,
        decision,
      ),
    approve: (approvalId: string, note?: string) =>
      this.approvals.decide(approvalId, { approve: true, ...(note ? { note } : {}) }),
    reject: (approvalId: string, note?: string) =>
      this.approvals.decide(approvalId, { approve: false, ...(note ? { note } : {}) }),
  };

  readonly tasks = {
    create: (request: { agentRef: string; title: string; input: JsonValue; dependsOn?: string[] }) =>
      this.request<TaskRecord>('POST', '/v1/tasks', request),
    list: (query: { status?: string[]; limit?: number; cursor?: string | null } = {}) =>
      this.request<Page<TaskRecord>>('GET', `/v1/tasks${qs(query as Record<string, unknown>)}`),
    get: (taskId: string) => this.request<TaskRecord>('GET', `/v1/tasks/${taskId}`),
  };

  readonly schedules = {
    create: (request: {
      agentRef: string;
      name: string;
      kind: 'cron' | 'interval' | 'at';
      expression: string;
      timezone?: string;
      input?: JsonValue;
    }) => this.request<ScheduleRecord>('POST', '/v1/schedules', request),
    list: (query: { agentId?: string; limit?: number } = {}) =>
      this.request<Page<ScheduleRecord>>('GET', `/v1/schedules${qs(query)}`),
    setEnabled: (scheduleId: string, enabled: boolean) =>
      this.request<ScheduleRecord>('PATCH', `/v1/schedules/${scheduleId}`, { enabled }),
    delete: (scheduleId: string) => this.request<{ deleted: boolean }>('DELETE', `/v1/schedules/${scheduleId}`),
  };

  readonly tools = {
    list: () => this.request<ToolSummary[]>('GET', '/v1/tools'),
  };

  readonly metrics = {
    overview: (window: { since?: number; until?: number } = {}) =>
      this.request<OrgOverview>('GET', `/v1/metrics/overview${qs(window)}`),
    costByAgent: (window: { since?: number; until?: number } = {}) =>
      this.request<Array<{ agentId: string; costMicroUsd: number; executions: number }>>(
        'GET',
        `/v1/metrics/cost-by-agent${qs(window)}`,
      ),
    costByModel: (window: { since?: number; until?: number } = {}) =>
      this.request<Array<{ model: string; costMicroUsd: number; calls: number }>>(
        'GET',
        `/v1/metrics/cost-by-model${qs(window)}`,
      ),
    toolUsage: (window: { since?: number; until?: number } = {}) =>
      this.request<Array<{ tool: string; calls: number; failures: number; p95DurationMs: number }>>(
        'GET',
        `/v1/metrics/tool-usage${qs(window)}`,
      ),
  };

  readonly search = {
    query: (q: string, limit = 20) =>
      this.request<{ agents: AgentRecord[]; executions: ExecutionRecord[]; tasks: TaskRecord[] }>(
        'GET',
        `/v1/search${qs({ q, limit })}`,
      ),
  };

  health(): Promise<{ status: string; store: boolean; queue: Record<string, number> }> {
    return this.request('GET', '/healthz');
  }

  /**
   * Stream an execution's events over SSE. Yields each event as it is written,
   * so a caller can follow a long run without polling.
   */
  async *streamEvents(executionId: string, signal?: AbortSignal): AsyncGenerator<AnyEvent> {
    const response = await this.doFetch(`${this.baseUrl}/v1/executions/${executionId}/events/stream`, {
      headers: { authorization: `Bearer ${this.options.apiKey}`, accept: 'text/event-stream' },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) {
      throw new AgentOSError('provider_unavailable', `could not open the event stream (HTTP ${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload && payload !== '{}') yield JSON.parse(payload) as AnyEvent;
      }
    }
  }
}

export function createClient(options: AgentOSClientOptions): AgentOSClient {
  return new AgentOSClient(options);
}

export type { JsonValue };
