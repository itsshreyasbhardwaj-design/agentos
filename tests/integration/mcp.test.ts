import { fileURLToPath } from 'node:url';
import { McpManager, ToolExecutor, ToolRegistry } from '@agentos/tools';
import { MemorySecretResolver } from '@agentos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, type TestOrg, type TestStack } from '../helpers.js';

const SERVER = fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url));

/**
 * MCP against a real server.
 *
 * Spawns an actual MCP server over stdio and drives it through AgentOS's own
 * client — so the protocol handshake, tool discovery and tool invocation are
 * exercised for real, not stubbed.
 */
describe('MCP client against a real server', () => {
  const manager = new McpManager();
  const config = {
    id: 'mcp_fixture',
    alias: 'fixture',
    transport: { type: 'stdio' as const, command: process.execPath, args: [SERVER] },
    trust: 'untrusted' as const,
    enabled: true,
  };

  beforeAll(async () => {
    await manager.connect(config);
  }, 30_000);

  afterAll(async () => {
    await manager.disconnectAll();
  });

  it('connects and reports the server as live', () => {
    expect(manager.list()[0]).toMatchObject({ alias: 'fixture', connected: true, lastError: null });
  });

  it('discovers tools and namespaces them', async () => {
    const tools = await manager.discover('mcp_fixture');
    expect(tools.map((t) => t.name).sort()).toEqual(['mcp.fixture.lookup', 'mcp.fixture.wipe_everything']);
  });

  it('maps annotations onto capabilities, and assumes the worst without them', async () => {
    const tools = await manager.discover('mcp_fixture');
    const lookup = tools.find((t) => t.name === 'mcp.fixture.lookup');
    const wipe = tools.find((t) => t.name === 'mcp.fixture.wipe_everything');

    expect(lookup).toMatchObject({ destructive: false, idempotent: true });
    expect(lookup?.operations).toEqual(['read']);

    // No annotation from an untrusted server means destructive, which the
    // baseline policy turns into a human approval.
    expect(wipe?.destructive).toBe(true);
    expect(wipe?.operations).toContain('delete');
  });

  it('invokes a tool through the AgentOS executor', async () => {
    const tools = await manager.discover('mcp_fixture');
    const registry = new ToolRegistry().registerAll(tools);
    const executor = new ToolExecutor({ registry });

    const result = await executor.execute(
      { id: 'tc_1', name: 'mcp.fixture.lookup', arguments: { term: 'lease' } },
      {
        orgId: 'org_1',
        agentId: 'agt_1',
        executionId: 'exec_1',
        secrets: new MemorySecretResolver({}),
        isHostAllowed: () => false,
      },
    );

    expect(String(result.output)).toContain('renewable claim');
  });

  it('enforces the input schema the server declared', async () => {
    const tools = await manager.discover('mcp_fixture');
    const registry = new ToolRegistry().registerAll(tools);
    const executor = new ToolExecutor({ registry });

    await expect(
      executor.execute(
        { id: 'tc_2', name: 'mcp.fixture.lookup', arguments: { wrong: 'field' } },
        {
          orgId: 'org_1',
          agentId: 'agt_1',
          executionId: 'exec_1',
          secrets: new MemorySecretResolver({}),
          isHostAllowed: () => false,
        },
      ),
    ).rejects.toMatchObject({ code: 'schema_invalid' });
  });
});

describe('an agent using a real MCP tool', () => {
  let stack: TestStack;
  let org: TestOrg;
  const manager = new McpManager();

  beforeAll(async () => {
    stack = await createTestStack({
      script: ({ messages }) =>
        messages.some((m) => m.role === 'tool')
          ? { content: 'The glossary says a lease is a renewable claim.', finishReason: 'stop' }
          : ({ toolCalls: [{ name: 'mcp.fixture.lookup', arguments: { term: 'lease' } as never }] } as never),
    });
    org = await stack.addOrg('mcp');

    await manager.connect({
      id: 'mcp_fixture',
      alias: 'fixture',
      transport: { type: 'stdio', command: process.execPath, args: [SERVER] },
      trust: 'untrusted',
      enabled: true,
    });
    stack.ctx.registry.registerAll(await manager.discover('mcp_fixture'));
  }, 30_000);

  afterAll(async () => {
    await manager.disconnectAll();
  });

  it('runs end to end, with the MCP tool going through the policy gate', async () => {
    await stack.publishAgent(org, 'mcp-user', {
      permissions: { allowedTools: ['mcp.fixture.lookup'], allowedOperations: ['read'] },
    });

    const execution = await stack.json<{ id: string }>('/v1/agents/mcp-user/run', {
      method: 'POST',
      key: org.apiKey,
      body: JSON.stringify({ input: 'what is a lease?' }),
    });
    await stack.drain();

    const finished = await stack.store.executions.get(org.orgId, execution.id);
    expect(finished?.status).toBe('completed');
    expect(finished?.usage.toolCalls).toBe(1);
  });

  it('denies the unannotated MCP tool the agent was not granted', async () => {
    stack.provider.setFallback(({ messages }) =>
      messages.some((m) => m.role === 'tool')
        ? { content: 'blocked', finishReason: 'stop' }
        : ({ toolCalls: [{ name: 'mcp.fixture.wipe_everything', arguments: {} as never }] } as never),
    );

    await stack.publishAgent(org, 'mcp-limited', {
      permissions: { allowedTools: ['mcp.fixture.lookup'], allowedOperations: ['read'] },
    });

    const execution = await stack.json<{ id: string }>('/v1/agents/mcp-limited/run', {
      method: 'POST',
      key: org.apiKey,
      body: JSON.stringify({ input: 'wipe it' }),
    });
    await stack.drain();

    const events = await stack.store.events.listForExecution(org.orgId, execution.id);
    const denied = events.find((e) => e.type === 'tool.denied');
    expect((denied?.payload as { toolName: string }).toolName).toBe('mcp.fixture.wipe_everything');
  });
});
