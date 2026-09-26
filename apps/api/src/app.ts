import {
  AgentOSError,
  newId,
  TokenBucketLimiter,
  type JsonObject,
  type JsonValue,
  type Principal,
} from '@agentos/core';
import { buildTrace, type InMemoryEventBus } from '@agentos/events';
import {
  AgentService,
  ExecutionService,
  Scheduler,
  TaskService,
  WebhookService,
  type RuntimeContext,
} from '@agentos/runtime';
import { Hono } from 'hono';
import { authMiddleware, principalOf, requirePermission, type AuthOptions } from './auth.js';
import { toErrorResponse } from './errors.js';

export interface AppOptions {
  ctx: RuntimeContext;
  bus?: InMemoryEventBus;
  devPrincipal?: Principal;
  /** Requests per minute per API key. */
  rateLimitPerMinute?: number;
}

type Variables = { principal: Principal; requestId: string };

/**
 * Resolve a `?since`/`?until` window. `now` comes from the runtime clock rather
 * than `Date.now()` so every component in a deployment — and every test —
 * agrees on what "the last 7 days" means.
 */
function windowOf(
  c: { req: { query(name: string): string | undefined } },
  now: number,
): { since: number; until: number } {
  const since = Number(c.req.query('since') ?? now - 7 * 24 * 60 * 60 * 1_000);
  const until = Number(c.req.query('until') ?? now);
  return { since: Number.isFinite(since) ? since : 0, until: Number.isFinite(until) ? until : now };
}

function listQuery(c: { req: { query(name: string): string | undefined; queries(name: string): string[] | undefined } }) {
  const limit = Number(c.req.query('limit') ?? 50);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(1, limit), 200) : 50,
    cursor: c.req.query('cursor') ?? null,
  };
}

/**
 * The AgentOS control-plane API.
 *
 * Route handlers only validate, authorise and delegate: the work happens in the
 * runtime services. Nothing here runs an agent inline — `POST /run` returns as
 * soon as the execution is persisted and queued.
 */
