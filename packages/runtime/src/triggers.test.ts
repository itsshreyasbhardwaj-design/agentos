import { newId } from '@agentos/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_DELEGATION_DEPTH } from './multi-agent.js';
import { Scheduler } from './scheduler.js';
import { signCustomWebhook, WebhookService } from './webhooks.js';
import { answerTurn, createHarness, ORG_ID, PRINCIPAL } from './test-harness.js';

describe('scheduler', () => {
  it('fires a due schedule exactly once and arms the next run', async () => {
    const h = await createHarness({ turns: [answerTurn('morning report')] });
    const slug = await h.publishAgent({});
    const scheduler = new Scheduler(h.ctx);

    const schedule = await scheduler.create(PRINCIPAL, {
      agentRef: slug,
      name: 'daily-report',
      kind: 'cron',
      expression: '0 9 * * *',
    });
    expect(schedule.nextRunAt).not.toBeNull();

    expect(await scheduler.tick()).toBe(0);

    h.clock.set((schedule.nextRunAt as number) + 1_000);
    expect(await scheduler.tick()).toBe(1);
    // A second tick in the same window must not double-fire.
    expect(await scheduler.tick()).toBe(0);

    const executions = await h.store.executions.list(ORG_ID);
    expect(executions.items).toHaveLength(1);
    expect(executions.items[0]?.trigger.type).toBe('schedule');

    const reloaded = await h.store.schedules.get(ORG_ID, schedule.id);
    expect(reloaded?.nextRunAt).toBeGreaterThan(schedule.nextRunAt as number);
    expect(reloaded?.lastRunAt).toBe(schedule.nextRunAt);
  });

  it('two schedulers racing the same slot produce one execution', async () => {
    const h = await createHarness({ turns: [answerTurn('x')] });
    const slug = await h.publishAgent({});
    const a = new Scheduler(h.ctx);
    const b = new Scheduler(h.ctx);

    const schedule = await a.create(PRINCIPAL, {
      agentRef: slug, name: 'hourly', kind: 'interval', expression: '3600000',
    });
    h.clock.set((schedule.nextRunAt as number) + 1);

    const [firedA, firedB] = await Promise.all([a.tick(), b.tick()]);
    expect(firedA + firedB).toBe(1);
    expect((await h.store.executions.list(ORG_ID)).items).toHaveLength(1);
  });

  it('does not backfill missed runs when a schedule is re-enabled', async () => {
    const h = await createHarness({ turns: [answerTurn('x')] });
    const slug = await h.publishAgent({});
    const scheduler = new Scheduler(h.ctx);
    const schedule = await scheduler.create(PRINCIPAL, {
      agentRef: slug, name: 'nightly', kind: 'cron', expression: '0 3 * * *',
    });

    await scheduler.setEnabled(PRINCIPAL, schedule.id, false);
    h.clock.advance(7 * 24 * 60 * 60 * 1_000);
    const reEnabled = await scheduler.setEnabled(PRINCIPAL, schedule.id, true);

    expect(reEnabled.nextRunAt).toBeGreaterThan(h.clock.now());
    expect(await scheduler.tick()).toBe(0);
  });

  it('rejects an unparseable cron expression at creation time', async () => {
    const h = await createHarness({ turns: [answerTurn('x')] });
    const slug = await h.publishAgent({});
    const scheduler = new Scheduler(h.ctx);
    await expect(
      scheduler.create(PRINCIPAL, { agentRef: slug, name: 'bad', kind: 'cron', expression: 'not a cron' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('webhooks', () => {
  async function setup() {
    const h = await createHarness({ turns: [answerTurn('handled')], secrets: { WH_SECRET: 'whsec_test_value' } });
    const slug = await h.publishAgent({});
    const agent = await h.agents.getBySlugOrId(ORG_ID, slug);
    const endpoint = await h.store.webhooks.createEndpoint({
      id: newId('webhook'),
      orgId: ORG_ID,
      agentId: agent.id,
      name: 'custom-hook',
      provider: 'custom',
      signingSecretName: 'WH_SECRET',
      enabled: true,
      toleranceSeconds: 300,
      rateLimitPerMinute: 60,
      createdAt: h.clock.now(),
      createdBy: PRINCIPAL.userId,
    });
    return { h, endpoint, service: new WebhookService(h.ctx) };
  }

  it('accepts a correctly signed delivery and starts a run', async () => {
    const { h, endpoint, service } = await setup();
    const body = JSON.stringify({ event: 'deploy.finished' });
    const headers = {
      ...signCustomWebhook('whsec_test_value', body, Math.floor(h.clock.now() / 1_000)),
      'x-agentos-event-id': 'evt_1',
    };

    const result = await service.handle({ endpointId: endpoint.id, headers, rawBody: body });
    expect(result.accepted).toBe(true);
    expect(result.executionId).not.toBeNull();
  });

  it('rejects a forged signature', async () => {
    const { h, endpoint, service } = await setup();
    const body = JSON.stringify({ event: 'deploy.finished' });
    const headers = {
      'x-agentos-timestamp': String(Math.floor(h.clock.now() / 1_000)),
      'x-agentos-signature': 'deadbeef'.repeat(8),
    };
    const result = await service.handle({ endpointId: endpoint.id, headers, rawBody: body });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/signature mismatch/);
    expect((await h.store.executions.list(ORG_ID)).items).toHaveLength(0);
  });

  it('rejects a body tampered with after signing', async () => {
    const { h, endpoint, service } = await setup();
    const signed = JSON.stringify({ amount: 10 });
    const headers = signCustomWebhook('whsec_test_value', signed, Math.floor(h.clock.now() / 1_000));
    const result = await service.handle({
      endpointId: endpoint.id,
      headers,
      rawBody: JSON.stringify({ amount: 1_000_000 }),
    });
    expect(result.accepted).toBe(false);
  });

  it('rejects a replayed delivery', async () => {
    const { h, endpoint, service } = await setup();
    const body = JSON.stringify({ event: 'x' });
    const headers = {
      ...signCustomWebhook('whsec_test_value', body, Math.floor(h.clock.now() / 1_000)),
      'x-agentos-event-id': 'evt_replay',
    };

    expect((await service.handle({ endpointId: endpoint.id, headers, rawBody: body })).accepted).toBe(true);
    const second = await service.handle({ endpointId: endpoint.id, headers, rawBody: body });
    expect(second.accepted).toBe(false);
    expect(second.duplicate).toBe(true);
    expect((await h.store.executions.list(ORG_ID)).items).toHaveLength(1);
  });

  it('rejects a stale timestamp even with a valid signature', async () => {
    const { h, endpoint, service } = await setup();
    const body = JSON.stringify({ event: 'x' });
    const oldTimestamp = Math.floor(h.clock.now() / 1_000) - 3_600;
    const headers = signCustomWebhook('whsec_test_value', body, oldTimestamp);
    const result = await service.handle({ endpointId: endpoint.id, headers, rawBody: body });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/old/);
  });

  it('rejects an unknown endpoint without leaking whether it exists', async () => {
    const { service } = await setup();
    const result = await service.handle({ endpointId: 'whk_nope', headers: {}, rawBody: '{}' });
    expect(result).toMatchObject({ accepted: false, reason: 'unknown endpoint' });
  });

  it('verifies a GitHub signature', async () => {
    const { h, endpoint, service } = await setup();
    await h.store.webhooks.deleteEndpoint(ORG_ID, endpoint.id);
    const gh = await h.store.webhooks.createEndpoint({
      ...endpoint, id: newId('webhook'), provider: 'github', name: 'gh',
    });

    const body = JSON.stringify({ action: 'opened' });
    const { hmacSha256 } = await import('@agentos/core');
    const headers = {
      'x-hub-signature-256': `sha256=${hmacSha256('whsec_test_value', body)}`,
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'issues',
    };

    const ok = await service.handle({ endpointId: gh.id, headers, rawBody: body });
    expect(ok.accepted).toBe(true);

    const forged = await service.handle({
      endpointId: gh.id,
      headers: { ...headers, 'x-hub-signature-256': 'sha256=00', 'x-github-delivery': 'delivery-2' },
      rawBody: body,
    });
    expect(forged.accepted).toBe(false);
  });
});

describe('multi-agent delegation', () => {
  /** Drive several agents from one scripted provider by replaying a fixed sequence. */
  function scriptSequence(h: Awaited<ReturnType<typeof createHarness>>, responses: Array<Record<string, unknown>>) {
    let turn = 0;
    h.provider.setFallback(() => (responses[turn++] ?? { content: 'done' }) as never);
  }

  it('runs a sub-agent with its own permissions and returns its output', async () => {
    const h = await createHarness({});
    await h.publishAgent({ instructions: 'Research things.' }, 'researcher');
    const manager = await h.publishAgent(
      {
        instructions: 'Delegate research, then summarise.',
        permissions: { allowedTools: ['agent.delegate'], allowedOperations: ['write'] },
        delegatesTo: ['researcher'],
      },
      'manager',
    );

    scriptSequence(h, [
      { toolCalls: [{ name: 'agent.delegate', arguments: { agent: 'researcher', task: 'find the answer' } }] },
      { content: 'Research says: 42.' },
      { content: 'Summary: the answer is 42.' },
    ]);

    const execution = await h.executions.run(PRINCIPAL, { agentRef: manager, input: 'research and summarise' });
    await h.drain();

    const finished = await h.store.executions.get(ORG_ID, execution.id);
    expect(finished?.status).toBe('completed');
    expect(finished?.output).toBe('Summary: the answer is 42.');

    const children = (await h.store.executions.list(ORG_ID)).items.filter((e) => e.parentExecutionId === execution.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.status).toBe('completed');
    expect(children[0]?.trigger.type).toBe('agent');
    expect(children[0]?.output).toBe('Research says: 42.');
  });

  it('refuses delegation to an agent that is not declared in delegatesTo', async () => {
    const h = await createHarness({});
    await h.publishAgent({ instructions: 'Other.' }, 'other');
    const manager = await h.publishAgent(
      {
        instructions: 'Manager.',
        permissions: { allowedTools: ['agent.delegate'], allowedOperations: ['write'] },
        delegatesTo: [],
      },
      'manager2',
    );

    scriptSequence(h, [
      { toolCalls: [{ name: 'agent.delegate', arguments: { agent: 'other', task: 'do it' } }] },
      { content: 'I was not allowed to delegate.' },
    ]);

    const execution = await h.executions.run(PRINCIPAL, { agentRef: manager, input: 'delegate' });
    await h.drain();

    const finished = await h.store.executions.get(ORG_ID, execution.id);
    expect(finished?.status).toBe('completed');
    const children = (await h.store.executions.list(ORG_ID)).items.filter((e) => e.parentExecutionId === execution.id);
    expect(children).toHaveLength(0);
    const toolMessage = finished?.state.messages.filter((m) => m.role === 'tool').pop();
    expect(toolMessage && 'content' in toolMessage ? toolMessage.content : '').toMatch(/may not delegate/);
  });

  it('stops a delegation chain at the configured depth', async () => {
    const h = await createHarness({});
    await h.publishAgent(
      {
        instructions: 'Recurse.',
        permissions: { allowedTools: ['agent.delegate'], allowedOperations: ['write'] },
        delegatesTo: ['recurser'],
      },
      'recurser',
    );

    // Each execution delegates exactly once, then reports whatever came back —
    // so the only thing that can stop the chain is the depth guard.
    h.provider.setFallback(({ messages }) => {
      const alreadyDelegated = messages.some((m) => m.role === 'tool');
      return alreadyDelegated
        ? { content: 'reporting back' }
        : ({ toolCalls: [{ name: 'agent.delegate', arguments: { agent: 'recurser', task: 'again' } }] } as never);
    });

    await h.executions.run(PRINCIPAL, { agentRef: 'recurser', input: 'go' });
    await h.drain(60);

    const all = (await h.store.executions.list(ORG_ID, { limit: 100 })).items;
    const byId = new Map(all.map((e) => [e.id, e]));
    const depthOf = (id: string): number => {
      let depth = 0;
      let current = byId.get(id);
      while (current?.parentExecutionId) {
        depth += 1;
        current = byId.get(current.parentExecutionId);
      }
      return depth;
    };

    expect(Math.max(...all.map((e) => depthOf(e.id)))).toBe(DEFAULT_MAX_DELEGATION_DEPTH);

    // The deepest agent was told why it could not go further.
    const deepest = all.find((e) => depthOf(e.id) === DEFAULT_MAX_DELEGATION_DEPTH);
    const toolMessage = deepest?.state.messages.filter((m) => m.role === 'tool').pop();
    expect(toolMessage && 'content' in toolMessage ? toolMessage.content : '').toMatch(/delegation depth limit/);
  });
});
