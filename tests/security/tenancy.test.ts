import type { AgentRecord, ExecutionRecord } from '@agentos/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStack, type TestOrg, type TestStack } from '../helpers.js';

/**
 * Tenant isolation and RBAC, exercised through the HTTP surface rather than the
 * store, because that is where a mistake would actually be reachable.
 */
describe('tenant isolation', () => {
  let stack: TestStack;
  let acme: TestOrg;
  let globex: TestOrg;

  beforeEach(async () => {
    stack = await createTestStack();
    acme = await stack.addOrg('acme');
    globex = await stack.addOrg('globex');
  });

  it('does not list another org’s agents', async () => {
    await stack.publishAgent(acme, 'acme-secret-agent', {});
    const listed = await stack.json<{ items: AgentRecord[] }>('/v1/agents', { key: globex.apiKey });
    expect(listed.items).toHaveLength(0);
  });

  it('returns 404 — not 403 — for another org’s agent by id', async () => {
    const agentId = await stack.publishAgent(acme, 'acme-agent', {});
    const byId = await stack.request(`/v1/agents/${agentId}`, { key: globex.apiKey });
    const bySlug = await stack.request('/v1/agents/acme-agent', { key: globex.apiKey });
    // 404 rather than 403: a cross-tenant probe must not confirm existence.
    expect(byId.status).toBe(404);
    expect(bySlug.status).toBe(404);
  });

  it('does not expose another org’s execution, events or trace', async () => {
    await stack.publishAgent(acme, 'acme-runner', {});
    const execution = await stack.json<ExecutionRecord>('/v1/agents/acme-runner/run', {
      method: 'POST', key: acme.apiKey, body: JSON.stringify({ input: 'go' }),
    });
    await stack.drain();

    for (const path of [
      `/v1/executions/${execution.id}`,
      `/v1/executions/${execution.id}/events`,
      `/v1/executions/${execution.id}/trace`,
    ]) {
      expect((await stack.request(path, { key: globex.apiKey })).status, path).toBe(404);
    }
  });

  it('does not let another org control an execution', async () => {
    await stack.publishAgent(acme, 'acme-ctl', {});
    const execution = await stack.json<ExecutionRecord>('/v1/agents/acme-ctl/run', {
      method: 'POST', key: acme.apiKey, body: JSON.stringify({ input: 'go' }),
    });

    for (const action of ['cancel', 'pause', 'retry', 'replay']) {
      const response = await stack.request(`/v1/executions/${execution.id}/${action}`, {
        method: 'POST', key: globex.apiKey, body: JSON.stringify({}),
      });
      expect(response.status, action).toBe(404);
    }
    expect((await stack.store.executions.get(acme.orgId, execution.id))?.status).toBe('queued');
  });

  it('keeps metrics separate', async () => {
    await stack.publishAgent(acme, 'acme-metrics', {});
    await stack.request('/v1/agents/acme-metrics/run', {
      method: 'POST', key: acme.apiKey, body: JSON.stringify({ input: 'go' }),
    });
    await stack.drain();

    const theirs = await stack.json<{ executions: number }>('/v1/metrics/overview', { key: globex.apiKey });
    const ours = await stack.json<{ executions: number }>('/v1/metrics/overview', { key: acme.apiKey });
    expect(theirs.executions).toBe(0);
    expect(ours.executions).toBe(1);
  });

  it('does not let a cross-tenant approval be decided', async () => {
    stack.provider.setFallback(({ messages }) =>
      messages.some((m) => m.role === 'tool')
        ? { content: 'done', finishReason: 'stop' }
        : ({ toolCalls: [{ name: 'http.post', arguments: { url: 'https://api.example.com/x' } as never }] } as never),
    );
    await stack.publishAgent(acme, 'acme-approver', {
      permissions: {
        allowedTools: ['http.post'],
        allowedOperations: ['write', 'network'],
        allowedDomains: ['api.example.com'],
        requireApprovalFor: ['http.post'],
      },
    });
    await stack.request('/v1/agents/acme-approver/run', {
      method: 'POST', key: acme.apiKey, body: JSON.stringify({ input: 'post' }),
    });
    await stack.drain();

    const approval = (await stack.store.approvals.listPending(acme.orgId)).items[0];
    const response = await stack.request(`/v1/approvals/${approval?.id}/decide`, {
      method: 'POST', key: globex.apiKey, body: JSON.stringify({ approve: true }),
    });
    expect(response.status).toBe(404);
    expect((await stack.store.approvals.get(acme.orgId, approval?.id as string))?.status).toBe('pending');
  });

  it('allows the same agent slug in two orgs without collision', async () => {
    await stack.publishAgent(acme, 'shared-slug', {});
    await stack.publishAgent(globex, 'shared-slug', {});
    const a = await stack.json<AgentRecord>('/v1/agents/shared-slug', { key: acme.apiKey });
    const b = await stack.json<AgentRecord>('/v1/agents/shared-slug', { key: globex.apiKey });
    expect(a.id).not.toBe(b.id);
    expect(a.orgId).toBe(acme.orgId);
    expect(b.orgId).toBe(globex.orgId);
  });
});

