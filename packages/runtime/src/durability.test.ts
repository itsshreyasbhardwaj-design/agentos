import { describe, expect, it } from 'vitest';
import { ExecutionWorker } from './worker.js';
import { answerTurn, createHarness, ORG_ID, PRINCIPAL, toolCallTurn } from './test-harness.js';

describe('worker recovery', () => {
  it('reclaims an execution whose worker stopped heartbeating and resumes it', async () => {
    const h = await createHarness({
      turns: [toolCallTurn('math.evaluate', { expression: '1+1' }), answerTurn('2')],
    });
    const slug = await h.publishAgent({
      permissions: { allowedTools: ['math.evaluate'], allowedOperations: ['read'] },
    });
    const execution = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'add' });

    // Simulate a worker that took the execution and then died: it holds a lease
    // and left the row `running`, but nothing is heartbeating any more.
    await h.store.executions.update(ORG_ID, execution.id, { patch: { status: 'running' } });
    await h.store.executions.acquireLease(ORG_ID, execution.id, 'dead-worker', 30_000, h.clock.now());
    await h.queue.purge();

    expect((await h.recovery.sweep()).executionsRecovered).toBe(0);

    h.clock.advance(31_000);
    const swept = await h.recovery.sweep();
    expect(swept.executionsRecovered).toBe(1);

    const requeued = await h.store.executions.get(ORG_ID, execution.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.attempt).toBe(1);
    expect(requeued?.lease).toBeNull();

    await h.drain();
    expect((await h.store.executions.get(ORG_ID, execution.id))?.status).toBe('completed');
  });

  it('does not let a second worker run an execution that is already leased', async () => {
    const h = await createHarness({ turns: [answerTurn('done')] });
    const slug = await h.publishAgent({});
    const execution = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'go' });

    await h.store.executions.acquireLease(ORG_ID, execution.id, 'other-worker', 30_000, h.clock.now());

    const second = new ExecutionWorker(h.ctx, { workerId: 'worker-2' });
    await second.runOnce();

    expect(h.provider.callCount).toBe(0);
    expect((await h.store.executions.get(ORG_ID, execution.id))?.status).toBe('queued');
  });

  it('resumes from persisted state rather than restarting the run', async () => {
    const h = await createHarness({
      turns: [
        toolCallTurn('math.evaluate', { expression: '10*10' }),
        answerTurn('100'),
      ],
    });
    const slug = await h.publishAgent({
      permissions: { allowedTools: ['math.evaluate'], allowedOperations: ['read'] },
    });
    const execution = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'multiply' });
    await h.drain();

    const finished = await h.store.executions.get(ORG_ID, execution.id);
    expect(finished?.status).toBe('completed');
    // Two model calls total: the tool-call turn and the final answer. If the
    // engine had restarted after the tool call it would have spent more.
    expect(finished?.usage.modelCalls).toBe(2);
    expect(h.provider.callCount).toBe(2);
  });

  it('marks an execution cancelled and stops processing it', async () => {
    const h = await createHarness({ turns: [answerTurn('should not run')] });
    const slug = await h.publishAgent({});
    const execution = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'go' });
    await h.executions.cancel(PRINCIPAL, execution.id, 'changed my mind');

    await h.drain();
    const cancelled = await h.store.executions.get(ORG_ID, execution.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(h.provider.callCount).toBe(0);
  });
});

