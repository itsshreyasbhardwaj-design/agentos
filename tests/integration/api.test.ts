import type { AgentRecord, AgentVersionRecord, ApprovalRecord, ExecutionRecord } from '@agentos/core';
import type { Trace } from '@agentos/events';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStack, type TestOrg, type TestStack } from '../helpers.js';

describe('REST API', () => {
  let stack: TestStack;
  let acme: TestOrg;

  beforeEach(async () => {
    stack = await createTestStack(({ messages }) => {
      const asked = messages.some((m) => m.role === 'user' && m.content.includes('compute'));
      const hasToolResult = messages.some((m) => m.role === 'tool');
      if (asked && !hasToolResult) {
        return { toolCalls: [{ name: 'math.evaluate', arguments: { expression: '6*7' } as never }] };
      }
      return { content: hasToolResult ? 'The answer is 42.' : 'ok', finishReason: 'stop' };
    });
    acme = await stack.addOrg('acme');
  });

  describe('health', () => {
    it('reports store and queue state', async () => {
      const body = await stack.json<{ status: string; store: boolean }>('/healthz');
      expect(body.status).toBe('ok');
      expect(body.store).toBe(true);
    });
  });

  describe('authentication', () => {
    it('rejects a request with no key', async () => {
      const response = await stack.request('/v1/agents');
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('unauthenticated');
    });

    it('rejects an unknown key', async () => {
      const response = await stack.request('/v1/agents', { key: 'aos_not_a_real_key' });
      expect(response.status).toBe(401);
    });

    it('rejects a revoked key', async () => {
      const key = await stack.addKey(acme.orgId, 'developer');
      expect((await stack.request('/v1/agents', { key })).status).toBe(200);
      const keys = await stack.store.apiKeys.list(acme.orgId);
      const toRevoke = keys.find((k) => k.name === 'developer-key');
      await stack.store.apiKeys.revoke(acme.orgId, toRevoke?.id as string, stack.clock.now());
      expect((await stack.request('/v1/agents', { key })).status).toBe(401);
    });

    it('attaches a request id to every response', async () => {
      const response = await stack.request('/healthz');
      expect(response.headers.get('x-request-id')).toBeTruthy();
    });
  });

  describe('agent lifecycle', () => {
    it('creates, publishes, runs and reports an agent end to end', async () => {
      const created = await stack.json<AgentRecord>('/v1/agents', {
        method: 'POST',
        key: acme.apiKey,
        body: JSON.stringify({
          slug: 'calculator',
          name: 'Calculator',
          description: 'Does arithmetic',
          spec: {
            model: { primary: 'scripted:test' },
            instructions: 'Do arithmetic with the math tool.',
            permissions: { allowedTools: ['math.evaluate'], allowedOperations: ['read'] },
          },
        }),
      });
      expect(created.slug).toBe('calculator');
      expect(created.publishedVersionId).toBeNull();

      const version = await stack.json<AgentVersionRecord>('/v1/agents/calculator/publish', {
        method: 'POST',
        key: acme.apiKey,
        body: JSON.stringify({ changelog: 'first' }),
      });
      expect(version.version).toBe(1);

      const execution = await stack.json<ExecutionRecord>('/v1/agents/calculator/run', {
        method: 'POST',
        key: acme.apiKey,
        body: JSON.stringify({ input: 'please compute six times seven' }),
      });
      expect(execution.status).toBe('queued');

      await stack.drain();

      const finished = await stack.json<ExecutionRecord>(`/v1/executions/${execution.id}`, { key: acme.apiKey });
      expect(finished.status).toBe('completed');
      expect(finished.output).toBe('The answer is 42.');

      const trace = await stack.json<Trace>(`/v1/executions/${execution.id}/trace`, { key: acme.apiKey });
      expect(trace.nodes.map((n) => n.kind)).toEqual(['model', 'tool', 'model']);

      const metrics = await stack.json<{ executions: number; successRate: number }>(
        '/v1/agents/calculator/metrics',
        { key: acme.apiKey },
      );
      expect(metrics.executions).toBe(1);
      expect(metrics.successRate).toBe(1);
    });

    it('rejects an agent whose allow-list names a tool that does not exist', async () => {
      const response = await stack.request('/v1/agents', {
        method: 'POST',
        key: acme.apiKey,
        body: JSON.stringify({
          slug: 'broken',
          name: 'Broken',
          spec: {
            model: { primary: 'scripted:test' },
            instructions: 'hi',
            permissions: { allowedTools: ['totally.made_up'], allowedOperations: ['read'] },
          },
        }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toMatch(/matches no registered tool/);
    });

    it('refuses to run an unpublished agent', async () => {
      await stack.request('/v1/agents', {
        method: 'POST',
        key: acme.apiKey,
        body: JSON.stringify({
          slug: 'draft-only',
          name: 'Draft',
          spec: { model: { primary: 'scripted:test' }, instructions: 'hi' },
        }),
      });
      const response = await stack.request('/v1/agents/draft-only/run', {
        method: 'POST',
        key: acme.apiKey,
        body: JSON.stringify({ input: 'go' }),
      });
      expect(response.status).toBe(409);
    });
  });

  describe('idempotency', () => {
    it('returns the same execution for a repeated Idempotency-Key header', async () => {
      await stack.publishAgent(acme, 'echo', {});
      const body = JSON.stringify({ input: 'hello' });
      const first = await stack.json<ExecutionRecord>('/v1/agents/echo/run', {
        method: 'POST', key: acme.apiKey, body, headers: { 'idempotency-key': 'req-1' },
      });
      const second = await stack.json<ExecutionRecord>('/v1/agents/echo/run', {
        method: 'POST', key: acme.apiKey, body, headers: { 'idempotency-key': 'req-1' },
      });
      expect(second.id).toBe(first.id);
    });
  });

  describe('execution control', () => {
    it('cancels a queued execution', async () => {
      await stack.publishAgent(acme, 'slow', {});
      const execution = await stack.json<ExecutionRecord>('/v1/agents/slow/run', {
        method: 'POST', key: acme.apiKey, body: JSON.stringify({ input: 'go' }),
      });
      const cancelled = await stack.json<ExecutionRecord>(`/v1/executions/${execution.id}/cancel`, {
        method: 'POST', key: acme.apiKey, body: JSON.stringify({ reason: 'no longer needed' }),
      });
      expect(cancelled.status).toBe('cancelled');

      const again = await stack.request(`/v1/executions/${execution.id}/cancel`, {
        method: 'POST', key: acme.apiKey, body: JSON.stringify({}),
      });
      expect(again.status).toBe(409);
    });

    it('replays a finished execution as a new one', async () => {
      await stack.publishAgent(acme, 'echo2', {});
      const original = await stack.json<ExecutionRecord>('/v1/agents/echo2/run', {
        method: 'POST', key: acme.apiKey, body: JSON.stringify({ input: 'go' }),
      });
      await stack.drain();

      const replay = await stack.json<ExecutionRecord>(`/v1/executions/${original.id}/replay`, {
        method: 'POST', key: acme.apiKey, body: JSON.stringify({}),
      });
      expect(replay.mode).toBe('replay');
      expect(replay.replayOfExecutionId).toBe(original.id);
      expect(replay.id).not.toBe(original.id);
    });
  });

  describe('approvals', () => {
    it('surfaces a pending approval and resumes on decision', async () => {
      stack.provider.setFallback(({ messages }) =>
        messages.some((m) => m.role === 'tool')
          ? { content: 'posted', finishReason: 'stop' }
          : ({ toolCalls: [{ name: 'http.post', arguments: { url: 'https://api.example.com/x', body: { a: 1 } } as never }] } as never),
      );
      await stack.publishAgent(acme, 'poster', {
        permissions: {
          allowedTools: ['http.post'],
          allowedOperations: ['write', 'network'],
          allowedDomains: ['api.example.com'],
          requireApprovalFor: ['http.post'],
        },
      });

      const execution = await stack.json<ExecutionRecord>('/v1/agents/poster/run', {
        method: 'POST', key: acme.apiKey, body: JSON.stringify({ input: 'post it' }),
      });
      await stack.drain();

      const pending = await stack.json<{ items: ApprovalRecord[] }>('/v1/approvals', { key: acme.apiKey });
      expect(pending.items).toHaveLength(1);

      const decided = await stack.json<{ execution: ExecutionRecord }>(
        `/v1/approvals/${pending.items[0]?.id}/decide`,
        { method: 'POST', key: acme.apiKey, body: JSON.stringify({ approve: true, note: 'fine' }) },
      );
      expect(decided.execution.status).toBe('queued');

      await stack.drain();
      const finished = await stack.json<ExecutionRecord>(`/v1/executions/${execution.id}`, { key: acme.apiKey });
      expect(finished.status).toBe('completed');
    });

    it('rejects a malformed decision body', async () => {
      const response = await stack.request('/v1/approvals/apr_nope/decide', {
        method: 'POST', key: acme.apiKey, body: JSON.stringify({ approve: 'yes' }),
      });
      expect(response.status).toBe(400);
    });
  });

  describe('listing and search', () => {
    it('paginates executions', async () => {
      await stack.publishAgent(acme, 'lister', {});
      for (let i = 0; i < 5; i++) {
        await stack.request('/v1/agents/lister/run', {
          method: 'POST', key: acme.apiKey, body: JSON.stringify({ input: `run ${i}` }),
        });
      }
      const first = await stack.json<{ items: ExecutionRecord[]; nextCursor: string | null }>(
        '/v1/executions?limit=2', { key: acme.apiKey },
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await stack.json<{ items: ExecutionRecord[] }>(
        `/v1/executions?limit=2&cursor=${first.nextCursor}`, { key: acme.apiKey },
      );
      expect(second.items.map((e) => e.id)).not.toEqual(first.items.map((e) => e.id));
    });

    it('searches across agents and tasks', async () => {
      await stack.publishAgent(acme, 'searchable-agent', {});
      const results = await stack.json<{ agents: AgentRecord[] }>('/v1/search?q=searchable', { key: acme.apiKey });
      expect(results.agents.map((a) => a.slug)).toContain('searchable-agent');
    });

    it('lists the registered tools with their capabilities', async () => {
      const tools = await stack.json<Array<{ name: string; destructive: boolean }>>('/v1/tools', { key: acme.apiKey });
      const httpDelete = tools.find((t) => t.name === 'http.delete');
      expect(httpDelete?.destructive).toBe(true);
    });
  });

  describe('errors', () => {
    it('returns a structured 404 for an unknown route', async () => {
      const response = await stack.request('/v1/nope', { key: acme.apiKey });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe('not_found');
    });

    it('returns 404 for an execution that does not exist', async () => {
      const response = await stack.request('/v1/executions/exec_missing', { key: acme.apiKey });
      expect(response.status).toBe(404);
    });
  });
});
