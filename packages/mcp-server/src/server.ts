import { AgentOSError, type JsonValue } from '@agentos/core';
import type { AgentOSClient } from '@agentos/sdk';

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<JsonValue>;
}

function windowArgs(args: Record<string, unknown>): { since?: number; until?: number } {
  const since = args['sinceMs'] === undefined ? undefined : Number(args['sinceMs']);
  const until = args['untilMs'] === undefined ? undefined : Number(args['untilMs']);
  return {
    ...(Number.isFinite(since) ? { since: since as number } : {}),
    ...(Number.isFinite(until) ? { until: until as number } : {}),
  };
}

/**
 * Read-only management tools for AgentOS itself, exposed over MCP.
 *
 * Deliberately excluded: creating or publishing agents, running them, deciding
 * approvals, and anything touching secrets or credentials. An assistant wired
 * to this server can explain what the fleet is doing; it cannot deploy to it or
 * approve on a human's behalf.
 */
export function buildReadOnlyTools(client: AgentOSClient): McpToolDefinition[] {
  return [
    {
      name: 'list_agents',
      title: 'List agents',
      description: 'List the agents in the organisation, with their published version and labels.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional name or slug filter' },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 25 },
        },
      },
      handler: async (args) => {
        const page = await client.agents.list({
          ...(args['search'] ? { search: String(args['search']) } : {}),
          limit: Number(args['limit'] ?? 25),
        });
        return page.items.map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          description: a.description,
          publishedVersion: a.latestVersionNumber,
          archived: a.archived,
        })) as unknown as JsonValue;
      },
    },
    {
      name: 'get_agent',
      title: 'Get an agent',
      description: 'Fetch one agent’s configuration: model, tools, permissions, limits and policies.',
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string', description: 'Agent slug or id' } },
        required: ['agent'],
      },
      handler: async (args) => {
        const agent = await client.agents.get(String(args['agent']));
        return {
          id: agent.id,
          slug: agent.slug,
          name: agent.name,
          description: agent.description,
          publishedVersionId: agent.publishedVersionId,
          spec: {
            model: agent.draft.model,
            tools: agent.draft.permissions.allowedTools,
            permissions: agent.draft.permissions,
            limits: agent.draft.limits,
            policies: agent.draft.policies ?? [],
          },
        } as unknown as JsonValue;
      },
    },
    {
      name: 'list_executions',
      title: 'List executions',
      description: 'List recent executions, optionally filtered by agent and status.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          status: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 25 },
        },
      },
      handler: async (args) => {
        const page = await client.executions.list({
          ...(args['agentId'] ? { agentId: String(args['agentId']) } : {}),
          ...(Array.isArray(args['status']) ? { status: (args['status'] as string[]) } : {}),
          limit: Number(args['limit'] ?? 25),
        });
        return page.items.map((e) => ({
          id: e.id,
          agentId: e.agentId,
          status: e.status,
          mode: e.mode,
          createdAt: e.createdAt,
          durationMs: e.finishedAt && e.startedAt ? e.finishedAt - e.startedAt : null,
          costMicroUsd: e.usage.costMicroUsd,
        })) as unknown as JsonValue;
      },
    },
    {
      name: 'get_execution',
      title: 'Get an execution',
      description: 'Fetch one execution: status, usage, cost, output and error.',
      inputSchema: {
        type: 'object',
        properties: { executionId: { type: 'string' } },
        required: ['executionId'],
      },
      handler: async (args) => {
        const execution = await client.executions.get(String(args['executionId']));
        return {
          id: execution.id,
          agentId: execution.agentId,
          versionNumber: execution.versionNumber,
          status: execution.status,
          mode: execution.mode,
          trigger: execution.trigger,
          usage: execution.usage,
          output: execution.output,
          error: execution.error,
          startedAt: execution.startedAt,
          finishedAt: execution.finishedAt,
        } as unknown as JsonValue;
      },
    },
    {
      name: 'get_execution_trace',
      title: 'Get an execution trace',
      description:
        'Fetch the step-by-step trace of an execution: model calls, tool calls, approvals and memory access, ' +
        'with durations, tokens and cost. Sensitive values are redacted server-side.',
      inputSchema: {
        type: 'object',
        properties: { executionId: { type: 'string' } },
        required: ['executionId'],
      },
      handler: async (args) => {
        const trace = await client.executions.trace(String(args['executionId']));
        return {
          executionId: trace.executionId,
          durationMs: trace.durationMs,
          nodes: trace.nodes.map((n) => ({
            kind: n.kind,
            name: n.name,
            status: n.status,
            durationMs: n.durationMs,
            inputTokens: n.inputTokens,
            outputTokens: n.outputTokens,
            costMicroUsd: n.costMicroUsd,
            detail: n.detail,
          })),
        } as unknown as JsonValue;
      },
    },
    {
      name: 'get_agent_metrics',
      title: 'Get agent metrics',
      description: 'Success rate, latency percentiles, token usage and cost for one agent over a time window.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent slug or id' },
          sinceMs: { type: 'number', description: 'Window start, epoch ms' },
          untilMs: { type: 'number', description: 'Window end, epoch ms' },
        },
        required: ['agent'],
      },
      handler: async (args) =>
        (await client.agents.metrics(String(args['agent']), windowArgs(args))) as unknown as JsonValue,
    },
    {
      name: 'list_pending_approvals',
      title: 'List pending approvals',
      description:
        'List tool calls waiting for a human decision, with the reason and the stated impact. ' +
        'Read-only: deciding an approval must be done by a person in the dashboard or API.',
      inputSchema: {
        type: 'object',
        properties: { agentId: { type: 'string' }, limit: { type: 'number', default: 25 } },
      },
      handler: async (args) => {
        const page = await client.approvals.listPending({
          ...(args['agentId'] ? { agentId: String(args['agentId']) } : {}),
          limit: Number(args['limit'] ?? 25),
        });
        return page.items.map((a) => ({
          id: a.id,
          executionId: a.executionId,
          tool: a.toolCall.name,
          impact: a.impact,
          reason: a.reason,
          destructive: a.destructive,
          requestedAt: a.requestedAt,
        })) as unknown as JsonValue;
      },
    },
    {
      name: 'get_cost_breakdown',
      title: 'Get cost breakdown',
      description: 'Estimated spend grouped by agent and by model over a time window.',
      inputSchema: {
        type: 'object',
        properties: { sinceMs: { type: 'number' }, untilMs: { type: 'number' } },
      },
      handler: async (args) => {
        const window = windowArgs(args);
        const [byAgent, byModel, overview] = await Promise.all([
          client.metrics.costByAgent(window),
          client.metrics.costByModel(window),
          client.metrics.overview(window),
        ]);
        return { overview, byAgent, byModel } as unknown as JsonValue;
      },
    },
  ];
}

/** Start the MCP server over stdio. */
export async function startStdioServer(client: AgentOSClient, info = { name: 'agentos', version: '0.1.0' }) {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const tools = buildReadOnlyTools(client);
  const server = new Server(info, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      throw new AgentOSError('tool_not_found', `unknown tool ${request.params.name}`);
    }
    try {
      const result = await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: { result } };
    } catch (error) {
      const agentError = AgentOSError.from(error);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `${agentError.code}: ${agentError.message}` }],
      };
    }
  });

  await server.connect(new StdioServerTransport());
  return server;
}
