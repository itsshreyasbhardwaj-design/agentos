import type {
  AgentMessageRecord,
  AgentMetrics,
  AgentRecord,
  AgentVersionRecord,
  ApiKeyRecord,
  ApprovalRecord,
  ApprovalStatus,
  AuditLogRecord,
  ExecutionRecord,
  ExecutionStatus,
  JsonObject,
  JsonValue,
  Membership,
  Org,
  Role,
  ScheduleRecord,
  SecretMetadata,
  TaskRecord,
  TaskStatus,
  User,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from '@agentos/core';
import type { AnyEvent, EventType } from '@agentos/events';
import type { Policy } from '@agentos/policy';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageRequest {
  limit?: number;
  /** Opaque cursor; ids are time-sortable so this is just the last id seen. */
  cursor?: string | null;
}

export interface OrgRepo {
  create(org: Org): Promise<Org>;
  get(id: string): Promise<Org | null>;
  getBySlug(slug: string): Promise<Org | null>;
  list(): Promise<Org[]>;
  update(id: string, patch: Partial<Org>): Promise<Org>;
}

export interface UserRepo {
  upsert(user: User): Promise<User>;
  get(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  addMember(membership: Membership): Promise<Membership>;
  removeMember(orgId: string, userId: string): Promise<boolean>;
  membership(orgId: string, userId: string): Promise<Membership | null>;
  membershipsFor(userId: string): Promise<Membership[]>;
  members(orgId: string): Promise<Array<Membership & { user: User }>>;
  setRole(orgId: string, userId: string, role: Role): Promise<Membership>;
}

export interface ApiKeyRepo {
  create(key: ApiKeyRecord): Promise<ApiKeyRecord>;
  getByHash(hash: string): Promise<ApiKeyRecord | null>;
  list(orgId: string): Promise<ApiKeyRecord[]>;
  revoke(orgId: string, id: string, at: number): Promise<boolean>;
  touch(id: string, at: number): Promise<void>;
}

export interface AgentListFilter extends PageRequest {
  includeArchived?: boolean;
  search?: string;
  labels?: Record<string, string>;
}

export interface AgentRepo {
  create(agent: AgentRecord): Promise<AgentRecord>;
  get(orgId: string, id: string): Promise<AgentRecord | null>;
  getBySlug(orgId: string, slug: string): Promise<AgentRecord | null>;
  list(orgId: string, filter?: AgentListFilter): Promise<Page<AgentRecord>>;
  update(orgId: string, id: string, patch: Partial<AgentRecord>): Promise<AgentRecord>;
  archive(orgId: string, id: string): Promise<boolean>;
  createVersion(version: AgentVersionRecord): Promise<AgentVersionRecord>;
  getVersion(orgId: string, versionId: string): Promise<AgentVersionRecord | null>;
  listVersions(orgId: string, agentId: string): Promise<AgentVersionRecord[]>;
}

export interface ExecutionListFilter extends PageRequest {
  agentId?: string;
  status?: ExecutionStatus[];
  mode?: string;
  taskId?: string;
  since?: number;
  until?: number;
  /** Restrict to executions triggered by a given user. */
  userId?: string;
}

export interface ExecutionUpdate {
  /** Refuse the write unless the row is still in one of these statuses. */
  expectedStatus?: ExecutionStatus[];
  patch: Partial<ExecutionRecord>;
}

export interface ExecutionRepo {
  create(execution: ExecutionRecord): Promise<ExecutionRecord>;
  get(orgId: string, id: string): Promise<ExecutionRecord | null>;
  getByIdempotencyKey(orgId: string, key: string): Promise<ExecutionRecord | null>;
  list(orgId: string, filter?: ExecutionListFilter): Promise<Page<ExecutionRecord>>;
  /** Conditional update. Throws `state_invalid` when the guard fails. */
  update(orgId: string, id: string, update: ExecutionUpdate): Promise<ExecutionRecord>;
  /** Atomically take or renew the worker lease. Returns null if already held. */
  acquireLease(orgId: string, id: string, workerId: string, leaseMs: number, now: number): Promise<ExecutionRecord | null>;
  renewLease(orgId: string, id: string, workerId: string, leaseMs: number, now: number): Promise<boolean>;
  releaseLease(orgId: string, id: string, workerId: string): Promise<boolean>;
  /** Executions whose worker stopped heartbeating; candidates for recovery. */
  findExpiredLeases(now: number, limit?: number): Promise<ExecutionRecord[]>;
  countByStatus(orgId: string, agentId?: string): Promise<Record<ExecutionStatus, number>>;
}

export interface EventListFilter extends PageRequest {
  types?: EventType[];
  sinceSeq?: number;
}

export interface EventRepo {
  append(events: AnyEvent[]): Promise<void>;
  listForExecution(orgId: string, executionId: string, filter?: EventListFilter): Promise<AnyEvent[]>;
  listForOrg(orgId: string, filter?: EventListFilter & { agentId?: string }): Promise<Page<AnyEvent>>;
  maxSeq(orgId: string, executionId: string): Promise<number>;
}

export interface ApprovalRepo {
  create(approval: ApprovalRecord): Promise<ApprovalRecord>;
  get(orgId: string, id: string): Promise<ApprovalRecord | null>;
  listPending(orgId: string, filter?: PageRequest & { agentId?: string }): Promise<Page<ApprovalRecord>>;
  listForExecution(orgId: string, executionId: string): Promise<ApprovalRecord[]>;
  /** Decide a pending approval. Fails if it is no longer pending. */
  decide(
    orgId: string,
    id: string,
    decision: { status: Exclude<ApprovalStatus, 'pending'>; by: string; note?: string | null; editedArguments?: JsonObject | null; at: number },
  ): Promise<ApprovalRecord>;
  expireOverdue(now: number): Promise<ApprovalRecord[]>;
}

export interface TaskRepo {
  create(task: TaskRecord): Promise<TaskRecord>;
  get(orgId: string, id: string): Promise<TaskRecord | null>;
  list(orgId: string, filter?: PageRequest & { status?: TaskStatus[]; agentId?: string; parentTaskId?: string }): Promise<Page<TaskRecord>>;
  update(orgId: string, id: string, patch: Partial<TaskRecord>): Promise<TaskRecord>;
  /** Tasks whose dependencies have all completed and which are still blocked. */
  findUnblocked(orgId: string, now: number): Promise<TaskRecord[]>;
}

export interface AgentMessageRepo {
  send(message: AgentMessageRecord): Promise<AgentMessageRecord>;
  get(orgId: string, id: string): Promise<AgentMessageRecord | null>;
  inbox(orgId: string, agentId: string, filter?: PageRequest): Promise<AgentMessageRecord[]>;
  markDelivered(orgId: string, id: string, executionId: string, at: number): Promise<AgentMessageRecord>;
  listForTask(orgId: string, taskId: string): Promise<AgentMessageRecord[]>;
}

export interface ScheduleRepo {
  create(schedule: ScheduleRecord): Promise<ScheduleRecord>;
  get(orgId: string, id: string): Promise<ScheduleRecord | null>;
  list(orgId: string, filter?: PageRequest & { agentId?: string; enabled?: boolean }): Promise<Page<ScheduleRecord>>;
  update(orgId: string, id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord>;
  delete(orgId: string, id: string): Promise<boolean>;
  /** Enabled schedules whose nextRunAt has arrived, across all orgs. */
  due(now: number, limit?: number): Promise<ScheduleRecord[]>;
  /** Atomically claim a firing so two schedulers cannot double-fire. */
  claim(id: string, firedFor: number, nextRunAt: number | null): Promise<boolean>;
}

export interface WebhookRepo {
  createEndpoint(endpoint: WebhookEndpointRecord): Promise<WebhookEndpointRecord>;
  getEndpoint(orgId: string, id: string): Promise<WebhookEndpointRecord | null>;
  listEndpoints(orgId: string, filter?: PageRequest & { agentId?: string }): Promise<Page<WebhookEndpointRecord>>;
  deleteEndpoint(orgId: string, id: string): Promise<boolean>;
  /** Records a delivery. Returns null when the dedupe key was already seen. */
  recordDelivery(delivery: WebhookDeliveryRecord): Promise<WebhookDeliveryRecord | null>;
  listDeliveries(orgId: string, endpointId: string, filter?: PageRequest): Promise<Page<WebhookDeliveryRecord>>;
}

export interface PolicyRepo {
  create(policy: Policy): Promise<Policy>;
  get(orgId: string, id: string): Promise<Policy | null>;
  list(orgId: string): Promise<Policy[]>;
  update(orgId: string, id: string, patch: Partial<Policy>): Promise<Policy>;
  delete(orgId: string, id: string): Promise<boolean>;
  /** Org-scoped policies plus the agent-scoped ones the spec attaches. */
  forAgent(orgId: string, attachedIds: string[]): Promise<Policy[]>;
}

export interface SecretRepo {
  put(metadata: SecretMetadata, ciphertext: string): Promise<SecretMetadata>;
  getMetadata(orgId: string, name: string): Promise<SecretMetadata | null>;
  getCiphertext(orgId: string, name: string): Promise<string | null>;
  list(orgId: string): Promise<SecretMetadata[]>;
  delete(orgId: string, name: string): Promise<boolean>;
  touch(orgId: string, name: string, at: number): Promise<void>;
}

export interface AuditRepo {
  record(entry: AuditLogRecord): Promise<AuditLogRecord>;
  list(orgId: string, filter?: PageRequest & { actorId?: string; resourceType?: string; since?: number }): Promise<Page<AuditLogRecord>>;
}

export interface IdempotencyRepo {
  /**
   * Claim a key. Returns `{ claimed: true }` for the first caller and the stored
   * response for every later one, which is what makes retried POSTs safe.
   */
  claim(orgId: string, scope: string, key: string, now: number, ttlMs: number): Promise<{ claimed: boolean; response: JsonValue | null }>;
  complete(orgId: string, scope: string, key: string, response: JsonValue): Promise<void>;
  purge(now: number): Promise<number>;
}

export interface MetricsRepo {
  agentMetrics(orgId: string, agentId: string, windowStart: number, windowEnd: number): Promise<AgentMetrics>;
  orgTotals(orgId: string, windowStart: number, windowEnd: number): Promise<{
    executions: number;
    completed: number;
    failed: number;
    costMicroUsd: number;
    totalTokens: number;
    toolCalls: number;
    modelCalls: number;
    approvals: number;
  }>;
  costByAgent(orgId: string, windowStart: number, windowEnd: number): Promise<Array<{ agentId: string; costMicroUsd: number; executions: number }>>;
  costByModel(orgId: string, windowStart: number, windowEnd: number): Promise<Array<{ model: string; costMicroUsd: number; calls: number }>>;
  toolUsage(orgId: string, windowStart: number, windowEnd: number): Promise<Array<{ tool: string; calls: number; failures: number; p95DurationMs: number }>>;
}

export interface Store {
  readonly kind: string;
  orgs: OrgRepo;
  users: UserRepo;
  apiKeys: ApiKeyRepo;
  agents: AgentRepo;
  executions: ExecutionRepo;
  events: EventRepo;
  approvals: ApprovalRepo;
  tasks: TaskRepo;
  messages: AgentMessageRepo;
  schedules: ScheduleRepo;
  webhooks: WebhookRepo;
  policies: PolicyRepo;
  secrets: SecretRepo;
  audit: AuditRepo;
  idempotency: IdempotencyRepo;
  metrics: MetricsRepo;
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