describe('replay', () => {
  it('reproduces the original run without calling the model or the tool again', async () => {
    let httpCalls = 0;
    const h = await createHarness({
      turns: [
        toolCallTurn('http.get', { url: 'https://api.allowed.example/data' }),
        answerTurn('The API returned ok.'),
      ],
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: (async () => {
        httpCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const slug = await h.publishAgent({
      permissions: {
        allowedTools: ['http.get'],
        allowedOperations: ['read', 'network'],
        allowedDomains: ['api.allowed.example'],
      },
    });

    const original = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'fetch data' });
    await h.drain();
    expect((await h.store.executions.get(ORG_ID, original.id))?.status).toBe('completed');
    expect(httpCalls).toBe(1);

    const modelCallsBefore = h.provider.callCount;
    const replay = await h.executions.replay(PRINCIPAL, original.id);
    await h.drain();

    const replayed = await h.store.executions.get(ORG_ID, replay.id);
    expect(replayed?.status).toBe('completed');
    expect(replayed?.mode).toBe('replay');
    expect(replayed?.replayOfExecutionId).toBe(original.id);
    expect(replayed?.output).toBe('The API returned ok.');

    // Nothing was bought and nothing was re-fetched.
    expect(h.provider.callCount).toBe(modelCallsBefore);
    expect(httpCalls).toBe(1);
    expect(replayed?.usage.costMicroUsd).toBe(0);
  });

  it('never executes a destructive tool during a replay', async () => {
    let deletes = 0;
    const h = await createHarness({
      turns: [
        toolCallTurn('http.delete', { url: 'https://api.allowed.example/thing' }),
        answerTurn('deleted'),
      ],
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') deletes += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    const slug = await h.publishAgent({
      permissions: {
        allowedTools: ['http.delete'],
        allowedOperations: ['delete', 'network'],
        allowedDomains: ['api.allowed.example'],
      },
    });

    const original = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'delete it' });
    await h.drain();
    const approval = (await h.store.approvals.listPending(ORG_ID)).items[0];
    await h.executions.decideApproval(PRINCIPAL, approval?.id as string, { approve: true });
    await h.drain();
    expect(deletes).toBe(1);

    const replay = await h.executions.replay(PRINCIPAL, original.id);
    await h.drain();

    // The baseline policy blocks destructive tools in replay mode outright.
    expect(deletes).toBe(1);
    const events = await h.store.events.listForExecution(ORG_ID, replay.id);
    const denied = events.find((e) => e.type === 'tool.denied');
    expect((denied?.payload as { ruleId: string }).ruleId).toBe('baseline:no_destructive_in_replay');
  });

  it('refuses to replay a replay', async () => {
    const h = await createHarness({ turns: [answerTurn('ok')] });
    const slug = await h.publishAgent({});
    const original = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'go' });
    await h.drain();
    const replay = await h.executions.replay(PRINCIPAL, original.id);
    await expect(h.executions.replay(PRINCIPAL, replay.id)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('pins the replay to the version the original ran, not the current one', async () => {
    const h = await createHarness({ turns: [answerTurn('v1 answer'), answerTurn('v1 answer')] });
    const slug = await h.publishAgent({});
    const original = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'go' });
    await h.drain();

    // Publish a new version after the original run.
    const agent = await h.agents.getBySlugOrId(ORG_ID, slug);
    await h.agents.updateDraft(PRINCIPAL, agent.id, { spec: { instructions: 'Completely different now.' } });
    const v2 = await h.agents.publish(PRINCIPAL, agent.id);

    const replay = await h.executions.replay(PRINCIPAL, original.id);
    expect(replay.agentVersionId).not.toBe(v2.id);
    expect(replay.agentVersionId).toBe(original.agentVersionId);
  });
});

describe('versioning', () => {
  it('records the exact version each execution used', async () => {
    const h = await createHarness({ turns: [answerTurn('one'), answerTurn('two')] });
    const slug = await h.publishAgent({});
    const agent = await h.agents.getBySlugOrId(ORG_ID, slug);

    const first = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'a' });
    await h.agents.updateDraft(PRINCIPAL, agent.id, { spec: { instructions: 'Second revision.' } });
    const v2 = await h.agents.publish(PRINCIPAL, agent.id);
    const second = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'b' });

    expect(first.versionNumber).toBe(1);
    expect(second.versionNumber).toBe(2);
    expect(second.agentVersionId).toBe(v2.id);
  });

  it('refuses to publish an unchanged draft unless forced', async () => {
    const h = await createHarness({ turns: [answerTurn('x')] });
    const slug = await h.publishAgent({});
    const agent = await h.agents.getBySlugOrId(ORG_ID, slug);
    await expect(h.agents.publish(PRINCIPAL, agent.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.agents.publish(PRINCIPAL, agent.id, { force: true })).resolves.toMatchObject({ version: 2 });
  });

  it('rolls back to an earlier version', async () => {
    const h = await createHarness({ turns: [answerTurn('x')] });
    const slug = await h.publishAgent({});
    const agent = await h.agents.getBySlugOrId(ORG_ID, slug);
    const v1 = agent.publishedVersionId as string;

    await h.agents.updateDraft(PRINCIPAL, agent.id, { spec: { instructions: 'v2 instructions' } });
    await h.agents.publish(PRINCIPAL, agent.id);

    const rolledBack = await h.agents.rollback(PRINCIPAL, agent.id, v1);
    expect(rolledBack.publishedVersionId).toBe(v1);
    expect((await h.store.agents.listVersions(ORG_ID, agent.id))).toHaveLength(2);
  });

  it('will not run an agent that was never published', async () => {
    const h = await createHarness({ turns: [answerTurn('x')] });
    await h.agents.create(PRINCIPAL, {
      slug: 'unpublished',
      name: 'Unpublished',
      spec: { model: { primary: 'scripted:test' }, instructions: 'hi' },
    });
    await expect(h.executions.run(PRINCIPAL, { agentRef: 'unpublished', input: 'go' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('idempotency', () => {
  it('returns the same execution for a repeated idempotency key', async () => {
    const h = await createHarness({ turns: [answerTurn('once')] });
    const slug = await h.publishAgent({});
    const a = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'go', idempotencyKey: 'k-1' });
    const b = await h.executions.run(PRINCIPAL, { agentRef: slug, input: 'go', idempotencyKey: 'k-1' });
    expect(b.id).toBe(a.id);

    await h.drain();
    expect((await h.store.executions.list(ORG_ID)).items).toHaveLength(1);
  });
});
