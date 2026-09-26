import { newId } from '@agentos/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, approval, event, execution, ORG_A, ORG_B, org, task, user } from './conformance.js';
import { InMemoryStore } from './in-memory.js';
import { PgliteDriver } from './sql/driver.js';
import { SqlStore } from './sql/store.js';
import type { Store } from './types.js';

/**
 * One suite, two backends. The in-memory store and the Postgres store must be
 * indistinguishable through the `Store` interface, so the same assertions run
 * against both — the SQL side executes for real against PGlite (Postgres
 * compiled to WASM), not a mock.
 */
const backends: Array<{ name: string; create: () => Promise<Store>; reset: (s: Store) => Promise<void> }> = [
  {
    name: 'InMemoryStore',
    create: async () => {
      const store = new InMemoryStore();
      await store.init();
      return store;
    },
    reset: async (s) => {
      (s as InMemoryStore).reset();
    },
  },
  {
    name: 'SqlStore (PGlite)',
    create: async () => {
      const driver = await PgliteDriver.create();
      const store = new SqlStore(driver);
      await store.init();
      return store;
    },
    reset: async (s) => {
      const sql = s as unknown as { db?: unknown };
      const driver = (sql as { db: { exec(q: string): Promise<unknown> } }).db;
      await driver.exec(
        `TRUNCATE orgs, users, memberships, api_keys, agents, agent_versions, executions, events,
         approvals, tasks, agent_messages, schedules, webhook_endpoints, webhook_deliveries,
         policies, secrets, audit_log, idempotency_keys CASCADE`,
      );
    },
  },
];

