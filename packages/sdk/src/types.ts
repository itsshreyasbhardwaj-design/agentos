import type {
  AgentMetrics,
  AgentRecord,
  AgentSpec,
  AgentVersionRecord,
  ApprovalRecord,
  ExecutionRecord,
  JsonObject,
  JsonValue,
  ScheduleRecord,
  TaskRecord,
} from '@agentos/core';
import type { AnyEvent, Trace } from '@agentos/events';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
}

export interface CreateAgentRequest {
  slug: string;
  name: string;
  description?: string;
  spec: Partial<AgentSpec> & Pick<AgentSpec, 'model' | 'instructions'>;
  labels?: Record<string, string>;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  spec?: Partial<AgentSpec>;
  labels?: Record<string, string>;
}

export interface RunRequest {
  input: JsonValue;
  idempotencyKey?: string;
  labels?: Record<string, string>;
  versionId?: string;
  mode?: 'live' | 'demo';
}

export interface ListExecutionsQuery {
  agentId?: string;
  status?: string[];
  limit?: number;
  cursor?: string | null;
  since?: number;
  until?: number;
}

export interface DecideApprovalRequest {
  approve: boolean;
  note?: string;
  /** Edited arguments; the runtime uses these instead of the model's. */
  editedArguments?: JsonObject | null;
}

export interface ReplayRequest {
  strategy?: 'recorded' | 'live-model';
}

export interface ToolSummary {
  name: string;
  description: string;
  operations: string[];
  destructive: boolean;
  source: string;
  inputSchema: JsonObject;
}

export interface OrgOverview {
  executions: number;
  completed: number;
  failed: number;
  costMicroUsd: number;
  totalTokens: number;
  toolCalls: number;
  modelCalls: number;
  approvals: number;
}

export type {
  AgentMetrics,
  AgentRecord,
  AgentVersionRecord,
  AnyEvent,
  ApprovalRecord,
  ExecutionRecord,
  ScheduleRecord,
  TaskRecord,
  Trace,
};
