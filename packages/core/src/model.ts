import type { JsonObject, JsonValue } from './json.js';
import type { LimitSpec } from './limits.js';
import type { Message, ToolCall } from './messages.js';
import type { SecretRef } from './secrets.js';
import type { MicroUsd, UsageTotals } from './usage.js';

// ---------------------------------------------------------------------------
// Tenancy and access control
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

export const ROLE_RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export type Permission =
  | 'agent:read'
  | 'agent:write'
  | 'agent:publish'
  | 'agent:delete'
  | 'execution:read'
  | 'execution:run'
  | 'execution:control'
  | 'approval:decide'
  | 'policy:read'
  | 'policy:write'
  | 'secret:write'
  | 'member:manage'
  | 'org:manage';

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ['agent:read', 'execution:read', 'policy:read'],
  developer: [
    'agent:read',
    'agent:write',
    'agent:publish',
    'execution:read',
    'execution:run',
    'execution:control',
    'policy:read',
  ],
  admin: [
    'agent:read',
    'agent:write',
    'agent:publish',
    'agent:delete',
    'execution:read',
    'execution:run',
    'execution:control',
    'approval:decide',
    'policy:read',
    'policy:write',
    'secret:write',
    'member:manage',
  ],
  owner: [
    'agent:read',
    'agent:write',
    'agent:publish',
    'agent:delete',
    'execution:read',
    'execution:run',
    'execution:control',
    'approval:decide',
    'policy:read',
    'policy:write',
    'secret:write',
    'member:manage',
    'org:manage',
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  limitCeiling?: Partial<LimitSpec>;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

export interface Membership {
  orgId: string;
  userId: string;
  role: Role;
  createdAt: number;
}

/** The authenticated caller, already resolved to a single org + role. */
export interface Principal {
  userId: string;
  orgId: string;
  role: Role;
  /** Present when the caller authenticated with an API key rather than a session. */
  apiKeyId?: string;
  displayName?: string;
}

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export type TaskClass = 'default' | 'fast' | 'reasoning' | 'classification' | 'cheap';

export interface ModelSelector {
  /** Provider-qualified model id, e.g. `openrouter:anthropic/claude-sonnet-4`. */
  primary: string;
  fallbacks?: string[];
  /** Optional per-task-class overrides resolved by the router. */
  routes?: Partial<Record<TaskClass, string>>;
  temperature?: number;
  maxOutputTokens?: number;
}

export type MemoryScope = 'short_term' | 'long_term' | 'semantic' | 'episodic';

export interface MemorySpec {
  provider: string;
  scopes: MemoryScope[];
  /** Messages of short-term history replayed into the prompt. */
  shortTermWindow?: number;
  /** Semantic recall: how many items to retrieve per step. */
  recallLimit?: number;
  namespace?: string;
}

export type ToolOperation = 'read' | 'write' | 'delete' | 'network' | 'exec';

export interface PermissionSpec {
  /** Tool-name globs the agent may call. Empty means no tools at all. */
  allowedTools: string[];
  deniedTools?: string[];
  /** Hosts reachable by network-capable tools. Empty means no outbound network. */
  allowedDomains?: string[];
  allowedOperations?: ToolOperation[];
  /** Tool-name globs that always pause for a human decision. */
  requireApprovalFor?: string[];
  /** Per-tool call ceilings, keyed by tool-name glob. */
  maxCallsPerTool?: Record<string, number>;
}

export const EMPTY_PERMISSIONS: PermissionSpec = {
  allowedTools: [],
  deniedTools: [],
  allowedDomains: [],
  allowedOperations: [],
  requireApprovalFor: [],
  maxCallsPerTool: {},
};

export interface AgentSpec {
  model: ModelSelector;
  instructions: string;
  tools: string[];
  memory?: MemorySpec;
  permissions: PermissionSpec;
  limits: LimitSpec;
  /** Ids of policies attached to this agent, evaluated on top of org policies. */
  policies?: string[];
  /** Non-secret config plus secret references; never sent to a model. */
  env?: Record<string, string | SecretRef>;
  /** Sub-agents this agent may delegate to, by agent slug. */
  delegatesTo?: string[];
  outputSchema?: JsonObject;
}

export type AgentVersionStatus = 'published' | 'archived';

export interface AgentRecord {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string;
  /** Editable working copy. Running an agent always uses a published version. */
  draft: AgentSpec;
  publishedVersionId: string | null;
  latestVersionNumber: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  archived: boolean;
  labels: Record<string, string>;
}

export interface AgentVersionRecord {
  id: string;
  agentId: string;
  orgId: string;
  version: number;
  spec: AgentSpec;
  status: AgentVersionStatus;
  changelog: string;
  publishedAt: number;
  publishedBy: string;
  /** Hash of the spec — two identical publishes are detectable. */
  specHash: string;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TERMINAL_STATUSES: readonly ExecutionStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminal(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Legal execution state transitions. The store refuses anything not listed here,
 * so a stale worker cannot resurrect a cancelled run.
 */
export const EXECUTION_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['running', 'awaiting_approval', 'paused', 'completed', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'queued', 'cancelled', 'failed', 'paused'],
  paused: ['queued', 'running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export type ExecutionMode = 'live' | 'replay' | 'demo';

export type TriggerType = 'api' | 'schedule' | 'webhook' | 'event' | 'manual' | 'agent' | 'replay';

export interface ExecutionTrigger {
  type: TriggerType;
  /** Id of the schedule, webhook delivery, parent execution, etc. */
  sourceId?: string;
  actor?: string;
}

export interface ExecutionError {
  code: string;
  message: string;
  details?: JsonObject;
  retryable: boolean;
  at: number;
}

/** Everything needed to resume a run on a different worker after a crash. */
export interface ExecutionState {
  messages: Message[];
  step: number;
  /** Tool calls the model asked for that have not been resolved yet. */
  pendingToolCalls: ToolCall[];
  /** Results collected for the current step before it was interrupted. */
  completedToolCallIds: string[];
  pendingApprovalIds: string[];
  scratch: JsonObject;
  /** Per-tool call counters, for `maxCallsPerTool`. */
  toolCallCounts: Record<string, number>;
}

export function emptyExecutionState(): ExecutionState {
  return {
    messages: [],
    step: 0,
    pendingToolCalls: [],
    completedToolCallIds: [],
    pendingApprovalIds: [],
    scratch: {},
    toolCallCounts: {},
  };
}

export interface ExecutionLease {
  workerId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface ExecutionRecord {
  id: string;
  orgId: string;
  agentId: string;
  agentVersionId: string;
  versionNumber: number;
  status: ExecutionStatus;
  mode: ExecutionMode;
  /** Set when this run is a replay of an earlier execution. */
  replayOfExecutionId: string | null;
  parentExecutionId: string | null;
  taskId: string | null;
  trigger: ExecutionTrigger;
  userId: string | null;
  input: JsonValue;
  output: JsonValue | null;
  error: ExecutionError | null;
  state: ExecutionState;
  usage: UsageTotals;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  lease: ExecutionLease | null;
  attempt: number;
  idempotencyKey: string | null;
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Human approval
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRecord {
  id: string;
  orgId: string;
  executionId: string;
  agentId: string;
  toolCall: ToolCall;
  /** Why the runtime paused: which rule matched. */
  reason: string;
  ruleId: string | null;
  /** Human-readable statement of what will happen if approved. */
  impact: string;
  operations: ToolOperation[];
  destructive: boolean;
  status: ApprovalStatus;
  requestedAt: number;
  expiresAt: number | null;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionNote: string | null;
  /** Arguments as edited by the approver; the runtime uses these when present. */
  editedArguments: JsonObject | null;
}

// ---------------------------------------------------------------------------
// Tasks and agent-to-agent messaging
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'created'
  | 'blocked'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskRecord {
  id: string;
  orgId: string;
  agentId: string;
  parentTaskId: string | null;
  title: string;
  status: TaskStatus;
  input: JsonValue;
  output: JsonValue | null;
  error: ExecutionError | null;
  /** Task ids that must reach `completed` before this one may be queued. */
  dependsOn: string[];
  executionId: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  createdBy: string;
  labels: Record<string, string>;
}

export type AgentMessageStatus = 'pending' | 'delivered' | 'consumed' | 'failed';

/** Structured envelope for agent-to-agent communication. No free-form channel. */
export interface AgentMessageRecord {
  id: string;
  orgId: string;
  taskId: string | null;
  fromAgentId: string;
  fromExecutionId: string | null;
  toAgentId: string;
  toExecutionId: string | null;
  kind: 'request' | 'response' | 'notification';
  payload: JsonObject;
  status: AgentMessageStatus;
  createdAt: number;
  deliveredAt: number | null;
  correlationId: string | null;
}

// ---------------------------------------------------------------------------
// Scheduling and webhooks
// ---------------------------------------------------------------------------

export type ScheduleKind = 'cron' | 'interval' | 'at';

export interface ScheduleRecord {
  id: string;
  orgId: string;
  agentId: string;
  name: string;
  kind: ScheduleKind;
  /** Cron expression, interval in ms (as string), or ISO timestamp. */
  expression: string;
  timezone: string;
  input: JsonValue;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdBy: string;
}

export type WebhookProvider = 'github' | 'stripe' | 'custom';

export interface WebhookEndpointRecord {
  id: string;
  orgId: string;
  agentId: string;
  name: string;
  provider: WebhookProvider;
  /** Name of the secret holding the signing key. The key itself is never stored. */
  signingSecretName: string;
  enabled: boolean;
  /** Max clock skew accepted on a signed timestamp, in seconds. */
  toleranceSeconds: number;
  /** Max deliveries accepted per minute. */
  rateLimitPerMinute: number;
  createdAt: number;
  createdBy: string;
}

export interface WebhookDeliveryRecord {
  id: string;
  orgId: string;
  endpointId: string;
  /** Provider event id (or content hash) used to reject replays. */
  dedupeKey: string;
  receivedAt: number;
  accepted: boolean;
  rejectionReason: string | null;
  executionId: string | null;
}

// ---------------------------------------------------------------------------
// Secrets, API keys, audit
// ---------------------------------------------------------------------------

export interface SecretMetadata {
  id: string;
  orgId: string;
  name: string;
  /** Last 4 characters only, for recognition in the UI. */
  hint: string;
  createdAt: number;
  createdBy: string;
  lastUsedAt: number | null;
}

export interface ApiKeyRecord {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  /** SHA-256 of the key. The plaintext is shown once at creation and never stored. */
  hash: string;
  prefix: string;
  role: Role;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface AuditLogRecord {
  id: string;
  orgId: string;
  actorId: string;
  actorType: 'user' | 'api_key' | 'system' | 'agent';
  action: string;
  resourceType: string;
  resourceId: string;
  at: number;
  metadata: JsonObject;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

export interface AgentMetrics {
  agentId: string;
  windowStart: number;
  windowEnd: number;
  executions: number;
  completed: number;
  failed: number;
  cancelled: number;
  awaitingApproval: number;
  successRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalCostMicroUsd: MicroUsd;
  totalTokens: number;
  toolCalls: number;
  modelCalls: number;
  retries: number;
  approvals: number;
}
