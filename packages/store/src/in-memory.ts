import {
  AgentOSError,
  canTransition,
  emptyUsage,
  err,
  isTerminal,
  type AgentMessageRecord,
  type AgentMetrics,
  type AgentRecord,
  type AgentVersionRecord,
  type ApiKeyRecord,
  type ApprovalRecord,
  type AuditLogRecord,
  type ExecutionRecord,
  type ExecutionStatus,
  type JsonValue,
  type Membership,
  type Org,
  type Role,
  type ScheduleRecord,
  type SecretMetadata,
  type TaskRecord,
  type User,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
} from '@agentos/core';
import type { AnyEvent } from '@agentos/events';
import type { Policy } from '@agentos/policy';
import type {
  AgentListFilter,
  AgentMessageRepo,
  AgentRepo,
  ApiKeyRepo,
  ApprovalRepo,
  AuditRepo,
  EventListFilter,
  EventRepo,
  ExecutionListFilter,
  ExecutionRepo,
  ExecutionUpdate,
  IdempotencyRepo,
  MetricsRepo,
  OrgRepo,
  Page,
  PageRequest,
  PolicyRepo,
  ScheduleRepo,
  SecretRepo,
  Store,
  TaskRepo,
  UserRepo,
  WebhookRepo,
} from './types.js';

