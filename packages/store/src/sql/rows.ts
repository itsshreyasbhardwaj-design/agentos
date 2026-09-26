import type {
  AgentMessageRecord,
  AgentRecord,
  AgentVersionRecord,
  ApiKeyRecord,
  ApprovalRecord,
  AuditLogRecord,
  ExecutionRecord,
  JsonObject,
  Membership,
  Org,
  ScheduleRecord,
  SecretMetadata,
  TaskRecord,
  User,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from '@agentos/core';
import type { AnyEvent } from '@agentos/events';
import type { Policy } from '@agentos/policy';

type Row = Record<string, unknown>;

/** Postgres returns BIGINT as a string to avoid precision loss in drivers. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

export function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}

export function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export const toOrg = (r: Row): Org => ({
  id: str(r['id']),
  name: str(r['name']),
  slug: str(r['slug']),
  createdAt: num(r['created_at']),
  limitCeiling: json(r['limit_ceiling'], undefined),
});

export const toUser = (r: Row): User => ({
  id: str(r['id']),
  email: str(r['email']),
  name: str(r['name']),
  createdAt: num(r['created_at']),
});

export const toMembership = (r: Row): Membership => ({
  orgId: str(r['org_id']),
  userId: str(r['user_id']),
  role: str(r['role']) as Membership['role'],
  createdAt: num(r['created_at']),
});

export const toApiKey = (r: Row): ApiKeyRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  userId: str(r['user_id']),
  name: str(r['name']),
  hash: str(r['hash']),
  prefix: str(r['prefix']),
  role: str(r['role']) as ApiKeyRecord['role'],
  createdAt: num(r['created_at']),
  lastUsedAt: nullableNum(r['last_used_at']),
  revokedAt: nullableNum(r['revoked_at']),
});

export const toAgent = (r: Row): AgentRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  slug: str(r['slug']),
  name: str(r['name']),
  description: str(r['description']),
  draft: json(r['draft'], {} as AgentRecord['draft']),
  publishedVersionId: nullableStr(r['published_version_id']),
  latestVersionNumber: num(r['latest_version_number']),
  createdAt: num(r['created_at']),
  updatedAt: num(r['updated_at']),
  createdBy: str(r['created_by']),
  archived: Boolean(r['archived']),
  labels: json(r['labels'], {} as Record<string, string>),
});

export const toVersion = (r: Row): AgentVersionRecord => ({
  id: str(r['id']),
  agentId: str(r['agent_id']),
  orgId: str(r['org_id']),
  version: num(r['version']),
  spec: json(r['spec'], {} as AgentVersionRecord['spec']),
  status: str(r['status']) as AgentVersionRecord['status'],
  changelog: str(r['changelog']),
  publishedAt: num(r['published_at']),
  publishedBy: str(r['published_by']),
  specHash: str(r['spec_hash']),
});

export const toExecution = (r: Row): ExecutionRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  agentId: str(r['agent_id']),
  agentVersionId: str(r['agent_version_id']),
  versionNumber: num(r['version_number']),
  status: str(r['status']) as ExecutionRecord['status'],
  mode: str(r['mode']) as ExecutionRecord['mode'],
  replayOfExecutionId: nullableStr(r['replay_of_execution_id']),
  parentExecutionId: nullableStr(r['parent_execution_id']),
  taskId: nullableStr(r['task_id']),
  trigger: json(r['trigger'], { type: 'api' } as ExecutionRecord['trigger']),
  userId: nullableStr(r['user_id']),
  input: json(r['input'], null),
  output: json(r['output'], null),
  error: json(r['error'], null),
  state: json(r['state'], {} as ExecutionRecord['state']),
  usage: json(r['usage'], {} as ExecutionRecord['usage']),
  createdAt: num(r['created_at']),
  startedAt: nullableNum(r['started_at']),
  updatedAt: num(r['updated_at']),
  finishedAt: nullableNum(r['finished_at']),
  lease: json(r['lease'], null),
  attempt: num(r['attempt']),
  idempotencyKey: nullableStr(r['idempotency_key']),
  labels: json(r['labels'], {} as Record<string, string>),
});

export const toEvent = (r: Row): AnyEvent =>
  ({
    id: str(r['id']),
    orgId: str(r['org_id']),
    seq: num(r['seq']),
    type: str(r['type']),
    at: num(r['at']),
    executionId: nullableStr(r['execution_id']),
    agentId: nullableStr(r['agent_id']),
    taskId: nullableStr(r['task_id']),
    traceId: str(r['trace_id']),
    spanId: nullableStr(r['span_id']),
    parentSpanId: nullableStr(r['parent_span_id']),
    durationMs: nullableNum(r['duration_ms']),
    payload: json(r['payload'], {}),
  }) as AnyEvent;

export const toApproval = (r: Row): ApprovalRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  executionId: str(r['execution_id']),
  agentId: str(r['agent_id']),
  toolCall: json(r['tool_call'], { id: '', name: '', arguments: {} }),
  reason: str(r['reason']),
  ruleId: nullableStr(r['rule_id']),
  impact: str(r['impact']),
  operations: json(r['operations'], [] as ApprovalRecord['operations']),
  destructive: Boolean(r['destructive']),
  status: str(r['status']) as ApprovalRecord['status'],
  requestedAt: num(r['requested_at']),
  expiresAt: nullableNum(r['expires_at']),
  decidedAt: nullableNum(r['decided_at']),
  decidedBy: nullableStr(r['decided_by']),
  decisionNote: nullableStr(r['decision_note']),
  editedArguments: json(r['edited_arguments'], null as JsonObject | null),
});

export const toTask = (r: Row): TaskRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  agentId: str(r['agent_id']),
  parentTaskId: nullableStr(r['parent_task_id']),
  title: str(r['title']),
  status: str(r['status']) as TaskRecord['status'],
  input: json(r['input'], null),
  output: json(r['output'], null),
  error: json(r['error'], null),
  dependsOn: json(r['depends_on'], [] as string[]),
  executionId: nullableStr(r['execution_id']),
  createdAt: num(r['created_at']),
  updatedAt: num(r['updated_at']),
  finishedAt: nullableNum(r['finished_at']),
  createdBy: str(r['created_by']),
  labels: json(r['labels'], {} as Record<string, string>),
});

export const toMessage = (r: Row): AgentMessageRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  taskId: nullableStr(r['task_id']),
  fromAgentId: str(r['from_agent_id']),
  fromExecutionId: nullableStr(r['from_execution_id']),
  toAgentId: str(r['to_agent_id']),
  toExecutionId: nullableStr(r['to_execution_id']),
  kind: str(r['kind']) as AgentMessageRecord['kind'],
  payload: json(r['payload'], {} as JsonObject),
  status: str(r['status']) as AgentMessageRecord['status'],
  createdAt: num(r['created_at']),
  deliveredAt: nullableNum(r['delivered_at']),
  correlationId: nullableStr(r['correlation_id']),
});

export const toSchedule = (r: Row): ScheduleRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  agentId: str(r['agent_id']),
  name: str(r['name']),
  kind: str(r['kind']) as ScheduleRecord['kind'],
  expression: str(r['expression']),
  timezone: str(r['timezone']),
  input: json(r['input'], null),
  enabled: Boolean(r['enabled']),
  createdAt: num(r['created_at']),
  updatedAt: num(r['updated_at']),
  lastRunAt: nullableNum(r['last_run_at']),
  nextRunAt: nullableNum(r['next_run_at']),
  createdBy: str(r['created_by']),
});

export const toEndpoint = (r: Row): WebhookEndpointRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  agentId: str(r['agent_id']),
  name: str(r['name']),
  provider: str(r['provider']) as WebhookEndpointRecord['provider'],
  signingSecretName: str(r['signing_secret_name']),
  enabled: Boolean(r['enabled']),
  toleranceSeconds: num(r['tolerance_seconds']),
  rateLimitPerMinute: num(r['rate_limit_per_minute']),
  createdAt: num(r['created_at']),
  createdBy: str(r['created_by']),
});

export const toDelivery = (r: Row): WebhookDeliveryRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  endpointId: str(r['endpoint_id']),
  dedupeKey: str(r['dedupe_key']),
  receivedAt: num(r['received_at']),
  accepted: Boolean(r['accepted']),
  rejectionReason: nullableStr(r['rejection_reason']),
  executionId: nullableStr(r['execution_id']),
});

export const toPolicy = (r: Row): Policy => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  name: str(r['name']),
  description: str(r['description']),
  enabled: Boolean(r['enabled']),
  scope: str(r['scope']) as Policy['scope'],
  rules: json(r['rules'], [] as Policy['rules']),
  createdAt: num(r['created_at']),
  updatedAt: num(r['updated_at']),
});

export const toSecretMetadata = (r: Row): SecretMetadata => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  name: str(r['name']),
  hint: str(r['hint']),
  createdAt: num(r['created_at']),
  createdBy: str(r['created_by']),
  lastUsedAt: nullableNum(r['last_used_at']),
});

export const toAudit = (r: Row): AuditLogRecord => ({
  id: str(r['id']),
  orgId: str(r['org_id']),
  actorId: str(r['actor_id']),
  actorType: str(r['actor_type']) as AuditLogRecord['actorType'],
  action: str(r['action']),
  resourceType: str(r['resource_type']),
  resourceId: str(r['resource_id']),
  at: num(r['at']),
  metadata: json(r['metadata'], {} as JsonObject),
  ip: nullableStr(r['ip']),
});
