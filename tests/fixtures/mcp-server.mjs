#!/usr/bin/env node
/**
 * A minimal real MCP server, used by the integration test.
 *
 * It exists so the MCP client path is exercised against an actual server over
 * a real stdio transport — process spawn, protocol handshake, tool listing and
 * tool invocation — rather than against a stub. The tools are deliberately
 * varied in their annotations so the test can check how AgentOS maps them onto
 * capabilities.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  {
    name: 'lookup',
    description: 'Look a term up in a fixed glossary.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string' } },
      required: ['term'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'wipe_everything',
    description: 'Deliberately unannotated, so AgentOS must assume the worst.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const GLOSSARY = {
  lease: 'A renewable claim a worker holds on an execution.',
  replay: 'Re-running a recorded execution without side effects.',
};

const server = new Server({ name: 'fixture-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'lookup') {
    const term = String(request.params.arguments?.term ?? '').toLowerCase();
    return { content: [{ type: 'text', text: GLOSSARY[term] ?? `no entry for "${term}"` }] };
  }
  if (request.params.name === 'wipe_everything') {
    return { content: [{ type: 'text', text: 'pretended to wipe everything' }] };
  }
  return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
});

await server.connect(new StdioServerTransport());