function paginate<T extends { id: string }>(items: T[], request: PageRequest = {}): Page<T> {
  const limit = Math.min(request.limit ?? 50, 200);
  const start = request.cursor ? items.findIndex((i) => i.id === request.cursor) + 1 : 0;
  const slice = items.slice(start, start + limit);
  const nextCursor = start + limit < items.length ? (slice[slice.length - 1]?.id ?? null) : null;
  return { items: slice, nextCursor };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/**
 * Single-process store. It is the default for local development, the test suite
 * and the demo environment, and it implements the same contract — including
 * tenant scoping, state-transition guards and lease semantics — as the SQL
 * store, so nothing above it behaves differently.
 */
export class InMemoryStore implements Store {
  readonly kind = 'memory';

  private readonly data = {
    orgs: new Map<string, Org>(),
    users: new Map<string, User>(),
    memberships: new Map<string, Membership>(),
    apiKeys: new Map<string, ApiKeyRecord>(),
    agents: new Map<string, AgentRecord>(),
    versions: new Map<string, AgentVersionRecord>(),
    executions: new Map<string, ExecutionRecord>(),
    events: new Map<string, AnyEvent[]>(),
    approvals: new Map<string, ApprovalRecord>(),
    tasks: new Map<string, TaskRecord>(),
    messages: new Map<string, AgentMessageRecord>(),
    schedules: new Map<string, ScheduleRecord>(),
    endpoints: new Map<string, WebhookEndpointRecord>(),
    deliveries: new Map<string, WebhookDeliveryRecord>(),
    policies: new Map<string, Policy>(),
    secrets: new Map<string, { metadata: SecretMetadata; ciphertext: string }>(),
    audit: new Map<string, AuditLogRecord>(),
    idempotency: new Map<string, { response: JsonValue | null; completed: boolean; expiresAt: number }>(),
  };

  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Test helper: wipe everything. */
  reset(): void {
    for (const map of Object.values(this.data)) map.clear();
  }

  private scoped<T extends { orgId: string }>(map: Map<string, T>, orgId: string): T[] {
    return [...map.values()].filter((v) => v.orgId === orgId);
  }

  orgs: OrgRepo = {
    create: async (org: Org) => {
      if (this.data.orgs.has(org.id)) throw err.conflict(`org ${org.id} already exists`);
      this.data.orgs.set(org.id, org);
      return org;
    },
    get: async (id: string) => this.data.orgs.get(id) ?? null,
    getBySlug: async (slug: string) => [...this.data.orgs.values()].find((o) => o.slug === slug) ?? null,
    list: async () => [...this.data.orgs.values()],
    update: async (id: string, patch: Partial<Org>) => {
      const existing = this.data.orgs.get(id);
      if (!existing) throw err.notFound('org', id);
      const updated = { ...existing, ...patch, id };
      this.data.orgs.set(id, updated);
      return updated;
    },
  };

  users: UserRepo = {
    upsert: async (user: User) => {
      this.data.users.set(user.id, user);
      return user;
    },
    get: async (id: string) => this.data.users.get(id) ?? null,
    getByEmail: async (email: string) =>
      [...this.data.users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null,
    addMember: async (membership: Membership) => {
      this.data.memberships.set(`${membership.orgId}:${membership.userId}`, membership);
      return membership;
    },
    removeMember: async (orgId: string, userId: string) => this.data.memberships.delete(`${orgId}:${userId}`),
    membership: async (orgId: string, userId: string) => this.data.memberships.get(`${orgId}:${userId}`) ?? null,
    membershipsFor: async (userId: string) => [...this.data.memberships.values()].filter((m) => m.userId === userId),
    members: async (orgId: string) =>
      [...this.data.memberships.values()]
        .filter((m) => m.orgId === orgId)
        .map((m) => ({ ...m, user: this.data.users.get(m.userId) as User }))
        .filter((m) => m.user !== undefined),
    setRole: async (orgId: string, userId: string, role: Role) => {
      const existing = this.data.memberships.get(`${orgId}:${userId}`);
      if (!existing) throw err.notFound('membership');
      const updated = { ...existing, role };
      this.data.memberships.set(`${orgId}:${userId}`, updated);
      return updated;
    },
  };

  apiKeys: ApiKeyRepo = {
    create: async (key: ApiKeyRecord) => {
      this.data.apiKeys.set(key.id, key);
      return key;
    },
    getByHash: async (hash: string) =>
      [...this.data.apiKeys.values()].find((k) => k.hash === hash && k.revokedAt === null) ?? null,
    list: async (orgId: string) => this.scoped(this.data.apiKeys, orgId),
    revoke: async (orgId: string, id: string, at: number) => {
      const key = this.data.apiKeys.get(id);
      if (!key || key.orgId !== orgId) return false;
      this.data.apiKeys.set(id, { ...key, revokedAt: at });
      return true;
    },
    touch: async (id: string, at: number) => {
      const key = this.data.apiKeys.get(id);
      if (key) this.data.apiKeys.set(id, { ...key, lastUsedAt: at });
    },
  };

  agents: AgentRepo = {
    create: async (agent: AgentRecord) => {
      const bySlug = await this.agents.getBySlug(agent.orgId, agent.slug);
      if (bySlug) throw err.conflict(`agent slug '${agent.slug}' is already used in this org`);
      this.data.agents.set(agent.id, agent);
      return agent;
    },
    get: async (orgId: string, id: string) => {
      const agent = this.data.agents.get(id);
      return agent && agent.orgId === orgId ? agent : null;
    },
    getBySlug: async (orgId: string, slug: string) =>
      this.scoped(this.data.agents, orgId).find((a) => a.slug === slug) ?? null,
    list: async (orgId: string, filter: AgentListFilter = {}) => {
      let items = this.scoped(this.data.agents, orgId);
      if (!filter.includeArchived) items = items.filter((a) => !a.archived);
      if (filter.search) {
        const needle = filter.search.toLowerCase();
        items = items.filter(
          (a) => a.name.toLowerCase().includes(needle) || a.slug.includes(needle) || a.description.toLowerCase().includes(needle),
        );
      }
      if (filter.labels) {
        items = items.filter((a) => Object.entries(filter.labels ?? {}).every(([k, v]) => a.labels[k] === v));
      }
      return paginate(items.sort((a, b) => b.createdAt - a.createdAt), filter);
    },
    update: async (orgId: string, id: string, patch: Partial<AgentRecord>) => {
      const existing = await this.agents.get(orgId, id);
      if (!existing) throw err.notFound('agent', id);
      const updated = { ...existing, ...patch, id, orgId };
      this.data.agents.set(id, updated);
      return updated;
    },
    archive: async (orgId: string, id: string) => {
      const existing = await this.agents.get(orgId, id);
      if (!existing) return false;
      this.data.agents.set(id, { ...existing, archived: true });
      return true;
    },
    createVersion: async (version: AgentVersionRecord) => {
      this.data.versions.set(version.id, version);
      return version;
    },
    getVersion: async (orgId: string, versionId: string) => {
      const version = this.data.versions.get(versionId);
      return version && version.orgId === orgId ? version : null;
    },
    listVersions: async (orgId: string, agentId: string) =>
      this.scoped(this.data.versions, orgId)
        .filter((v) => v.agentId === agentId)
        .sort((a, b) => b.version - a.version),
  };

  executions: ExecutionRepo = {
    create: async (execution: ExecutionRecord) => {
      if (execution.idempotencyKey) {
        const existing = await this.executions.getByIdempotencyKey(execution.orgId, execution.idempotencyKey);
        if (existing) return existing;
      }
      this.data.executions.set(execution.id, execution);
      return execution;
    },
    get: async (orgId: string, id: string) => {
      const execution = this.data.executions.get(id);
      return execution && execution.orgId === orgId ? execution : null;
    },
    getByIdempotencyKey: async (orgId: string, key: string) =>
      this.scoped(this.data.executions, orgId).find((e) => e.idempotencyKey === key) ?? null,
    list: async (orgId: string, filter: ExecutionListFilter = {}) => {
      let items = this.scoped(this.data.executions, orgId);
      if (filter.agentId) items = items.filter((e) => e.agentId === filter.agentId);
      if (filter.status) items = items.filter((e) => filter.status?.includes(e.status));
      if (filter.mode) items = items.filter((e) => e.mode === filter.mode);
      if (filter.taskId) items = items.filter((e) => e.taskId === filter.taskId);
      if (filter.userId) items = items.filter((e) => e.userId === filter.userId);
      if (filter.since !== undefined) items = items.filter((e) => e.createdAt >= (filter.since as number));
      if (filter.until !== undefined) items = items.filter((e) => e.createdAt <= (filter.until as number));
      return paginate(items.sort((a, b) => (a.id < b.id ? 1 : -1)), filter);
    },
    update: async (orgId: string, id: string, update: ExecutionUpdate) => {
      const existing = await this.executions.get(orgId, id);
      if (!existing) throw err.notFound('execution', id);
      const { expectedStatus, patch } = update;
      if (expectedStatus && !expectedStatus.includes(existing.status)) {
        throw new AgentOSError(
          'state_invalid',
          `execution ${id} is ${existing.status}, expected one of ${expectedStatus.join(', ')}`,
          { details: { current: existing.status, expected: expectedStatus } },
        );
      }
      if (patch.status && patch.status !== existing.status && !canTransition(existing.status, patch.status)) {
        throw new AgentOSError(
          'state_invalid',
          `cannot move execution ${id} from ${existing.status} to ${patch.status}`,
          { details: { from: existing.status, to: patch.status } },
        );
      }
      const updated: ExecutionRecord = { ...existing, ...patch, id, orgId };
      this.data.executions.set(id, updated);
      return updated;
    },
    acquireLease: async (orgId: string, id: string, workerId: string, leaseMs: number, now: number) => {
      const existing = await this.executions.get(orgId, id);
      if (!existing) throw err.notFound('execution', id);
      if (isTerminal(existing.status)) return null;
      const lease = existing.lease;
      if (lease && lease.expiresAt > now && lease.workerId !== workerId) return null;
      const updated: ExecutionRecord = {
        ...existing,
        lease: { workerId, acquiredAt: now, expiresAt: now + leaseMs },
      };
      this.data.executions.set(id, updated);
      return updated;
    },
    renewLease: async (orgId: string, id: string, workerId: string, leaseMs: number, now: number) => {
      const existing = await this.executions.get(orgId, id);
      const lease = existing?.lease;
      if (!existing || !lease || lease.workerId !== workerId) return false;
      this.data.executions.set(id, { ...existing, lease: { ...lease, expiresAt: now + leaseMs } });
      return true;
    },
    releaseLease: async (orgId: string, id: string, workerId: string) => {
      const existing = await this.executions.get(orgId, id);
      if (!existing || existing.lease?.workerId !== workerId) return false;
      this.data.executions.set(id, { ...existing, lease: null });
      return true;
    },
    findExpiredLeases: async (now: number, limit = 50) =>
      [...this.data.executions.values()]
        .filter((e) => e.status === 'running' && e.lease !== null && e.lease.expiresAt <= now)
        .slice(0, limit),
    countByStatus: async (orgId: string, agentId?: string) => {
      const counts = {
        queued: 0, running: 0, awaiting_approval: 0, paused: 0, completed: 0, failed: 0, cancelled: 0,
      } as Record<ExecutionStatus, number>;
      for (const execution of this.scoped(this.data.executions, orgId)) {
        if (agentId && execution.agentId !== agentId) continue;
        counts[execution.status] += 1;
      }
      return counts;
    },
  };

  events: EventRepo = {
    append: async (events: AnyEvent[]) => {
      for (const event of events) {
        const key = `${event.orgId}:${event.executionId ?? 'org'}`;
        const list = this.data.events.get(key) ?? [];
        // (executionId, seq) is unique, mirroring the SQL index: a retried
        // flush must not append the same event twice.
        if (event.executionId !== null && list.some((e) => e.seq === event.seq)) continue;
        list.push(event);
        this.data.events.set(key, list);
      }
    },
    listForExecution: async (orgId: string, executionId: string, filter: EventListFilter = {}) => {
      const list = this.data.events.get(`${orgId}:${executionId}`) ?? [];
      let items = [...list].sort((a, b) => a.seq - b.seq);
      if (filter.sinceSeq !== undefined) items = items.filter((e) => e.seq > (filter.sinceSeq as number));
      if (filter.types) items = items.filter((e) => filter.types?.includes(e.type));
      return items.slice(0, filter.limit ?? 1_000);
    },
    listForOrg: async (orgId: string, filter: EventListFilter & { agentId?: string } = {}) => {
      let items = [...this.data.events.entries()]
        .filter(([key]) => key.startsWith(`${orgId}:`))
        .flatMap(([, list]) => list);
      if (filter.agentId) items = items.filter((e) => e.agentId === filter.agentId);
      if (filter.types) items = items.filter((e) => filter.types?.includes(e.type));
      return paginate(items.sort((a, b) => (a.id < b.id ? 1 : -1)), filter);
    },
    maxSeq: async (orgId: string, executionId: string) => {
      const list = this.data.events.get(`${orgId}:${executionId}`) ?? [];
      return list.reduce((max, e) => Math.max(max, e.seq), 0);
    },
  };

  approvals: ApprovalRepo = {
    create: async (approval: ApprovalRecord) => {
      this.data.approvals.set(approval.id, approval);
      return approval;
    },
    get: async (orgId: string, id: string) => {
      const approval = this.data.approvals.get(id);
      return approval && approval.orgId === orgId ? approval : null;
    },
    listPending: async (orgId: string, filter: PageRequest & { agentId?: string } = {}) => {
      let items = this.scoped(this.data.approvals, orgId).filter((a) => a.status === 'pending');
      if (filter.agentId) items = items.filter((a) => a.agentId === filter.agentId);
      return paginate(items.sort((a, b) => a.requestedAt - b.requestedAt), filter);
    },
    listForExecution: async (orgId: string, executionId: string) =>
      this.scoped(this.data.approvals, orgId)
        .filter((a) => a.executionId === executionId)
        .sort((a, b) => a.requestedAt - b.requestedAt),
    decide: async (orgId, id, decision) => {
      const approval = await this.approvals.get(orgId, id);
      if (!approval) throw err.notFound('approval', id);
      if (approval.status !== 'pending') {
        throw new AgentOSError('conflict', `approval ${id} was already ${approval.status}`, {
          details: { status: approval.status },
        });
      }
      const updated: ApprovalRecord = {
        ...approval,
        status: decision.status,
        decidedAt: decision.at,
        decidedBy: decision.by,
        decisionNote: decision.note ?? null,
        editedArguments: decision.editedArguments ?? null,
      };
      this.data.approvals.set(id, updated);
      return updated;
    },
    expireOverdue: async (now: number) => {
      const expired: ApprovalRecord[] = [];
      for (const approval of this.data.approvals.values()) {
        if (approval.status === 'pending' && approval.expiresAt !== null && approval.expiresAt <= now) {
          const updated: ApprovalRecord = { ...approval, status: 'expired', decidedAt: now };
          this.data.approvals.set(approval.id, updated);
          expired.push(updated);
        }
      }
      return expired;
    },
  };

  tasks: TaskRepo = {
    create: async (task: TaskRecord) => {
      this.data.tasks.set(task.id, task);
      return task;
    },
    get: async (orgId: string, id: string) => {
      const task = this.data.tasks.get(id);
      return task && task.orgId === orgId ? task : null;
    },
    list: async (orgId, filter = {}) => {
      let items = this.scoped(this.data.tasks, orgId);
      if (filter.status) items = items.filter((t) => filter.status?.includes(t.status));
      if (filter.agentId) items = items.filter((t) => t.agentId === filter.agentId);
      if (filter.parentTaskId) items = items.filter((t) => t.parentTaskId === filter.parentTaskId);
      return paginate(items.sort((a, b) => (a.id < b.id ? 1 : -1)), filter);
    },
    update: async (orgId: string, id: string, patch: Partial<TaskRecord>) => {
      const existing = await this.tasks.get(orgId, id);
      if (!existing) throw err.notFound('task', id);
      const updated = { ...existing, ...patch, id, orgId };
      this.data.tasks.set(id, updated);
      return updated;
    },
    findUnblocked: async (orgId: string) => {
      const all = this.scoped(this.data.tasks, orgId);
      const byId = new Map(all.map((t) => [t.id, t]));
      return all.filter(
        (t) =>
          t.status === 'blocked' &&
          t.dependsOn.every((dep) => byId.get(dep)?.status === 'completed'),
      );
    },
  };

  messages: AgentMessageRepo = {
    send: async (message: AgentMessageRecord) => {
      this.data.messages.set(message.id, message);
      return message;
    },
    get: async (orgId: string, id: string) => {
      const message = this.data.messages.get(id);
      return message && message.orgId === orgId ? message : null;
    },
    inbox: async (orgId: string, agentId: string, filter: PageRequest = {}) =>
      this.scoped(this.data.messages, orgId)
        .filter((m) => m.toAgentId === agentId && m.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, filter.limit ?? 50),
    markDelivered: async (orgId: string, id: string, executionId: string, at: number) => {
      const message = await this.messages.get(orgId, id);
      if (!message) throw err.notFound('agent message', id);
      const updated: AgentMessageRecord = {
        ...message,
        status: 'delivered',
        deliveredAt: at,
        toExecutionId: executionId,
      };
      this.data.messages.set(id, updated);
      return updated;
    },
    listForTask: async (orgId: string, taskId: string) =>
      this.scoped(this.data.messages, orgId)
        .filter((m) => m.taskId === taskId)
        .sort((a, b) => a.createdAt - b.createdAt),
  };

  schedules: ScheduleRepo = {
    create: async (schedule: ScheduleRecord) => {
      this.data.schedules.set(schedule.id, schedule);
      return schedule;
    },
    get: async (orgId: string, id: string) => {
      const schedule = this.data.schedules.get(id);
      return schedule && schedule.orgId === orgId ? schedule : null;
    },
    list: async (orgId, filter = {}) => {
      let items = this.scoped(this.data.schedules, orgId);
      if (filter.agentId) items = items.filter((s) => s.agentId === filter.agentId);
      if (filter.enabled !== undefined) items = items.filter((s) => s.enabled === filter.enabled);
      return paginate(items.sort((a, b) => (a.id < b.id ? 1 : -1)), filter);
    },
    update: async (orgId: string, id: string, patch: Partial<ScheduleRecord>) => {
      const existing = await this.schedules.get(orgId, id);
      if (!existing) throw err.notFound('schedule', id);
      const updated = { ...existing, ...patch, id, orgId };
      this.data.schedules.set(id, updated);
      return updated;
    },
    delete: async (orgId: string, id: string) => {
      const existing = await this.schedules.get(orgId, id);
      if (!existing) return false;
      return this.data.schedules.delete(id);
    },
    due: async (now: number, limit = 100) =>
      [...this.data.schedules.values()]
        .filter((s) => s.enabled && s.nextRunAt !== null && s.nextRunAt <= now)
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
        .slice(0, limit),
    claim: async (id: string, firedFor: number, nextRunAt: number | null) => {
      const schedule = this.data.schedules.get(id);
      // Claiming is a compare-and-set on nextRunAt, so a second scheduler that
      // read the same row loses the race instead of firing a duplicate run.
      if (!schedule || schedule.nextRunAt !== firedFor) return false;
      this.data.schedules.set(id, { ...schedule, lastRunAt: firedFor, nextRunAt });
      return true;
    },
  };

  webhooks: WebhookRepo = {
    createEndpoint: async (endpoint: WebhookEndpointRecord) => {
      this.data.endpoints.set(endpoint.id, endpoint);
      return endpoint;
    },
    getEndpoint: async (orgId: string, id: string) => {
      const endpoint = this.data.endpoints.get(id);
      return endpoint && endpoint.orgId === orgId ? endpoint : null;
    },
    listEndpoints: async (orgId, filter = {}) => {
      let items = this.scoped(this.data.endpoints, orgId);
      if (filter.agentId) items = items.filter((e) => e.agentId === filter.agentId);
      return paginate(items, filter);
    },
    deleteEndpoint: async (orgId: string, id: string) => {
      const endpoint = await this.webhooks.getEndpoint(orgId, id);
      if (!endpoint) return false;
      return this.data.endpoints.delete(id);
    },
    recordDelivery: async (delivery: WebhookDeliveryRecord) => {
      const duplicate = [...this.data.deliveries.values()].some(
        (d) => d.endpointId === delivery.endpointId && d.dedupeKey === delivery.dedupeKey,
      );
      if (duplicate) return null;
      this.data.deliveries.set(delivery.id, delivery);
      return delivery;
    },
    listDeliveries: async (orgId: string, endpointId: string, filter: PageRequest = {}) =>
      paginate(
        this.scoped(this.data.deliveries, orgId)
          .filter((d) => d.endpointId === endpointId)
          .sort((a, b) => (a.id < b.id ? 1 : -1)),
        filter,
      ),
  };

  policies: PolicyRepo = {
    create: async (policy: Policy) => {
      this.data.policies.set(policy.id, policy);
      return policy;
    },
    get: async (orgId: string, id: string) => {
      const policy = this.data.policies.get(id);
      return policy && policy.orgId === orgId ? policy : null;
    },
    list: async (orgId: string) => this.scoped(this.data.policies, orgId),
    update: async (orgId: string, id: string, patch: Partial<Policy>) => {
      const existing = await this.policies.get(orgId, id);
      if (!existing) throw err.notFound('policy', id);
      const updated = { ...existing, ...patch, id, orgId };
      this.data.policies.set(id, updated);
      return updated;
    },
    delete: async (orgId: string, id: string) => {
      const existing = await this.policies.get(orgId, id);
      if (!existing) return false;
      return this.data.policies.delete(id);
    },
    forAgent: async (orgId: string, attachedIds: string[]) =>
      this.scoped(this.data.policies, orgId).filter((p) => p.scope === 'org' || attachedIds.includes(p.id)),
  };

  secrets: SecretRepo = {
    put: async (metadata: SecretMetadata, ciphertext: string) => {
      this.data.secrets.set(`${metadata.orgId}:${metadata.name}`, { metadata, ciphertext });
      return metadata;
    },
    getMetadata: async (orgId: string, name: string) => this.data.secrets.get(`${orgId}:${name}`)?.metadata ?? null,
    getCiphertext: async (orgId: string, name: string) => this.data.secrets.get(`${orgId}:${name}`)?.ciphertext ?? null,
    list: async (orgId: string) =>
      [...this.data.secrets.values()].filter((s) => s.metadata.orgId === orgId).map((s) => s.metadata),
    delete: async (orgId: string, name: string) => this.data.secrets.delete(`${orgId}:${name}`),
    touch: async (orgId: string, name: string, at: number) => {
      const entry = this.data.secrets.get(`${orgId}:${name}`);
      if (entry) entry.metadata = { ...entry.metadata, lastUsedAt: at };
    },
  };

  audit: AuditRepo = {
    record: async (entry: AuditLogRecord) => {
      this.data.audit.set(entry.id, entry);
      return entry;
    },
    list: async (orgId, filter = {}) => {
      let items = this.scoped(this.data.audit, orgId);
      if (filter.actorId) items = items.filter((a) => a.actorId === filter.actorId);
      if (filter.resourceType) items = items.filter((a) => a.resourceType === filter.resourceType);
      if (filter.since !== undefined) items = items.filter((a) => a.at >= (filter.since as number));
      return paginate(items.sort((a, b) => (a.id < b.id ? 1 : -1)), filter);
    },
  };

  idempotency: IdempotencyRepo = {
    claim: async (orgId: string, scope: string, key: string, now: number, ttlMs: number) => {
      const mapKey = `${orgId}:${scope}:${key}`;
      const existing = this.data.idempotency.get(mapKey);
      if (existing && existing.expiresAt > now) {
        return { claimed: false, response: existing.response };
      }
      this.data.idempotency.set(mapKey, { response: null, completed: false, expiresAt: now + ttlMs });
      return { claimed: true, response: null };
    },
    complete: async (orgId: string, scope: string, key: string, response: JsonValue) => {
      const mapKey = `${orgId}:${scope}:${key}`;
      const existing = this.data.idempotency.get(mapKey);
      if (existing) this.data.idempotency.set(mapKey, { ...existing, response, completed: true });
    },
    purge: async (now: number) => {
      let removed = 0;
      for (const [key, entry] of this.data.idempotency) {
        if (entry.expiresAt <= now) {
          this.data.idempotency.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };

  metrics: MetricsRepo = {
    agentMetrics: async (orgId: string, agentId: string, windowStart: number, windowEnd: number) => {
      const executions = this.scoped(this.data.executions, orgId).filter(
        (e) => e.agentId === agentId && e.createdAt >= windowStart && e.createdAt <= windowEnd,
      );
      const durations = executions
        .filter((e) => e.finishedAt !== null && e.startedAt !== null)
        .map((e) => (e.finishedAt as number) - (e.startedAt as number));
      const totals = executions.reduce((acc, e) => {
        acc.cost += e.usage.costMicroUsd;
        acc.tokens += e.usage.totalTokens;
        acc.toolCalls += e.usage.toolCalls;
        acc.modelCalls += e.usage.modelCalls;
        acc.retries += e.usage.retries;
        acc.approvals += e.usage.approvals;
        return acc;
      }, { cost: 0, tokens: 0, toolCalls: 0, modelCalls: 0, retries: 0, approvals: 0 });
      const completed = executions.filter((e) => e.status === 'completed').length;
      const failed = executions.filter((e) => e.status === 'failed').length;
      const settled = completed + failed;
      const metrics: AgentMetrics = {
        agentId,
        windowStart,
        windowEnd,
        executions: executions.length,
        completed,
        failed,
        cancelled: executions.filter((e) => e.status === 'cancelled').length,
        awaitingApproval: executions.filter((e) => e.status === 'awaiting_approval').length,
        // Undefined rather than 100% when nothing has finished yet.
        successRate: settled === 0 ? 0 : completed / settled,
        p50DurationMs: percentile(durations, 50),
        p95DurationMs: percentile(durations, 95),
        totalCostMicroUsd: totals.cost,
        totalTokens: totals.tokens,
        toolCalls: totals.toolCalls,
        modelCalls: totals.modelCalls,
        retries: totals.retries,
        approvals: totals.approvals,
      };
      return metrics;
    },
    orgTotals: async (orgId: string, windowStart: number, windowEnd: number) => {
      const executions = this.scoped(this.data.executions, orgId).filter(
        (e) => e.createdAt >= windowStart && e.createdAt <= windowEnd,
      );
      const usage = executions.reduce((acc, e) => {
        acc.costMicroUsd += e.usage.costMicroUsd;
        acc.totalTokens += e.usage.totalTokens;
        acc.toolCalls += e.usage.toolCalls;
        acc.modelCalls += e.usage.modelCalls;
        acc.approvals += e.usage.approvals;
        return acc;
      }, { ...emptyUsage(), costMicroUsd: 0, totalTokens: 0, toolCalls: 0, modelCalls: 0, approvals: 0 });
      return {
        executions: executions.length,
        completed: executions.filter((e) => e.status === 'completed').length,
        failed: executions.filter((e) => e.status === 'failed').length,
        costMicroUsd: usage.costMicroUsd,
        totalTokens: usage.totalTokens,
        toolCalls: usage.toolCalls,
        modelCalls: usage.modelCalls,
        approvals: usage.approvals,
      };
    },
    costByAgent: async (orgId: string, windowStart: number, windowEnd: number) => {
      const byAgent = new Map<string, { costMicroUsd: number; executions: number }>();
      for (const execution of this.scoped(this.data.executions, orgId)) {
        if (execution.createdAt < windowStart || execution.createdAt > windowEnd) continue;
        const entry = byAgent.get(execution.agentId) ?? { costMicroUsd: 0, executions: 0 };
        entry.costMicroUsd += execution.usage.costMicroUsd;
        entry.executions += 1;
        byAgent.set(execution.agentId, entry);
      }
      return [...byAgent.entries()]
        .map(([agentId, v]) => ({ agentId, ...v }))
        .sort((a, b) => b.costMicroUsd - a.costMicroUsd);
    },
    costByModel: async (orgId: string, windowStart: number, windowEnd: number) => {
      const byModel = new Map<string, { costMicroUsd: number; calls: number }>();
      for (const [key, list] of this.data.events) {
        if (!key.startsWith(`${orgId}:`)) continue;
        for (const event of list) {
          if (event.type !== 'model.call_succeeded') continue;
          if (event.at < windowStart || event.at > windowEnd) continue;
          const name = `${event.payload.provider}:${event.payload.model}`;
          const entry = byModel.get(name) ?? { costMicroUsd: 0, calls: 0 };
          entry.costMicroUsd += event.payload.costMicroUsd;
          entry.calls += 1;
          byModel.set(name, entry);
        }
      }
      return [...byModel.entries()]
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.costMicroUsd - a.costMicroUsd);
    },
    toolUsage: async (orgId: string, windowStart: number, windowEnd: number) => {
      const byTool = new Map<string, { calls: number; failures: number; durations: number[] }>();
      for (const [key, list] of this.data.events) {
        if (!key.startsWith(`${orgId}:`)) continue;
        for (const event of list) {
          if (event.at < windowStart || event.at > windowEnd) continue;
          if (event.type === 'tool.succeeded') {
            const entry = byTool.get(event.payload.toolName) ?? { calls: 0, failures: 0, durations: [] };
            entry.calls += 1;
            entry.durations.push(event.payload.durationMs);
            byTool.set(event.payload.toolName, entry);
          } else if (event.type === 'tool.failed') {
            const entry = byTool.get(event.payload.toolName) ?? { calls: 0, failures: 0, durations: [] };
            entry.calls += 1;
            entry.failures += 1;
            entry.durations.push(event.payload.durationMs);
            byTool.set(event.payload.toolName, entry);
          }
        }
      }
      return [...byTool.entries()]
        .map(([tool, v]) => ({ tool, calls: v.calls, failures: v.failures, p95DurationMs: percentile(v.durations, 95) }))
        .sort((a, b) => b.calls - a.calls);
    },
  };
}