describe('role-based access control', () => {
  let stack: TestStack;
  let org: TestOrg;

  beforeEach(async () => {
    stack = await createTestStack();
    org = await stack.addOrg('rbac');
  });

  it('lets a viewer read but not write', async () => {
    await stack.publishAgent(org, 'readable', {});
    const viewer = await stack.addKey(org.orgId, 'viewer');

    expect((await stack.request('/v1/agents', { key: viewer })).status).toBe(200);
    expect((await stack.request('/v1/executions', { key: viewer })).status).toBe(200);

    const create = await stack.request('/v1/agents', {
      method: 'POST', key: viewer,
      body: JSON.stringify({ slug: 'nope', name: 'Nope', spec: { model: { primary: 'scripted:test' }, instructions: 'x' } }),
    });
    expect(create.status).toBe(403);

    const run = await stack.request('/v1/agents/readable/run', {
      method: 'POST', key: viewer, body: JSON.stringify({ input: 'go' }),
    });
    expect(run.status).toBe(403);
  });

  it('lets a developer run agents but not decide approvals or manage the org', async () => {
    await stack.publishAgent(org, 'dev-agent', {});
    const developer = await stack.addKey(org.orgId, 'developer');

    expect(
      (await stack.request('/v1/agents/dev-agent/run', {
        method: 'POST', key: developer, body: JSON.stringify({ input: 'go' }),
      })).status,
    ).toBe(202);

    expect(
      (await stack.request('/v1/approvals/apr_x/decide', {
        method: 'POST', key: developer, body: JSON.stringify({ approve: true }),
      })).status,
    ).toBe(403);

    expect((await stack.request('/v1/audit', { key: developer })).status).toBe(403);
  });

  it('lets an admin decide approvals but not read the org audit log', async () => {
    const admin = await stack.addKey(org.orgId, 'admin');
    // A 404 here means the permission check passed and the approval simply is
    // not there — which is the distinction being asserted.
    expect(
      (await stack.request('/v1/approvals/apr_missing/decide', {
        method: 'POST', key: admin, body: JSON.stringify({ approve: true }),
      })).status,
    ).toBe(404);
    expect((await stack.request('/v1/audit', { key: admin })).status).toBe(403);
  });

  it('lets an owner read the audit log', async () => {
    expect((await stack.request('/v1/audit', { key: org.apiKey })).status).toBe(200);
  });

  it('does not let a client pick its own org', async () => {
    const other = await stack.addOrg('victim');
    await stack.publishAgent(other, 'victim-agent', {});
    // Even with the victim's org id supplied in every plausible place, the
    // tenant comes from the API key and nothing else.
    const response = await stack.request('/v1/agents/victim-agent?orgId=' + other.orgId, {
      key: org.apiKey,
      headers: { 'x-org-id': other.orgId },
    });
    expect(response.status).toBe(404);
  });
});
