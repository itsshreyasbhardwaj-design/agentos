import {
  AgentOSError,
  canTransition,
  err,
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
} from '../types.js';
import type { SqlDriver } from './driver.js';
import { MIGRATION_TABLE, MIGRATIONS } from './schema.js';
import {
  json,
  num,
  toAgent,
  toApiKey,
  toApproval,
  toAudit,
  toDelivery,
  toEndpoint,
  toEvent,
  toExecution,
  toMembership,
  toMessage,
  toOrg,
  toPolicy,
  toSchedule,
  toSecretMetadata,
  toTask,
  toUser,
  toVersion,
} from './rows.js';

const MAX_LIMIT = 200;

function limitOf(request: PageRequest = {}): number {
  return Math.min(request.limit ?? 50, MAX_LIMIT);
}

function pageOf<T extends { id: string }>(items: T[], limit: number): Page<T> {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { items: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
}

/** Builds `$1, $2, …` placeholder lists while keeping the parameter array aligned. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * Postgres-backed store.
 *
 * Tenant scoping is applied in SQL on every read and write — there is no code
 * path that fetches a row by id alone and filters afterwards, which is the
 * mistake that turns a multi-tenant bug into a data leak.
 */
export class SqlStore implements Store {
  readonly kind = 'sql';

  constructor(private readonly db: SqlDriver) {}

  async init(): Promise<void> {
    await this.db.query(MIGRATION_TABLE);
    for (const migration of MIGRATIONS) {
      const applied = await this.db.query('SELECT id FROM schema_migrations WHERE id = $1', [migration.id]);
      if (applied.rows.length > 0) continue;
      // Every statement in a migration is `IF NOT EXISTS`, so a partially
      // applied script is safe to re-run; the marker row is written last.
      await this.db.exec(migration.sql);
      await this.db.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [
        migration.id,
        Date.now(),
      ]);
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.db.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  orgs: OrgRepo = {
    create: async (org: Org) => {
      await this.db.query(
        `INSERT INTO orgs (id, name, slug, created_at, limit_ceiling) VALUES ($1,$2,$3,$4,$5)`,
        [org.id, org.name, org.slug, org.createdAt, JSON.stringify(org.limitCeiling ?? null)],
      );
      return org;
    },
    get: async (id) => {
      const { rows } = await this.db.query('SELECT * FROM orgs WHERE id = $1', [id]);
      return rows[0] ? toOrg(rows[0]) : null;
    },
    getBySlug: async (slug) => {
      const { rows } = await this.db.query('SELECT * FROM orgs WHERE slug = $1', [slug]);
      return rows[0] ? toOrg(rows[0]) : null;
    },
    list: async () => (await this.db.query('SELECT * FROM orgs ORDER BY created_at')).rows.map(toOrg),
    update: async (id, patch) => {
      const existing = await this.orgs.get(id);
      if (!existing) throw err.notFound('org', id);
      const next = { ...existing, ...patch, id };
      await this.db.query('UPDATE orgs SET name=$2, slug=$3, limit_ceiling=$4 WHERE id=$1', [
        id,
        next.name,
        next.slug,
        JSON.stringify(next.limitCeiling ?? null),
      ]);
      return next;
    },
  };

  users: UserRepo = {
    upsert: async (user: User) => {
      await this.db.query(
        `INSERT INTO users (id, email, name, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
        [user.id, user.email, user.name, user.createdAt],
      );
      return user;
    },
    get: async (id) => {
      const { rows } = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    getByEmail: async (email) => {
      const { rows } = await this.db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    addMember: async (m: Membership) => {
      await this.db.query(
        `INSERT INTO memberships (org_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [m.orgId, m.userId, m.role, m.createdAt],
      );
      return m;
    },
    removeMember: async (orgId, userId) => {
      const result = await this.db.query('DELETE FROM memberships WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
      return result.rowCount > 0;
    },
    membership: async (orgId, userId) => {
      const { rows } = await this.db.query('SELECT * FROM memberships WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
      return rows[0] ? toMembership(rows[0]) : null;
    },
    membershipsFor: async (userId) =>
      (await this.db.query('SELECT * FROM memberships WHERE user_id=$1', [userId])).rows.map(toMembership),
    members: async (orgId) => {
      const { rows } = await this.db.query(
        `SELECT m.*, u.email, u.name, u.created_at AS user_created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = $1 ORDER BY m.created_at`,
        [orgId],
      );
      return rows.map((r) => ({
        ...toMembership(r),
        user: {
          id: String(r['user_id']),
          email: String(r['email']),
          name: String(r['name']),
          createdAt: num(r['user_created_at']),
        },
      }));
    },
    setRole: async (orgId, userId, role: Role) => {
      const { rows } = await this.db.query(
        'UPDATE memberships SET role=$3 WHERE org_id=$1 AND user_id=$2 RETURNING *',
        [orgId, userId, role],
      );
      if (!rows[0]) throw err.notFound('membership');
      return toMembership(rows[0]);
    },
  };

  apiKeys: ApiKeyRepo = {
    create: async (key: ApiKeyRecord) => {
      await this.db.query(
        `INSERT INTO api_keys (id, org_id, user_id, name, hash, prefix, role, created_at, last_used_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [key.id, key.orgId, key.userId, key.name, key.hash, key.prefix, key.role, key.createdAt, key.lastUsedAt, key.revokedAt],
      );
      return key;
    },
    getByHash: async (hash) => {
      const { rows } = await this.db.query('SELECT * FROM api_keys WHERE hash=$1 AND revoked_at IS NULL', [hash]);
      return rows[0] ? toApiKey(rows[0]) : null;
    },
    list: async (orgId) =>
      (await this.db.query('SELECT * FROM api_keys WHERE org_id=$1 ORDER BY created_at DESC', [orgId])).rows.map(toApiKey),
    revoke: async (orgId, id, at) => {
      const result = await this.db.query('UPDATE api_keys SET revoked_at=$3 WHERE org_id=$1 AND id=$2', [orgId, id, at]);
      return result.rowCount > 0;
    },
    touch: async (id, at) => {
      await this.db.query('UPDATE api_keys SET last_used_at=$2 WHERE id=$1', [id, at]);
    },
  };

  agents: AgentRepo = {
    create: async (agent: AgentRecord) => {
      try {
        await this.db.query(
          `INSERT INTO agents (id, org_id, slug, name, description, draft, published_version_id,
             latest_version_number, created_at, updated_at, created_by, archived, labels)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            agent.id, agent.orgId, agent.slug, agent.name, agent.description,
            JSON.stringify(agent.draft), agent.publishedVersionId, agent.latestVersionNumber,
            agent.createdAt, agent.updatedAt, agent.createdBy, agent.archived, JSON.stringify(agent.labels),
          ],
        );
      } catch (error) {
        if (String(error).includes('duplicate key')) {
          throw err.conflict(`agent slug '${agent.slug}' is already used in this org`);
        }
        throw error;
      }
      return agent;
    },
    get: async (orgId, id) => {
      const { rows } = await this.db.query('SELECT * FROM agents WHERE org_id=$1 AND id=$2', [orgId, id]);
      return rows[0] ? toAgent(rows[0]) : null;
    },
    getBySlug: async (orgId, slug) => {
      const { rows } = await this.db.query('SELECT * FROM agents WHERE org_id=$1 AND slug=$2', [orgId, slug]);
      return rows[0] ? toAgent(rows[0]) : null;
    },
    list: async (orgId, filter: AgentListFilter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`];
      if (!filter.includeArchived) where.push('archived = FALSE');
      if (filter.search) {
        const needle = p.add(`%${filter.search.toLowerCase()}%`);
        where.push(`(lower(name) LIKE ${needle} OR lower(slug) LIKE ${needle} OR lower(description) LIKE ${needle})`);
      }
      if (filter.labels) {
        where.push(`labels @> ${p.add(JSON.stringify(filter.labels))}::jsonb`);
      }
      if (filter.cursor) where.push(`id < ${p.add(filter.cursor)}`);
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return pageOf(rows.map(toAgent), limit);
    },
    update: async (orgId, id, patch) => {
      const existing = await this.agents.get(orgId, id);
      if (!existing) throw err.notFound('agent', id);
      const next = { ...existing, ...patch, id, orgId };
      await this.db.query(
        `UPDATE agents SET slug=$3, name=$4, description=$5, draft=$6, published_version_id=$7,
           latest_version_number=$8, updated_at=$9, archived=$10, labels=$11
         WHERE org_id=$1 AND id=$2`,
        [
          orgId, id, next.slug, next.name, next.description, JSON.stringify(next.draft),
          next.publishedVersionId, next.latestVersionNumber, next.updatedAt, next.archived,
          JSON.stringify(next.labels),
        ],
      );
      return next;
    },
    archive: async (orgId, id) => {
      const result = await this.db.query('UPDATE agents SET archived=TRUE WHERE org_id=$1 AND id=$2', [orgId, id]);
      return result.rowCount > 0;
    },
    createVersion: async (version: AgentVersionRecord) => {
      await this.db.query(
        `INSERT INTO agent_versions (id, agent_id, org_id, version, spec, status, changelog, published_at, published_by, spec_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          version.id, version.agentId, version.orgId, version.version, JSON.stringify(version.spec),
          version.status, version.changelog, version.publishedAt, version.publishedBy, version.specHash,
        ],
      );
      return version;
    },
    getVersion: async (orgId, versionId) => {
      const { rows } = await this.db.query('SELECT * FROM agent_versions WHERE org_id=$1 AND id=$2', [orgId, versionId]);
      return rows[0] ? toVersion(rows[0]) : null;
    },
    listVersions: async (orgId, agentId) =>
      (
        await this.db.query('SELECT * FROM agent_versions WHERE org_id=$1 AND agent_id=$2 ORDER BY version DESC', [
          orgId,
          agentId,
        ])
      ).rows.map(toVersion),
  };

  executions: ExecutionRepo = {
    create: async (execution: ExecutionRecord) => {
      if (execution.idempotencyKey) {
        const existing = await this.executions.getByIdempotencyKey(execution.orgId, execution.idempotencyKey);
        if (existing) return existing;
      }
      await this.db.query(
        `INSERT INTO executions (id, org_id, agent_id, agent_version_id, version_number, status, mode,
           replay_of_execution_id, parent_execution_id, task_id, trigger, user_id, input, output, error,
           state, usage, created_at, started_at, updated_at, finished_at, lease, lease_expires_at, attempt,
           idempotency_key, labels)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [
          execution.id, execution.orgId, execution.agentId, execution.agentVersionId, execution.versionNumber,
          execution.status, execution.mode, execution.replayOfExecutionId, execution.parentExecutionId,
          execution.taskId, JSON.stringify(execution.trigger), execution.userId,
          JSON.stringify(execution.input ?? null), JSON.stringify(execution.output ?? null),
          JSON.stringify(execution.error ?? null), JSON.stringify(execution.state), JSON.stringify(execution.usage),
          execution.createdAt, execution.startedAt, execution.updatedAt, execution.finishedAt,
          JSON.stringify(execution.lease ?? null), execution.lease?.expiresAt ?? null, execution.attempt,
          execution.idempotencyKey, JSON.stringify(execution.labels),
        ],
      );
      return execution;
    },
    get: async (orgId, id) => {
      const { rows } = await this.db.query('SELECT * FROM executions WHERE org_id=$1 AND id=$2', [orgId, id]);
      return rows[0] ? toExecution(rows[0]) : null;
    },
    getByIdempotencyKey: async (orgId, key) => {
      const { rows } = await this.db.query('SELECT * FROM executions WHERE org_id=$1 AND idempotency_key=$2', [orgId, key]);
      return rows[0] ? toExecution(rows[0]) : null;
    },
    list: async (orgId, filter: ExecutionListFilter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`];
      if (filter.agentId) where.push(`agent_id = ${p.add(filter.agentId)}`);
      if (filter.status && filter.status.length > 0) {
        where.push(`status = ANY(${p.add(filter.status)})`);
      }
      if (filter.mode) where.push(`mode = ${p.add(filter.mode)}`);
      if (filter.taskId) where.push(`task_id = ${p.add(filter.taskId)}`);
      if (filter.userId) where.push(`user_id = ${p.add(filter.userId)}`);
      if (filter.since !== undefined) where.push(`created_at >= ${p.add(filter.since)}`);
      if (filter.until !== undefined) where.push(`created_at <= ${p.add(filter.until)}`);
      if (filter.cursor) where.push(`id < ${p.add(filter.cursor)}`);
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM executions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return pageOf(rows.map(toExecution), limit);
    },
    update: async (orgId, id, update: ExecutionUpdate) => {
      return this.db.transaction(async (tx) => {
        const { rows } = await tx.query('SELECT * FROM executions WHERE org_id=$1 AND id=$2 FOR UPDATE', [orgId, id]);
        if (!rows[0]) throw err.notFound('execution', id);
        const existing = toExecution(rows[0]);
        const { expectedStatus, patch } = update;
        if (expectedStatus && !expectedStatus.includes(existing.status)) {
          throw new AgentOSError(
            'state_invalid',
            `execution ${id} is ${existing.status}, expected one of ${expectedStatus.join(', ')}`,
            { details: { current: existing.status, expected: expectedStatus } },
          );
        }
        if (patch.status && patch.status !== existing.status && !canTransition(existing.status, patch.status)) {
          throw new AgentOSError('state_invalid', `cannot move execution ${id} from ${existing.status} to ${patch.status}`, {
            details: { from: existing.status, to: patch.status },
          });
        }
        const next: ExecutionRecord = { ...existing, ...patch, id, orgId };
        await tx.query(
          `UPDATE executions SET status=$3, output=$4, error=$5, state=$6, usage=$7, started_at=$8,
             updated_at=$9, finished_at=$10, lease=$11, lease_expires_at=$12, attempt=$13, labels=$14,
             task_id=$15
           WHERE org_id=$1 AND id=$2`,
          [
            orgId, id, next.status, JSON.stringify(next.output ?? null), JSON.stringify(next.error ?? null),
            JSON.stringify(next.state), JSON.stringify(next.usage), next.startedAt, next.updatedAt,
            next.finishedAt, JSON.stringify(next.lease ?? null), next.lease?.expiresAt ?? null,
            next.attempt, JSON.stringify(next.labels), next.taskId,
          ],
        );
        return next;
      });
    },
    acquireLease: async (orgId, id, workerId, leaseMs, now) => {
      // One statement: the WHERE clause is the lock, so two workers racing for
      // the same execution cannot both come back with a row.
      const { rows } = await this.db.query(
        `UPDATE executions
         SET lease = $3::jsonb, lease_expires_at = $4, updated_at = $5
         WHERE org_id = $1 AND id = $2
           AND status NOT IN ('completed','failed','cancelled')
           AND (lease_expires_at IS NULL OR lease_expires_at <= $6 OR lease->>'workerId' = $7)
         RETURNING *`,
        [
          orgId, id,
          JSON.stringify({ workerId, acquiredAt: now, expiresAt: now + leaseMs }),
          now + leaseMs, now, now, workerId,
        ],
      );
      return rows[0] ? toExecution(rows[0]) : null;
    },
    renewLease: async (orgId, id, workerId, leaseMs, now) => {
      const result = await this.db.query(
        `UPDATE executions SET lease = jsonb_set(lease, '{expiresAt}', to_jsonb($4::bigint)), lease_expires_at = $4
         WHERE org_id=$1 AND id=$2 AND lease->>'workerId' = $3`,
        [orgId, id, workerId, now + leaseMs],
      );
      return result.rowCount > 0;
    },
    releaseLease: async (orgId, id, workerId) => {
      const result = await this.db.query(
        `UPDATE executions SET lease = NULL, lease_expires_at = NULL
         WHERE org_id=$1 AND id=$2 AND lease->>'workerId' = $3`,
        [orgId, id, workerId],
      );
      return result.rowCount > 0;
    },
    findExpiredLeases: async (now, limit = 50) =>
      (
        await this.db.query(
          `SELECT * FROM executions WHERE status = 'running' AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= $1 ORDER BY lease_expires_at LIMIT $2`,
          [now, limit],
        )
      ).rows.map(toExecution),
    countByStatus: async (orgId, agentId) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`];
      if (agentId) where.push(`agent_id = ${p.add(agentId)}`);
      const { rows } = await this.db.query(
        `SELECT status, COUNT(*)::int AS count FROM executions WHERE ${where.join(' AND ')} GROUP BY status`,
        p.values,
      );
      const counts = {
        queued: 0, running: 0, awaiting_approval: 0, paused: 0, completed: 0, failed: 0, cancelled: 0,
      } as Record<ExecutionStatus, number>;
      for (const row of rows) counts[String(row['status']) as ExecutionStatus] = num(row['count']);
      return counts;
    },
  };

  events: EventRepo = {
    append: async (events: AnyEvent[]) => {
      if (events.length === 0) return;
      const p = new Params();
      const tuples = events.map((e) =>
        `(${[
          p.add(e.id), p.add(e.orgId), p.add(e.executionId), p.add(e.agentId), p.add(e.taskId),
          p.add(e.seq), p.add(e.type), p.add(e.at), p.add(e.traceId), p.add(e.spanId),
          p.add(e.parentSpanId), p.add(e.durationMs), p.add(JSON.stringify(e.payload)),
        ].join(',')})`,
      );
      await this.db.query(
        `INSERT INTO events (id, org_id, execution_id, agent_id, task_id, seq, type, at, trace_id,
           span_id, parent_span_id, duration_ms, payload)
         VALUES ${tuples.join(',')}
         ON CONFLICT DO NOTHING`,
        p.values,
      );
    },
    listForExecution: async (orgId, executionId, filter: EventListFilter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`, `execution_id = ${p.add(executionId)}`];
      if (filter.sinceSeq !== undefined) where.push(`seq > ${p.add(filter.sinceSeq)}`);
      if (filter.types && filter.types.length > 0) where.push(`type = ANY(${p.add(filter.types)})`);
      const { rows } = await this.db.query(
        `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ${p.add(filter.limit ?? 1000)}`,
        p.values,
      );
      return rows.map(toEvent);
    },
    listForOrg: async (orgId, filter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`];
      if (filter.agentId) where.push(`agent_id = ${p.add(filter.agentId)}`);
      if (filter.types && filter.types.length > 0) where.push(`type = ANY(${p.add(filter.types)})`);
      if (filter.cursor) where.push(`id < ${p.add(filter.cursor)}`);
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return pageOf(rows.map(toEvent), limit);
    },
    maxSeq: async (orgId, executionId) => {
      const { rows } = await this.db.query(
        'SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE org_id=$1 AND execution_id=$2',
        [orgId, executionId],
      );
      return num(rows[0]?.['max']);
    },
  };

  approvals: ApprovalRepo = {
    create: async (a: ApprovalRecord) => {
      await this.db.query(
        `INSERT INTO approvals (id, org_id, execution_id, agent_id, tool_call, reason, rule_id, impact,
           operations, destructive, status, requested_at, expires_at, decided_at, decided_by, decision_note, edited_arguments)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          a.id, a.orgId, a.executionId, a.agentId, JSON.stringify(a.toolCall), a.reason, a.ruleId, a.impact,
          JSON.stringify(a.operations), a.destructive, a.status, a.requestedAt, a.expiresAt,
          a.decidedAt, a.decidedBy, a.decisionNote, JSON.stringify(a.editedArguments ?? null),
        ],
      );
      return a;
    },
    get: async (orgId, id) => {
      const { rows } = await this.db.query('SELECT * FROM approvals WHERE org_id=$1 AND id=$2', [orgId, id]);
      return rows[0] ? toApproval(rows[0]) : null;
    },
    listPending: async (orgId, filter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`, `status = 'pending'`];
      if (filter.agentId) where.push(`agent_id = ${p.add(filter.agentId)}`);
      if (filter.cursor) where.push(`id > ${p.add(filter.cursor)}`);
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM approvals WHERE ${where.join(' AND ')} ORDER BY requested_at LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return pageOf(rows.map(toApproval), limit);
    },
    listForExecution: async (orgId, executionId) =>
      (
        await this.db.query('SELECT * FROM approvals WHERE org_id=$1 AND execution_id=$2 ORDER BY requested_at', [
          orgId,
          executionId,
        ])
      ).rows.map(toApproval),
    decide: async (orgId, id, decision) => {
      // Conditional on status: a second approver racing the first gets a 409
      // rather than silently overwriting the decision.
      const { rows } = await this.db.query(
        `UPDATE approvals SET status=$3, decided_at=$4, decided_by=$5, decision_note=$6, edited_arguments=$7
         WHERE org_id=$1 AND id=$2 AND status='pending' RETURNING *`,
        [
          orgId, id, decision.status, decision.at, decision.by, decision.note ?? null,
          JSON.stringify(decision.editedArguments ?? null),
        ],
      );
      if (!rows[0]) {
        const current = await this.approvals.get(orgId, id);
        if (!current) throw err.notFound('approval', id);
        throw new AgentOSError('conflict', `approval ${id} was already ${current.status}`, {
          details: { status: current.status },
        });
      }
      return toApproval(rows[0]);
    },
    expireOverdue: async (now) =>
      (
        await this.db.query(
          `UPDATE approvals SET status='expired', decided_at=$1
           WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= $1 RETURNING *`,
          [now],
        )
      ).rows.map(toApproval),
  };

  tasks: TaskRepo = {
    create: async (t: TaskRecord) => {
      await this.db.query(
        `INSERT INTO tasks (id, org_id, agent_id, parent_task_id, title, status, input, output, error,
           depends_on, execution_id, created_at, updated_at, finished_at, created_by, labels)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          t.id, t.orgId, t.agentId, t.parentTaskId, t.title, t.status, JSON.stringify(t.input ?? null),
          JSON.stringify(t.output ?? null), JSON.stringify(t.error ?? null), JSON.stringify(t.dependsOn),
          t.executionId, t.createdAt, t.updatedAt, t.finishedAt, t.createdBy, JSON.stringify(t.labels),
        ],
      );
      return t;
    },
    get: async (orgId, id) => {
      const { rows } = await this.db.query('SELECT * FROM tasks WHERE org_id=$1 AND id=$2', [orgId, id]);
      return rows[0] ? toTask(rows[0]) : null;
    },
    list: async (orgId, filter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`];
      if (filter.status && filter.status.length > 0) where.push(`status = ANY(${p.add(filter.status)})`);
      if (filter.agentId) where.push(`agent_id = ${p.add(filter.agentId)}`);
      if (filter.parentTaskId) where.push(`parent_task_id = ${p.add(filter.parentTaskId)}`);
      if (filter.cursor) where.push(`id < ${p.add(filter.cursor)}`);
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return pageOf(rows.map(toTask), limit);
    },
    update: async (orgId, id, patch) => {
      const existing = await this.tasks.get(orgId, id);
      if (!existing) throw err.notFound('task', id);
      const next = { ...existing, ...patch, id, orgId };
      await this.db.query(
        `UPDATE tasks SET status=$3, output=$4, error=$5, execution_id=$6, updated_at=$7, finished_at=$8, labels=$9
         WHERE org_id=$1 AND id=$2`,
        [
          orgId, id, next.status, JSON.stringify(next.output ?? null), JSON.stringify(next.error ?? null),
          next.executionId, next.updatedAt, next.finishedAt, JSON.stringify(next.labels),
        ],
      );
      return next;
    },
    findUnblocked: async (orgId) => {
      // A blocked task becomes runnable when no dependency is still unfinished.
      const { rows } = await this.db.query(
        `SELECT t.* FROM tasks t
         WHERE t.org_id = $1 AND t.status = 'blocked'
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(t.depends_on) AS dep(id)
             LEFT JOIN tasks d ON d.id = dep.id AND d.org_id = t.org_id
             WHERE d.id IS NULL OR d.status <> 'completed'
           )`,
        [orgId],
      );
      return rows.map(toTask);
    },
  };

  messages: AgentMessageRepo = {
    send: async (m: AgentMessageRecord) => {
      await this.db.query(
        `INSERT INTO agent_messages (id, org_id, task_id, from_agent_id, from_execution_id, to_agent_id,
           to_execution_id, kind, payload, status, created_at, delivered_at, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          m.id, m.orgId, m.taskId, m.fromAgentId, m.fromExecutionId, m.toAgentId, m.toExecutionId,
          m.kind, JSON.stringify(m.payload), m.status, m.createdAt, m.deliveredAt, m.correlationId,
        ],
      );
      return m;
    },
    get: async (orgId, id) => {
      const { rows } = await this.db.query('SELECT * FROM agent_messages WHERE org_id=$1 AND id=$2', [orgId, id]);
      return rows[0] ? toMessage(rows[0]) : null;
    },
    inbox: async (orgId, agentId, filter = {}) =>
      (
        await this.db.query(
          `SELECT * FROM agent_messages WHERE org_id=$1 AND to_agent_id=$2 AND status='pending'
           ORDER BY created_at LIMIT $3`,
          [orgId, agentId, limitOf(filter)],
        )
      ).rows.map(toMessage),
    markDelivered: async (orgId, id, executionId, at) => {
      const { rows } = await this.db.query(
        `UPDATE agent_messages SET status='delivered', delivered_at=$3, to_execution_id=$4
         WHERE org_id=$1 AND id=$2 RETURNING *`,
        [orgId, id, at, executionId],
      );
      if (!rows[0]) throw err.notFound('agent message', id);
      return toMessage(rows[0]);
    },
    listForTask: async (orgId, taskId) =>
      (
        await this.db.query('SELECT * FROM agent_messages WHERE org_id=$1 AND task_id=$2 ORDER BY created_at', [
          orgId,
          taskId,
        ])
      ).rows.map(toMessage),
  };

  schedules: ScheduleRepo = {
    create: async (s: ScheduleRecord) => {
      await this.db.query(
        `INSERT INTO schedules (id, org_id, agent_id, name, kind, expression, timezone, input, enabled,
           created_at, updated_at, last_run_at, next_run_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          s.id, s.orgId, s.agentId, s.name, s.kind, s.expression, s.timezone, JSON.stringify(s.input ?? null),
          s.enabled, s.createdAt, s.updatedAt, s.lastRunAt, s.nextRunAt, s.createdBy,
        ],
      );
      return s;
    },
    get: async (orgId, id) => {
      const { rows } = await this.db.query('SELECT * FROM schedules WHERE org_id=$1 AND id=$2', [orgId, id]);
      return rows[0] ? toSchedule(rows[0]) : null;
    },
    list: async (orgId, filter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`];
      if (filter.agentId) where.push(`agent_id = ${p.add(filter.agentId)}`);
      if (filter.enabled !== undefined) where.push(`enabled = ${p.add(filter.enabled)}`);
      if (filter.cursor) where.push(`id < ${p.add(filter.cursor)}`);
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM schedules WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return pageOf(rows.map(toSchedule), limit);
    },
    update: async (orgId, id, patch) => {
      const existing = await this.schedules.get(orgId, id);
      if (!existing) throw err.notFound('schedule', id);
      const next = { ...existing, ...patch, id, orgId };
      await this.db.query(
        `UPDATE schedules SET name=$3, kind=$4, expression=$5, timezone=$6, input=$7, enabled=$8,
           updated_at=$9, last_run_at=$10, next_run_at=$11
         WHERE org_id=$1 AND id=$2`,
        [
          orgId, id, next.name, next.kind, next.expression, next.timezone, JSON.stringify(next.input ?? null),
          next.enabled, next.updatedAt, next.lastRunAt, next.nextRunAt,
        ],
      );
      return next;
    },
    delete: async (orgId, id) => {
      const result = await this.db.query('DELETE FROM schedules WHERE org_id=$1 AND id=$2', [orgId, id]);
      return result.rowCount > 0;
    },
    due: async (now, limit = 100) =>
      (
        await this.db.query(
          `SELECT * FROM schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1
           ORDER BY next_run_at LIMIT $2`,
          [now, limit],
        )
      ).rows.map(toSchedule),
    claim: async (id, firedFor, nextRunAt) => {
      // Compare-and-set on next_run_at: whichever scheduler updates the row
      // first wins, and the loser sees rowCount 0 and skips the firing.
      const result = await this.db.query(
        'UPDATE schedules SET last_run_at=$2, next_run_at=$3 WHERE id=$1 AND next_run_at=$2',
        [id, firedFor, nextRunAt],
      );
      return result.rowCount > 0;
    },
  };

  webhooks: WebhookRepo = {
    createEndpoint: async (e: WebhookEndpointRecord) => {
      await this.db.query(
        `INSERT INTO webhook_endpoints (id, org_id, agent_id, name, provider, signing_secret_name, enabled,
           tolerance_seconds, rate_limit_per_minute, created_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          e.id, e.orgId, e.agentId, e.name, e.provider, e.signingSecretName, e.enabled,
          e.toleranceSeconds, e.rateLimitPerMinute, e.createdAt, e.createdBy,
        ],
      );
      return e;
    },
    getEndpoint: async (orgId, id) => {
      const { rows } = await this.db.query('SELECT * FROM webhook_endpoints WHERE org_id=$1 AND id=$2', [orgId, id]);
      return rows[0] ? toEndpoint(rows[0]) : null;
    },
    listEndpoints: async (orgId, filter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`];
      if (filter.agentId) where.push(`agent_id = ${p.add(filter.agentId)}`);
      if (filter.cursor) where.push(`id < ${p.add(filter.cursor)}`);
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM webhook_endpoints WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return pageOf(rows.map(toEndpoint), limit);
    },
    deleteEndpoint: async (orgId, id) => {
      const result = await this.db.query('DELETE FROM webhook_endpoints WHERE org_id=$1 AND id=$2', [orgId, id]);
      return result.rowCount > 0;
    },
    recordDelivery: async (d: WebhookDeliveryRecord) => {
      // The unique (endpoint_id, dedupe_key) index is the replay guard; a
      // duplicate delivery inserts nothing and returns null.
      const { rows } = await this.db.query(
        `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, dedupe_key, received_at, accepted, rejection_reason, execution_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (endpoint_id, dedupe_key) DO NOTHING
         RETURNING *`,
        [d.id, d.orgId, d.endpointId, d.dedupeKey, d.receivedAt, d.accepted, d.rejectionReason, d.executionId],
      );
      return rows[0] ? toDelivery(rows[0]) : null;
    },
    listDeliveries: async (orgId, endpointId, filter = {}) => {
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM webhook_deliveries WHERE org_id=$1 AND endpoint_id=$2 ORDER BY id DESC LIMIT $3`,
        [orgId, endpointId, limit + 1],
      );
      return pageOf(rows.map(toDelivery), limit);
    },
  };

  policies: PolicyRepo = {
    create: async (p: Policy) => {
      await this.db.query(
        `INSERT INTO policies (id, org_id, name, description, enabled, scope, rules, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.id, p.orgId, p.name, p.description, p.enabled, p.scope, JSON.stringify(p.rules), p.createdAt, p.updatedAt],
      );
      return p;
    },
    get: async (orgId, id) => {
      const { rows } = await this.db.query('SELECT * FROM policies WHERE org_id=$1 AND id=$2', [orgId, id]);
      return rows[0] ? toPolicy(rows[0]) : null;
    },
    list: async (orgId) =>
      (await this.db.query('SELECT * FROM policies WHERE org_id=$1 ORDER BY name', [orgId])).rows.map(toPolicy),
    update: async (orgId, id, patch) => {
      const existing = await this.policies.get(orgId, id);
      if (!existing) throw err.notFound('policy', id);
      const next = { ...existing, ...patch, id, orgId };
      await this.db.query(
        `UPDATE policies SET name=$3, description=$4, enabled=$5, scope=$6, rules=$7, updated_at=$8
         WHERE org_id=$1 AND id=$2`,
        [orgId, id, next.name, next.description, next.enabled, next.scope, JSON.stringify(next.rules), next.updatedAt],
      );
      return next;
    },
    delete: async (orgId, id) => {
      const result = await this.db.query('DELETE FROM policies WHERE org_id=$1 AND id=$2', [orgId, id]);
      return result.rowCount > 0;
    },
    forAgent: async (orgId, attachedIds) => {
      const { rows } = await this.db.query(
        `SELECT * FROM policies WHERE org_id=$1 AND (scope='org' OR id = ANY($2)) ORDER BY name`,
        [orgId, attachedIds],
      );
      return rows.map(toPolicy);
    },
  };

  secrets: SecretRepo = {
    put: async (metadata: SecretMetadata, ciphertext: string) => {
      await this.db.query(
        `INSERT INTO secrets (org_id, name, id, ciphertext, hint, created_at, created_by, last_used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (org_id, name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, hint=EXCLUDED.hint`,
        [
          metadata.orgId, metadata.name, metadata.id, ciphertext, metadata.hint,
          metadata.createdAt, metadata.createdBy, metadata.lastUsedAt,
        ],
      );
      return metadata;
    },
    getMetadata: async (orgId, name) => {
      const { rows } = await this.db.query(
        'SELECT org_id, name, id, hint, created_at, created_by, last_used_at FROM secrets WHERE org_id=$1 AND name=$2',
        [orgId, name],
      );
      return rows[0] ? toSecretMetadata(rows[0]) : null;
    },
    getCiphertext: async (orgId, name) => {
      const { rows } = await this.db.query('SELECT ciphertext FROM secrets WHERE org_id=$1 AND name=$2', [orgId, name]);
      return rows[0] ? String(rows[0]['ciphertext']) : null;
    },
    list: async (orgId) =>
      (
        await this.db.query(
          'SELECT org_id, name, id, hint, created_at, created_by, last_used_at FROM secrets WHERE org_id=$1 ORDER BY name',
          [orgId],
        )
      ).rows.map(toSecretMetadata),
    delete: async (orgId, name) => {
      const result = await this.db.query('DELETE FROM secrets WHERE org_id=$1 AND name=$2', [orgId, name]);
      return result.rowCount > 0;
    },
    touch: async (orgId, name, at) => {
      await this.db.query('UPDATE secrets SET last_used_at=$3 WHERE org_id=$1 AND name=$2', [orgId, name, at]);
    },
  };

  audit: AuditRepo = {
    record: async (entry: AuditLogRecord) => {
      await this.db.query(
        `INSERT INTO audit_log (id, org_id, actor_id, actor_type, action, resource_type, resource_id, at, metadata, ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          entry.id, entry.orgId, entry.actorId, entry.actorType, entry.action, entry.resourceType,
          entry.resourceId, entry.at, JSON.stringify(entry.metadata), entry.ip,
        ],
      );
      return entry;
    },
    list: async (orgId, filter = {}) => {
      const p = new Params();
      const where = [`org_id = ${p.add(orgId)}`];
      if (filter.actorId) where.push(`actor_id = ${p.add(filter.actorId)}`);
      if (filter.resourceType) where.push(`resource_type = ${p.add(filter.resourceType)}`);
      if (filter.since !== undefined) where.push(`at >= ${p.add(filter.since)}`);
      if (filter.cursor) where.push(`id < ${p.add(filter.cursor)}`);
      const limit = limitOf(filter);
      const { rows } = await this.db.query(
        `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${p.add(limit + 1)}`,
        p.values,
      );
      return pageOf(rows.map(toAudit), limit);
    },
  };

  idempotency: IdempotencyRepo = {
    claim: async (orgId, scope, key, now, ttlMs) => {
      // INSERT … ON CONFLICT DO NOTHING is the claim: exactly one caller gets a
      // row back, everyone else reads the stored response.
      const { rows } = await this.db.query(
        `INSERT INTO idempotency_keys (org_id, scope, key, response, completed, expires_at)
         VALUES ($1,$2,$3,NULL,FALSE,$4)
         ON CONFLICT (org_id, scope, key) DO UPDATE
           SET expires_at = EXCLUDED.expires_at
           WHERE idempotency_keys.expires_at <= $5
         RETURNING completed, response`,
        [orgId, scope, key, now + ttlMs, now],
      );
      if (rows[0]) return { claimed: true, response: null };
      const existing = await this.db.query(
        'SELECT response FROM idempotency_keys WHERE org_id=$1 AND scope=$2 AND key=$3',
        [orgId, scope, key],
      );
      return { claimed: false, response: json<JsonValue>(existing.rows[0]?.['response'], null) };
    },
    complete: async (orgId, scope, key, response) => {
      await this.db.query(
        'UPDATE idempotency_keys SET response=$4, completed=TRUE WHERE org_id=$1 AND scope=$2 AND key=$3',
        [orgId, scope, key, JSON.stringify(response)],
      );
    },
    purge: async (now) => {
      const result = await this.db.query('DELETE FROM idempotency_keys WHERE expires_at <= $1', [now]);
      return result.rowCount;
    },
  };

  metrics: MetricsRepo = {
    agentMetrics: async (orgId, agentId, windowStart, windowEnd) => {
      const { rows } = await this.db.query(
        `SELECT
           COUNT(*)::int AS executions,
           COUNT(*) FILTER (WHERE status='completed')::int AS completed,
           COUNT(*) FILTER (WHERE status='failed')::int AS failed,
           COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
           COUNT(*) FILTER (WHERE status='awaiting_approval')::int AS awaiting,
           COALESCE(SUM((usage->>'costMicroUsd')::bigint),0) AS cost,
           COALESCE(SUM((usage->>'totalTokens')::bigint),0) AS tokens,
           COALESCE(SUM((usage->>'toolCalls')::bigint),0) AS tool_calls,
           COALESCE(SUM((usage->>'modelCalls')::bigint),0) AS model_calls,
           COALESCE(SUM((usage->>'retries')::bigint),0) AS retries,
           COALESCE(SUM((usage->>'approvals')::bigint),0) AS approvals,
           COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY finished_at - started_at)
             FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL), 0) AS p50,
           COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY finished_at - started_at)
             FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL), 0) AS p95
         FROM executions
         WHERE org_id=$1 AND agent_id=$2 AND created_at BETWEEN $3 AND $4`,
        [orgId, agentId, windowStart, windowEnd],
      );
      const r = rows[0] ?? {};
      const completed = num(r['completed']);
      const failed = num(r['failed']);
      const settled = completed + failed;
      const metrics: AgentMetrics = {
        agentId,
        windowStart,
        windowEnd,
        executions: num(r['executions']),
        completed,
        failed,
        cancelled: num(r['cancelled']),
        awaitingApproval: num(r['awaiting']),
        successRate: settled === 0 ? 0 : completed / settled,
        p50DurationMs: Math.round(num(r['p50'])),
        p95DurationMs: Math.round(num(r['p95'])),
        totalCostMicroUsd: num(r['cost']),
        totalTokens: num(r['tokens']),
        toolCalls: num(r['tool_calls']),
        modelCalls: num(r['model_calls']),
        retries: num(r['retries']),
        approvals: num(r['approvals']),
      };
      return metrics;
    },
    orgTotals: async (orgId, windowStart, windowEnd) => {
      const { rows } = await this.db.query(
        `SELECT COUNT(*)::int AS executions,
                COUNT(*) FILTER (WHERE status='completed')::int AS completed,
                COUNT(*) FILTER (WHERE status='failed')::int AS failed,
                COALESCE(SUM((usage->>'costMicroUsd')::bigint),0) AS cost,
                COALESCE(SUM((usage->>'totalTokens')::bigint),0) AS tokens,
                COALESCE(SUM((usage->>'toolCalls')::bigint),0) AS tool_calls,
                COALESCE(SUM((usage->>'modelCalls')::bigint),0) AS model_calls,
                COALESCE(SUM((usage->>'approvals')::bigint),0) AS approvals
         FROM executions WHERE org_id=$1 AND created_at BETWEEN $2 AND $3`,
        [orgId, windowStart, windowEnd],
      );
      const r = rows[0] ?? {};
      return {
        executions: num(r['executions']),
        completed: num(r['completed']),
        failed: num(r['failed']),
        costMicroUsd: num(r['cost']),
        totalTokens: num(r['tokens']),
        toolCalls: num(r['tool_calls']),
        modelCalls: num(r['model_calls']),
        approvals: num(r['approvals']),
      };
    },
    costByAgent: async (orgId, windowStart, windowEnd) => {
      const { rows } = await this.db.query(
        `SELECT agent_id, COALESCE(SUM((usage->>'costMicroUsd')::bigint),0) AS cost, COUNT(*)::int AS executions
         FROM executions WHERE org_id=$1 AND created_at BETWEEN $2 AND $3
         GROUP BY agent_id ORDER BY cost DESC`,
        [orgId, windowStart, windowEnd],
      );
      return rows.map((r) => ({
        agentId: String(r['agent_id']),
        costMicroUsd: num(r['cost']),
        executions: num(r['executions']),
      }));
    },
    costByModel: async (orgId, windowStart, windowEnd) => {
      const { rows } = await this.db.query(
        `SELECT (payload->>'provider') || ':' || (payload->>'model') AS model,
                COALESCE(SUM((payload->>'costMicroUsd')::bigint),0) AS cost,
                COUNT(*)::int AS calls
         FROM events
         WHERE org_id=$1 AND type='model.call_succeeded' AND at BETWEEN $2 AND $3
         GROUP BY 1 ORDER BY cost DESC`,
        [orgId, windowStart, windowEnd],
      );
      return rows.map((r) => ({ model: String(r['model']), costMicroUsd: num(r['cost']), calls: num(r['calls']) }));
    },
    toolUsage: async (orgId, windowStart, windowEnd) => {
      const { rows } = await this.db.query(
        `SELECT payload->>'toolName' AS tool,
                COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE type='tool.failed')::int AS failures,
                COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (payload->>'durationMs')::bigint), 0) AS p95
         FROM events
         WHERE org_id=$1 AND type IN ('tool.succeeded','tool.failed') AND at BETWEEN $2 AND $3
         GROUP BY 1 ORDER BY calls DESC`,
        [orgId, windowStart, windowEnd],
      );
      return rows.map((r) => ({
        tool: String(r['tool']),
        calls: num(r['calls']),
        failures: num(r['failures']),
        p95DurationMs: Math.round(num(r['p95'])),
      }));
    },
  };
}