for (const backend of backends) {
  describe(backend.name, () => {
    let store: Store;

    beforeEach(async () => {
      store ??= await backend.create();
      await backend.reset(store);
      await store.orgs.create(org(ORG_A, 'acme'));
      await store.orgs.create(org(ORG_B, 'globex'));
      await store.users.upsert(user());
      await store.users.addMember({ orgId: ORG_A, userId: 'usr_1', role: 'admin', createdAt: 1_000 });
    });

    afterAll(async () => {
      await store?.close();
    });

    describe('tenant isolation', () => {
      it('never returns another org’s agent by id', async () => {
        const a = await store.agents.create(agent(ORG_A));
        expect(await store.agents.get(ORG_A, a.id)).not.toBeNull();
        expect(await store.agents.get(ORG_B, a.id)).toBeNull();
      });

      it('never returns another org’s execution by id', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        expect(await store.executions.get(ORG_B, e.id)).toBeNull();
        expect((await store.executions.list(ORG_B)).items).toHaveLength(0);
      });

      it('scopes approvals and tasks by org', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        const ap = await store.approvals.create(approval(ORG_A, e.id, a.id));
        expect(await store.approvals.get(ORG_B, ap.id)).toBeNull();
        const t = await store.tasks.create(task(ORG_A, a.id));
        expect(await store.tasks.get(ORG_B, t.id)).toBeNull();
      });

      it('rejects a duplicate agent slug within an org but allows it across orgs', async () => {
        await store.agents.create(agent(ORG_A, { slug: 'dup' }));
        await expect(store.agents.create(agent(ORG_A, { slug: 'dup' }))).rejects.toMatchObject({ code: 'conflict' });
        await expect(store.agents.create(agent(ORG_B, { slug: 'dup' }))).resolves.toBeDefined();
      });
    });

    describe('agents and versions', () => {
      it('round-trips an agent with its spec', async () => {
        const created = await store.agents.create(agent(ORG_A));
        const fetched = await store.agents.get(ORG_A, created.id);
        expect(fetched?.draft.model.primary).toBe('scripted:test');
        expect(fetched?.draft.limits.maxSteps).toBeGreaterThan(0);
      });

      it('lists versions newest first', async () => {
        const a = await store.agents.create(agent(ORG_A));
        for (const v of [1, 2, 3]) {
          await store.agents.createVersion({
            id: newId('version'), agentId: a.id, orgId: ORG_A, version: v,
            spec: a.draft, status: 'published', changelog: `v${v}`,
            publishedAt: 1_000 + v, publishedBy: 'usr_1', specHash: `hash${v}`,
          });
        }
        expect((await store.agents.listVersions(ORG_A, a.id)).map((v) => v.version)).toEqual([3, 2, 1]);
      });

      it('filters archived agents out by default', async () => {
        const a = await store.agents.create(agent(ORG_A, { slug: 'gone' }));
        await store.agents.archive(ORG_A, a.id);
        expect((await store.agents.list(ORG_A)).items).toHaveLength(0);
        expect((await store.agents.list(ORG_A, { includeArchived: true })).items).toHaveLength(1);
      });
    });

    describe('execution state machine', () => {
      it('refuses an illegal transition', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id, { status: 'completed' }));
        await expect(
          store.executions.update(ORG_A, e.id, { patch: { status: 'running' } }),
        ).rejects.toMatchObject({ code: 'state_invalid' });
      });

      it('honours an expectedStatus guard', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id, { status: 'queued' }));
        await expect(
          store.executions.update(ORG_A, e.id, { expectedStatus: ['running'], patch: { status: 'completed' } }),
        ).rejects.toMatchObject({ code: 'state_invalid' });
        await expect(
          store.executions.update(ORG_A, e.id, { expectedStatus: ['queued'], patch: { status: 'running' } }),
        ).resolves.toMatchObject({ status: 'running' });
      });

      it('persists execution state so a run can resume', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        await store.executions.update(ORG_A, e.id, {
          patch: {
            status: 'running',
            state: {
              messages: [{ role: 'user', content: 'hi' }],
              step: 2,
              pendingToolCalls: [{ id: 'tc_1', name: 'math.evaluate', arguments: { expression: '1+1' } }],
              completedToolCallIds: [],
              pendingApprovalIds: [],
              scratch: { note: 'keep' },
              toolCallCounts: { 'math.evaluate': 1 },
            },
          },
        });
        const reloaded = await store.executions.get(ORG_A, e.id);
        expect(reloaded?.state.step).toBe(2);
        expect(reloaded?.state.pendingToolCalls[0]?.name).toBe('math.evaluate');
        expect(reloaded?.state.scratch).toEqual({ note: 'keep' });
      });

      it('collapses duplicate creates on an idempotency key', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const first = await store.executions.create(execution(ORG_A, a.id, { idempotencyKey: 'run-1' }));
        const second = await store.executions.create(execution(ORG_A, a.id, { idempotencyKey: 'run-1' }));
        expect(second.id).toBe(first.id);
      });
    });

    describe('worker leases', () => {
      it('grants a lease to one worker and refuses the other', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        expect(await store.executions.acquireLease(ORG_A, e.id, 'w1', 1_000, 10_000)).not.toBeNull();
        expect(await store.executions.acquireLease(ORG_A, e.id, 'w2', 1_000, 10_500)).toBeNull();
      });

      it('lets another worker take over once the lease expires', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        await store.executions.acquireLease(ORG_A, e.id, 'w1', 1_000, 10_000);
        expect(await store.executions.acquireLease(ORG_A, e.id, 'w2', 1_000, 11_001)).not.toBeNull();
      });

      it('only lets the holder renew or release', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        await store.executions.acquireLease(ORG_A, e.id, 'w1', 1_000, 10_000);
        expect(await store.executions.renewLease(ORG_A, e.id, 'w2', 1_000, 10_100)).toBe(false);
        expect(await store.executions.renewLease(ORG_A, e.id, 'w1', 1_000, 10_100)).toBe(true);
        expect(await store.executions.releaseLease(ORG_A, e.id, 'w2')).toBe(false);
        expect(await store.executions.releaseLease(ORG_A, e.id, 'w1')).toBe(true);
      });

      it('surfaces expired leases for recovery', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        await store.executions.update(ORG_A, e.id, { patch: { status: 'running' } });
        await store.executions.acquireLease(ORG_A, e.id, 'w1', 1_000, 10_000);
        expect(await store.executions.findExpiredLeases(10_500)).toHaveLength(0);
        expect((await store.executions.findExpiredLeases(11_001)).map((x) => x.id)).toEqual([e.id]);
      });
    });

    describe('events', () => {
      it('stores and replays events in sequence order', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        await store.events.append([event(ORG_A, e.id, 2), event(ORG_A, e.id, 1)]);
        const listed = await store.events.listForExecution(ORG_A, e.id);
        expect(listed.map((x) => x.seq)).toEqual([1, 2]);
        expect(await store.events.maxSeq(ORG_A, e.id)).toBe(2);
      });

      it('supports incremental tailing', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        await store.events.append([event(ORG_A, e.id, 1), event(ORG_A, e.id, 2), event(ORG_A, e.id, 3)]);
        expect((await store.events.listForExecution(ORG_A, e.id, { sinceSeq: 1 })).map((x) => x.seq)).toEqual([2, 3]);
      });

      it('ignores a duplicate sequence rather than corrupting the log', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        const one = event(ORG_A, e.id, 1);
        await store.events.append([one]);
        await store.events.append([one]);
        expect(await store.events.listForExecution(ORG_A, e.id)).toHaveLength(1);
      });
    });

    describe('approvals', () => {
      it('allows exactly one decision', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        const ap = await store.approvals.create(approval(ORG_A, e.id, a.id));
        await store.approvals.decide(ORG_A, ap.id, { status: 'approved', by: 'usr_1', at: 4_000 });
        await expect(
          store.approvals.decide(ORG_A, ap.id, { status: 'rejected', by: 'usr_2', at: 4_100 }),
        ).rejects.toMatchObject({ code: 'conflict' });
      });

      it('preserves edited arguments', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        const ap = await store.approvals.create(approval(ORG_A, e.id, a.id));
        const decided = await store.approvals.decide(ORG_A, ap.id, {
          status: 'approved', by: 'usr_1', at: 4_000,
          editedArguments: { url: 'https://api.example.com/safe' },
        });
        expect(decided.editedArguments).toEqual({ url: 'https://api.example.com/safe' });
      });

      it('expires overdue approvals', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        await store.approvals.create(approval(ORG_A, e.id, a.id, { expiresAt: 5_000 }));
        expect(await store.approvals.expireOverdue(4_999)).toHaveLength(0);
        expect(await store.approvals.expireOverdue(5_001)).toHaveLength(1);
        expect((await store.approvals.listPending(ORG_A)).items).toHaveLength(0);
      });
    });

    describe('tasks', () => {
      it('finds tasks whose dependencies have all completed', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const dep = await store.tasks.create(task(ORG_A, a.id, { title: 'dep' }));
        const blocked = await store.tasks.create(
          task(ORG_A, a.id, { title: 'blocked', status: 'blocked', dependsOn: [dep.id] }),
        );
        expect(await store.tasks.findUnblocked(ORG_A, 0)).toHaveLength(0);
        await store.tasks.update(ORG_A, dep.id, { status: 'completed' });
        expect((await store.tasks.findUnblocked(ORG_A, 0)).map((t) => t.id)).toEqual([blocked.id]);
      });
    });

    describe('schedules', () => {
      it('claims a firing exactly once', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const s = await store.schedules.create({
          id: newId('schedule'), orgId: ORG_A, agentId: a.id, name: 'nightly', kind: 'cron',
          expression: '0 3 * * *', timezone: 'UTC', input: {}, enabled: true,
          createdAt: 1_000, updatedAt: 1_000, lastRunAt: null, nextRunAt: 5_000, createdBy: 'usr_1',
        });
        expect((await store.schedules.due(5_000)).map((x) => x.id)).toEqual([s.id]);
        expect(await store.schedules.claim(s.id, 5_000, 90_000)).toBe(true);
        expect(await store.schedules.claim(s.id, 5_000, 90_000)).toBe(false);
        expect(await store.schedules.due(5_000)).toHaveLength(0);
      });
    });

    describe('webhooks', () => {
      it('rejects a replayed delivery', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const endpoint = await store.webhooks.createEndpoint({
          id: newId('webhook'), orgId: ORG_A, agentId: a.id, name: 'gh', provider: 'github',
          signingSecretName: 'GH_SECRET', enabled: true, toleranceSeconds: 300,
          rateLimitPerMinute: 60, createdAt: 1_000, createdBy: 'usr_1',
        });
        const delivery = {
          id: newId('webhook'), orgId: ORG_A, endpointId: endpoint.id, dedupeKey: 'evt_123',
          receivedAt: 2_000, accepted: true, rejectionReason: null, executionId: null,
        };
        expect(await store.webhooks.recordDelivery(delivery)).not.toBeNull();
        expect(await store.webhooks.recordDelivery({ ...delivery, id: newId('webhook') })).toBeNull();
      });
    });

    describe('idempotency', () => {
      it('lets the first caller through and replays the stored response after', async () => {
        const first = await store.idempotency.claim(ORG_A, 'runs', 'k1', 1_000, 60_000);
        expect(first.claimed).toBe(true);
        await store.idempotency.complete(ORG_A, 'runs', 'k1', { executionId: 'exec_1' });
        const second = await store.idempotency.claim(ORG_A, 'runs', 'k1', 1_100, 60_000);
        expect(second.claimed).toBe(false);
        expect(second.response).toEqual({ executionId: 'exec_1' });
      });

      it('lets the key be reused once it expires', async () => {
        await store.idempotency.claim(ORG_A, 'runs', 'k2', 1_000, 10);
        const later = await store.idempotency.claim(ORG_A, 'runs', 'k2', 2_000, 10);
        expect(later.claimed).toBe(true);
      });
    });

    describe('metrics', () => {
      it('aggregates only settled executions into the success rate', async () => {
        const a = await store.agents.create(agent(ORG_A));
        await store.executions.create(
          execution(ORG_A, a.id, {
            status: 'completed', startedAt: 2_000, finishedAt: 2_500,
            usage: { modelCalls: 2, toolCalls: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150, costMicroUsd: 400, retries: 1, approvals: 0, steps: 2 },
          }),
        );
        await store.executions.create(
          execution(ORG_A, a.id, {
            status: 'failed', startedAt: 2_000, finishedAt: 2_100,
            usage: { modelCalls: 1, toolCalls: 0, inputTokens: 50, outputTokens: 10, totalTokens: 60, costMicroUsd: 100, retries: 0, approvals: 0, steps: 1 },
          }),
        );
        await store.executions.create(execution(ORG_A, a.id, { status: 'running' }));

        const metrics = await store.metrics.agentMetrics(ORG_A, a.id, 0, 10_000);
        expect(metrics.executions).toBe(3);
        expect(metrics.completed).toBe(1);
        expect(metrics.failed).toBe(1);
        expect(metrics.successRate).toBe(0.5);
        expect(metrics.totalCostMicroUsd).toBe(500);
        expect(metrics.totalTokens).toBe(210);
        expect(metrics.p95DurationMs).toBeGreaterThan(0);
      });

      it('reports zero success rate when nothing has settled', async () => {
        const a = await store.agents.create(agent(ORG_A));
        await store.executions.create(execution(ORG_A, a.id, { status: 'running' }));
        expect((await store.metrics.agentMetrics(ORG_A, a.id, 0, 10_000)).successRate).toBe(0);
      });

      it('breaks cost down by model from the event log', async () => {
        const a = await store.agents.create(agent(ORG_A));
        const e = await store.executions.create(execution(ORG_A, a.id));
        await store.events.append([
          event(ORG_A, e.id, 1, {
            type: 'model.call_succeeded',
            payload: {
              provider: 'scripted', model: 'test', inputTokens: 10, outputTokens: 5,
              costMicroUsd: 250, finishReason: 'stop', toolCallCount: 0,
            },
          } as never),
        ]);
        const byModel = await store.metrics.costByModel(ORG_A, 0, 10_000);
        expect(byModel).toEqual([{ model: 'scripted:test', costMicroUsd: 250, calls: 1 }]);
      });
    });

    describe('pagination', () => {
      it('walks pages with a stable cursor', async () => {
        const a = await store.agents.create(agent(ORG_A));
        for (let i = 0; i < 5; i++) await store.executions.create(execution(ORG_A, a.id));
        const first = await store.executions.list(ORG_A, { limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();
        const second = await store.executions.list(ORG_A, { limit: 2, cursor: first.nextCursor });
        expect(second.items).toHaveLength(2);
        const ids = new Set([...first.items, ...second.items].map((e) => e.id));
        expect(ids.size).toBe(4);
      });
    });
  });
}
