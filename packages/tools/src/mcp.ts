import {
  AgentOSError,
  anyGlobMatch,
  isJsonObject,
  nullLogger,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type Logger,
  type ToolOperation,
} from '@agentos/core';
import type { ToolDefinition } from './types.js';

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface McpServerConfig {
  id: string;
  /** Namespace for this server's tools: `mcp.<alias>.<tool>`. */
  alias: string;
  transport: McpTransportConfig;
  /**
   * Trust posture. `untrusted` (the default) means discovered tools are treated
   * as destructive unless the server annotates otherwise, so the baseline policy
   * routes them through human approval.
   */
  trust: 'trusted' | 'untrusted';
  enabled: boolean;
  /** Only these tool names (globs) are imported. Empty means all of them. */
  allowedTools?: string[];
  timeoutMs?: number;
  description?: string;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** The slice of an MCP client this package depends on. */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolDescriptor[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export type McpClientFactory = (config: McpServerConfig) => Promise<McpClientLike>;

/** Default factory backed by the official MCP TypeScript SDK. */
export const sdkClientFactory: McpClientFactory = async (config) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'agentos', version: '0.1.0' }, { capabilities: {} });

  if (config.transport.type === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    await client.connect(
      new StdioClientTransport({
        command: config.transport.command,
        args: config.transport.args ?? [],
        env: config.transport.env,
        cwd: config.transport.cwd,
      }),
    );
  } else {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.transport.url), {
        requestInit: { headers: config.transport.headers },
      }),
    );
  }

  return client as unknown as McpClientLike;
};

function coerceSchema(raw: unknown): JsonSchema {
  if (!isJsonObject(raw)) return { type: 'object', properties: {}, additionalProperties: true };
  return raw as unknown as JsonSchema;
}

/**
 * Map MCP annotations onto AgentOS capabilities.
 *
 * Absence of an annotation is treated as "could do anything", not as "safe":
 * an unannotated tool from an untrusted server gets write+network operations and
 * `destructive: true`, which the baseline policy turns into an approval prompt.
 */
export function capabilitiesFor(
  tool: McpToolDescriptor,
  trust: McpServerConfig['trust'],
): { operations: ToolOperation[]; destructive: boolean; idempotent: boolean } {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true) {
    return { operations: a.openWorldHint === false ? ['read'] : ['read', 'network'], destructive: false, idempotent: true };
  }
  const annotatedNonDestructive = a.destructiveHint === false;
  const destructive = annotatedNonDestructive ? false : true;
  const operations: ToolOperation[] = destructive ? ['write', 'delete', 'network'] : ['write', 'network'];
  return {
    operations,
    destructive: trust === 'trusted' ? (a.destructiveHint ?? false) : destructive,
    idempotent: a.idempotentHint ?? false,
  };
}

/** Flatten an MCP tool result into JSON the runtime can put in a message. */
export function normaliseToolResult(result: unknown): JsonValue {
  if (!isJsonObject(result)) return (result ?? null) as JsonValue;
  const record = result as JsonObject;
  if (record['structuredContent'] !== undefined) return record['structuredContent'] as JsonValue;
  const content = record['content'];
  if (Array.isArray(content)) {
    const parts = content.map((item) => {
      if (!isJsonObject(item)) return item as JsonValue;
      if (item['type'] === 'text') return item['text'] as JsonValue;
      return item as JsonValue;
    });
    const isError = record['isError'] === true;
    const value = parts.length === 1 ? (parts[0] as JsonValue) : (parts as JsonValue);
    return isError ? { isError: true, content: value } : value;
  }
  return record as JsonValue;
}

export interface McpManagerOptions {
  clientFactory?: McpClientFactory;
  logger?: Logger;
}

export interface McpServerStatus {
  id: string;
  alias: string;
  connected: boolean;
  trust: McpServerConfig['trust'];
  toolCount: number;
  lastError: string | null;
  lastDiscoveredAt: number | null;
}

/**
 * Connects to MCP servers, imports their tools under a namespace and exposes
 * them as ordinary {@link ToolDefinition}s — so MCP tools go through the same
 * policy gate, approval flow, rate limits and redaction as everything else.
 */
export class McpManager {
  private readonly clients = new Map<string, McpClientLike>();
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly status = new Map<string, McpServerStatus>();
  private readonly factory: McpClientFactory;
  private readonly logger: Logger;

  constructor(options: McpManagerOptions = {}) {
    this.factory = options.clientFactory ?? sdkClientFactory;
    this.logger = options.logger ?? nullLogger;
  }

  list(): McpServerStatus[] {
    return [...this.status.values()];
  }

  async connect(config: McpServerConfig): Promise<void> {
    if (!config.enabled) {
      this.status.set(config.id, {
        id: config.id,
        alias: config.alias,
        connected: false,
        trust: config.trust,
        toolCount: 0,
        lastError: 'server is disabled',
        lastDiscoveredAt: null,
      });
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(config.alias)) {
      throw new AgentOSError('invalid_request', `MCP alias '${config.alias}' must be a lowercase identifier`);
    }
    try {
      const client = await this.factory(config);
      this.clients.set(config.id, client);
      this.configs.set(config.id, config);
      this.status.set(config.id, {
        id: config.id,
        alias: config.alias,
        connected: true,
        trust: config.trust,
        toolCount: 0,
        lastError: null,
        lastDiscoveredAt: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.set(config.id, {
        id: config.id,
        alias: config.alias,
        connected: false,
        trust: config.trust,
        toolCount: 0,
        lastError: message,
        lastDiscoveredAt: null,
      });
      throw new AgentOSError('provider_unavailable', `could not connect to MCP server ${config.alias}: ${message}`, {
        cause: error,
      });
    }
  }

  async discover(serverId: string): Promise<ToolDefinition[]> {
    const client = this.clients.get(serverId);
    const config = this.configs.get(serverId);
    if (!client || !config) throw new AgentOSError('not_found', `MCP server ${serverId} is not connected`);

    const { tools } = await client.listTools();
    const allow = config.allowedTools ?? [];
    const selected = allow.length > 0 ? tools.filter((t) => anyGlobMatch(allow, t.name)) : tools;

    const definitions = selected.map((tool) => {
      const caps = capabilitiesFor(tool, config.trust);
      const qualified = `mcp.${config.alias}.${tool.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()}`;
      const definition: ToolDefinition = {
        name: qualified,
        description: `[MCP ${config.alias}] ${tool.description ?? tool.name}`,
        inputSchema: coerceSchema(tool.inputSchema),
        operations: caps.operations,
        destructive: caps.destructive,
        idempotent: caps.idempotent,
        timeoutMs: config.timeoutMs ?? 60_000,
        source: 'mcp',
        serverId: config.id,
        describeImpact: (args) => `call MCP tool ${tool.name} on server "${config.alias}" with ${JSON.stringify(args).slice(0, 200)}`,
        async handler(args) {
          const result = await client.callTool({ name: tool.name, arguments: args });
          return normaliseToolResult(result);
        },
      };
      return definition;
    });

    const existing = this.status.get(serverId);
    if (existing) {
      this.status.set(serverId, {
        ...existing,
        toolCount: definitions.length,
        lastDiscoveredAt: Date.now(),
      });
    }
    this.logger.info('discovered MCP tools', { server: config.alias, count: definitions.length });
    return definitions;
  }

  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      await client.close().catch(() => undefined);
      this.clients.delete(serverId);
    }
    const existing = this.status.get(serverId);
    if (existing) this.status.set(serverId, { ...existing, connected: false });
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.disconnect(id)));
  }
}