export function createApp(options: AppOptions) {
  const { ctx } = options;
  const agents = new AgentService(ctx);
  const executions = new ExecutionService(ctx);
  const tasks = new TaskService(ctx);
  const scheduler = new Scheduler(ctx);
  const webhooks = new WebhookService(ctx);
  const limiter = new TokenBucketLimiter({ now: () => ctx.clock.now() });

  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? newId('audit');
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    await next();
  });

  app.onError((error, c) => {
    const { status, body } = toErrorResponse(error, c.get('requestId') ?? 'unknown', ctx.logger);
    return c.json(body, status as 400);
  });

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: `no route for ${c.req.method} ${c.req.path}`, requestId: c.get('requestId') } }, 404),
  );

  // --- public -------------------------------------------------------------

  app.get('/healthz', async (c) => {
    const [store, queue] = await Promise.all([ctx.store.healthCheck(), ctx.queue.stats()]);
    return c.json({ status: store ? 'ok' : 'degraded', store, queue, version: '0.1.0' }, store ? 200 : 503);
  });

  /**
   * Webhook intake. Unauthenticated by design: the signature is the credential,
   * and the raw body must be read exactly as sent for the HMAC to verify.
   */
  app.post('/v1/webhooks/:endpointId', async (c) => {
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const result = await webhooks.handle({
      endpointId: c.req.param('endpointId'),
      headers,
      rawBody,
    });

    if (result.duplicate) return c.json({ accepted: false, reason: 'duplicate delivery' }, 200);
    if (!result.accepted) return c.json({ accepted: false, reason: result.reason }, 401);
    return c.json({ accepted: true, executionId: result.executionId }, 202);
  });

  // --- authenticated ------------------------------------------------------

  const auth: AuthOptions = {
    store: ctx.store,
    now: () => ctx.clock.now(),
    ...(options.devPrincipal ? { devPrincipal: options.devPrincipal } : {}),
  };
  app.use('/v1/*', authMiddleware(auth));

  app.use('/v1/*', async (c, next) => {
    const principal = principalOf(c);
    const key = principal.apiKeyId ?? `${principal.orgId}:${principal.userId}`;
    const result = limiter.check(`api:${key}`, {
      limit: options.rateLimitPerMinute ?? 600,
      windowMs: 60_000,
    });
    c.header('x-ratelimit-limit', String(result.limit));
    c.header('x-ratelimit-remaining', String(result.remaining));
    if (!result.allowed) {
      c.header('retry-after', String(Math.ceil(result.retryAfterMs / 1_000)));
      throw new AgentOSError('rate_limited', 'API rate limit exceeded', {
        details: { retryAfterMs: result.retryAfterMs },
      });
    }
    await next();
  });

  // --- agents -------------------------------------------------------------

  app.post('/v1/agents', requirePermission('agent:write'), async (c) => {
    const body = await c.req.json<{ slug: string; name: string; description?: string; spec: never; labels?: Record<string, string> }>();
    const agent = await agents.create(principalOf(c), body);
    return c.json(agent, 201);
  });

  app.get('/v1/agents', requirePermission('agent:read'), async (c) => {
    const { limit, cursor } = listQuery(c);
    const search = c.req.query('search');
    const page = await ctx.store.agents.list(principalOf(c).orgId, {
      limit,
      cursor,
      ...(search ? { search } : {}),
      includeArchived: c.req.query('includeArchived') === 'true',
    });
    return c.json(page);
  });

  app.get('/v1/agents/:ref', requirePermission('agent:read'), async (c) => {
    return c.json(await agents.getBySlugOrId(principalOf(c).orgId, c.req.param('ref')));
  });

  app.patch('/v1/agents/:ref', requirePermission('agent:write'), async (c) => {
    const principal = principalOf(c);
    const agent = await agents.getBySlugOrId(principal.orgId, c.req.param('ref'));
    const body = await c.req.json<{ name?: string; description?: string; spec?: never; labels?: Record<string, string> }>();
    return c.json(await agents.updateDraft(principal, agent.id, body));
  });

  app.delete('/v1/agents/:ref', requirePermission('agent:delete'), async (c) => {
    const principal = principalOf(c);
    const agent = await agents.getBySlugOrId(principal.orgId, c.req.param('ref'));
    return c.json({ archived: await agents.archive(principal, agent.id) });
  });

  app.post('/v1/agents/:ref/publish', requirePermission('agent:publish'), async (c) => {
    const principal = principalOf(c);
    const agent = await agents.getBySlugOrId(principal.orgId, c.req.param('ref'));
    const body = await c.req.json<{ changelog?: string; force?: boolean }>().catch(() => ({}) as never);
    return c.json(await agents.publish(principal, agent.id, body), 201);
  });

  app.post('/v1/agents/:ref/rollback', requirePermission('agent:publish'), async (c) => {
    const principal = principalOf(c);
    const agent = await agents.getBySlugOrId(principal.orgId, c.req.param('ref'));
    const { versionId } = await c.req.json<{ versionId: string }>();
    return c.json(await agents.rollback(principal, agent.id, versionId));
  });

  app.get('/v1/agents/:ref/versions', requirePermission('agent:read'), async (c) => {
    const principal = principalOf(c);
    const agent = await agents.getBySlugOrId(principal.orgId, c.req.param('ref'));
    return c.json(await ctx.store.agents.listVersions(principal.orgId, agent.id));
  });

  app.get('/v1/agents/:ref/metrics', requirePermission('agent:read'), async (c) => {
    const principal = principalOf(c);
    const agent = await agents.getBySlugOrId(principal.orgId, c.req.param('ref'));
    const { since, until } = windowOf(c, ctx.clock.now());
    return c.json(await ctx.store.metrics.agentMetrics(principal.orgId, agent.id, since, until));
  });

  app.post('/v1/agents/:ref/run', requirePermission('execution:run'), async (c) => {
    const principal = principalOf(c);
    const body = await c.req.json<{ input: JsonValue; idempotencyKey?: string; labels?: Record<string, string>; versionId?: string; mode?: 'live' | 'demo' }>();
    const idempotencyKey = body.idempotencyKey ?? c.req.header('idempotency-key') ?? null;

    const execution = await executions.run(principal, {
      agentRef: c.req.param('ref'),
      input: body.input,
      idempotencyKey,
      ...(body.labels ? { labels: body.labels } : {}),
      ...(body.versionId ? { versionId: body.versionId } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
    });
    return c.json(execution, 202);
  });

  // --- executions ---------------------------------------------------------

  app.get('/v1/executions', requirePermission('execution:read'), async (c) => {
    const { limit, cursor } = listQuery(c);
    const statuses = c.req.queries('status');
    const agentId = c.req.query('agentId');
    const page = await ctx.store.executions.list(principalOf(c).orgId, {
      limit,
      cursor,
      ...(agentId ? { agentId } : {}),
      ...(statuses && statuses.length > 0 ? { status: statuses as never } : {}),
    });
    return c.json(page);
  });

  app.get('/v1/executions/:id', requirePermission('execution:read'), async (c) =>
    c.json(await executions.get(principalOf(c).orgId, c.req.param('id'))),
  );

  app.get('/v1/executions/:id/events', requirePermission('execution:read'), async (c) => {
    const principal = principalOf(c);
    // Confirm the execution belongs to this org before reading its event log.
    await executions.get(principal.orgId, c.req.param('id'));
    const sinceSeq = Number(c.req.query('sinceSeq') ?? 0);
    return c.json(
      await ctx.store.events.listForExecution(principal.orgId, c.req.param('id'), {
        sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : 0,
        limit: Number(c.req.query('limit') ?? 1_000),
      }),
    );
  });

  app.get('/v1/executions/:id/trace', requirePermission('execution:read'), async (c) => {
    const principal = principalOf(c);
    await executions.get(principal.orgId, c.req.param('id'));
    const events = await ctx.store.events.listForExecution(principal.orgId, c.req.param('id'), { limit: 5_000 });
    return c.json(buildTrace(events));
  });

  /** Live event stream for one execution. */
  app.get('/v1/executions/:id/events/stream', requirePermission('execution:read'), async (c) => {
    const principal = principalOf(c);
    const executionId = c.req.param('id');
    await executions.get(principal.orgId, executionId);
    const bus = options.bus;
    if (!bus) throw new AgentOSError('invalid_request', 'event streaming is not enabled on this deployment');

    const backlog = await ctx.store.events.listForExecution(principal.orgId, executionId, { limit: 1_000 });
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        for (const event of backlog) send(event);

        const subscription = bus.subscribe({ orgId: principal.orgId, executionId }, (event) => {
          send(event);
        });
        // Keep the connection from idling out behind a proxy.
        const keepAlive = setInterval(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), 15_000);

        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          subscription.unsubscribe();
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  });

  app.post('/v1/executions/:id/pause', requirePermission('execution:control'), async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as never);
    return c.json(await executions.pause(principalOf(c), c.req.param('id'), body.reason));
  });

  app.post('/v1/executions/:id/resume', requirePermission('execution:control'), async (c) =>
    c.json(await executions.resume(principalOf(c), c.req.param('id'))),
  );

  app.post('/v1/executions/:id/cancel', requirePermission('execution:control'), async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as never);
    return c.json(await executions.cancel(principalOf(c), c.req.param('id'), body.reason));
  });

  app.post('/v1/executions/:id/retry', requirePermission('execution:run'), async (c) =>
    c.json(await executions.retry(principalOf(c), c.req.param('id')), 202),
  );

  app.post('/v1/executions/:id/replay', requirePermission('execution:run'), async (c) => {
    const body = await c.req.json<{ strategy?: 'recorded' | 'live-model' }>().catch(() => ({}) as never);
    return c.json(
      await executions.replay(principalOf(c), c.req.param('id'), body.strategy ? { strategy: body.strategy } : {}),
      202,
    );
  });

  // --- approvals ----------------------------------------------------------

  app.get('/v1/approvals', requirePermission('execution:read'), async (c) => {
    const { limit, cursor } = listQuery(c);
    const agentId = c.req.query('agentId');
    return c.json(
      await ctx.store.approvals.listPending(principalOf(c).orgId, { limit, cursor, ...(agentId ? { agentId } : {}) }),
    );
  });

  app.get('/v1/approvals/:id', requirePermission('execution:read'), async (c) => {
    const approval = await ctx.store.approvals.get(principalOf(c).orgId, c.req.param('id'));
    if (!approval) throw new AgentOSError('not_found', `approval ${c.req.param('id')} not found`);
    return c.json(approval);
  });

  app.post('/v1/approvals/:id/decide', requirePermission('approval:decide'), async (c) => {
    const body = await c.req.json<{ approve: boolean; note?: string; editedArguments?: JsonObject | null }>();
    if (typeof body.approve !== 'boolean') {
      throw new AgentOSError('invalid_request', 'body.approve must be a boolean');
    }
    return c.json(await executions.decideApproval(principalOf(c), c.req.param('id'), body));
  });

  // --- tasks --------------------------------------------------------------

  app.post('/v1/tasks', requirePermission('execution:run'), async (c) => {
    const body = await c.req.json<{ agentRef: string; title: string; input: JsonValue; dependsOn?: string[] }>();
    return c.json(await tasks.create(principalOf(c), body), 201);
  });

  app.get('/v1/tasks', requirePermission('execution:read'), async (c) => {
    const { limit, cursor } = listQuery(c);
    const statuses = c.req.queries('status');
    return c.json(
      await ctx.store.tasks.list(principalOf(c).orgId, {
        limit,
        cursor,
        ...(statuses && statuses.length > 0 ? { status: statuses as never } : {}),
      }),
    );
  });

  app.get('/v1/tasks/:id', requirePermission('execution:read'), async (c) => {
    const task = await ctx.store.tasks.get(principalOf(c).orgId, c.req.param('id'));
    if (!task) throw new AgentOSError('not_found', `task ${c.req.param('id')} not found`);
    return c.json(task);
  });

  // --- schedules ----------------------------------------------------------

  app.post('/v1/schedules', requirePermission('agent:write'), async (c) => {
    const body = await c.req.json<{ agentRef: string; name: string; kind: 'cron' | 'interval' | 'at'; expression: string; timezone?: string; input?: JsonValue }>();
    return c.json(await scheduler.create(principalOf(c), body), 201);
  });

  app.get('/v1/schedules', requirePermission('agent:read'), async (c) => {
    const { limit, cursor } = listQuery(c);
    const agentId = c.req.query('agentId');
    return c.json(
      await ctx.store.schedules.list(principalOf(c).orgId, { limit, cursor, ...(agentId ? { agentId } : {}) }),
    );
  });

  app.patch('/v1/schedules/:id', requirePermission('agent:write'), async (c) => {
    const body = await c.req.json<{ enabled: boolean }>();
    return c.json(await scheduler.setEnabled(principalOf(c), c.req.param('id'), body.enabled));
  });

  app.delete('/v1/schedules/:id', requirePermission('agent:write'), async (c) =>
    c.json({ deleted: await ctx.store.schedules.delete(principalOf(c).orgId, c.req.param('id')) }),
  );

  // --- tools and policies -------------------------------------------------

  app.get('/v1/tools', requirePermission('agent:read'), async (c) =>
    c.json(
      ctx.registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        operations: t.operations,
        destructive: t.destructive,
        idempotent: t.idempotent,
        source: t.source,
        inputSchema: t.inputSchema,
      })),
    ),
  );

  app.get('/v1/policies', requirePermission('policy:read'), async (c) =>
    c.json(await ctx.store.policies.list(principalOf(c).orgId)),
  );

  app.post('/v1/policies', requirePermission('policy:write'), async (c) => {
    const principal = principalOf(c);
    const body = await c.req.json<{ name: string; description?: string; scope?: 'org' | 'agent'; rules: never }>();
    const now = ctx.clock.now();
    return c.json(
      await ctx.store.policies.create({
        id: newId('policy'),
        orgId: principal.orgId,
        name: body.name,
        description: body.description ?? '',
        enabled: true,
        scope: body.scope ?? 'org',
        rules: body.rules,
        createdAt: now,
        updatedAt: now,
      }),
      201,
    );
  });

  app.patch('/v1/policies/:id', requirePermission('policy:write'), async (c) => {
    const body = await c.req.json<{ enabled?: boolean; rules?: never; description?: string }>();
    return c.json(
      await ctx.store.policies.update(principalOf(c).orgId, c.req.param('id'), {
        ...body,
        updatedAt: ctx.clock.now(),
      }),
    );
  });

  // --- metrics and search -------------------------------------------------

  app.get('/v1/metrics/overview', requirePermission('execution:read'), async (c) => {
    const { since, until } = windowOf(c, ctx.clock.now());
    return c.json(await ctx.store.metrics.orgTotals(principalOf(c).orgId, since, until));
  });

  app.get('/v1/metrics/cost-by-agent', requirePermission('execution:read'), async (c) => {
    const { since, until } = windowOf(c, ctx.clock.now());
    return c.json(await ctx.store.metrics.costByAgent(principalOf(c).orgId, since, until));
  });

  app.get('/v1/metrics/cost-by-model', requirePermission('execution:read'), async (c) => {
    const { since, until } = windowOf(c, ctx.clock.now());
    return c.json(await ctx.store.metrics.costByModel(principalOf(c).orgId, since, until));
  });

  app.get('/v1/metrics/tool-usage', requirePermission('execution:read'), async (c) => {
    const { since, until } = windowOf(c, ctx.clock.now());
    return c.json(await ctx.store.metrics.toolUsage(principalOf(c).orgId, since, until));
  });

  app.get('/v1/audit', requirePermission('org:manage'), async (c) => {
    const { limit, cursor } = listQuery(c);
    return c.json(await ctx.store.audit.list(principalOf(c).orgId, { limit, cursor }));
  });

  app.get('/v1/search', requirePermission('agent:read'), async (c) => {
    const principal = principalOf(c);
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0) return c.json({ agents: [], executions: [], tasks: [] });
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 50);

    const [agentPage, executionPage, taskPage] = await Promise.all([
      ctx.store.agents.list(principal.orgId, { search: q, limit }),
      // Ids are looked up directly; everything else is filtered client-side
      // over a bounded window rather than pretending to be a search engine.
      ctx.store.executions.list(principal.orgId, { limit: 200 }),
      ctx.store.tasks.list(principal.orgId, { limit: 200 }),
    ]);

    const needle = q.toLowerCase();
    return c.json({
      agents: agentPage.items,
      executions: executionPage.items
        .filter((e) => e.id.toLowerCase().includes(needle) || JSON.stringify(e.labels).toLowerCase().includes(needle))
        .slice(0, limit),
      tasks: taskPage.items.filter((t) => t.title.toLowerCase().includes(needle) || t.id.toLowerCase().includes(needle)).slice(0, limit),
    });
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
