import type {
  Clock,
  JsonObject,
  JsonSchema,
  JsonValue,
  Logger,
  RateLimitSpec,
  Redactor,
  SecretResolver,
  ToolOperation,
} from '@agentos/core';

export type ToolSource = 'builtin' | 'mcp' | 'custom' | 'agent';

export interface ToolContext {
  orgId: string;
  agentId: string;
  executionId: string;
  /** Resolves secret references. Values never reach the model. */
  secrets: SecretResolver;
  logger: Logger;
  clock: Clock;
  signal: AbortSignal;
  redactor: Redactor;
  /**
   * Network access that has already passed the policy gate. Tools must use this
   * rather than global fetch; the executor does not hand over a raw client.
   */
  fetch: GuardedFetch;
  /** Literal secret values used by this call, so output can be scrubbed. */
  usedSecrets: Set<string>;
}

export type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** Capability classes this tool exercises. Drives policy and approval. */
  operations: ToolOperation[];
  /** True when running the tool has effects that cannot be undone. */
  destructive: boolean;
  /** True when running it twice with the same input is safe (retry eligibility). */
  idempotent: boolean;
  /** Hosts the tool contacts regardless of arguments. */
  domains?: string[];
  /** Hosts derivable from a specific call's arguments, for per-call policy. */
  extractDomains?(args: JsonObject): string[];
  /** One-line, human-readable statement of what this call will do. */
  describeImpact?(args: JsonObject): string;
  timeoutMs: number;
  rateLimit?: RateLimitSpec;
  source: ToolSource;
  /** Populated for MCP tools: which server provides it. */
  serverId?: string;
  handler(args: JsonObject, context: ToolContext): Promise<JsonValue>;
}

export interface ToolResult {
  toolName: string;
  output: JsonValue;
  durationMs: number;
  /** Set when the output tripped a security heuristic. */
  warnings: ToolWarning[];
}

export interface ToolWarning {
  kind: 'prompt_injection' | 'secret_in_output' | 'oversized_output' | 'schema_mismatch';
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

export function toolFacts(definition: ToolDefinition, args: JsonObject) {
  const domains = new Set<string>(definition.domains ?? []);
  for (const d of definition.extractDomains?.(args) ?? []) domains.add(d);
  return {
    name: definition.name,
    operations: definition.operations,
    destructive: definition.destructive,
    domains: [...domains],
    arguments: args,
  };
}
