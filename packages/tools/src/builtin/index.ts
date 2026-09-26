import { AgentOSError, isJsonObject, type JsonObject, type JsonValue } from '@agentos/core';
import type { ToolDefinition } from '../types.js';
import { evaluateExpression } from './math.js';

function hostOf(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    return [new URL(value).hostname];
  } catch {
    return [];
  }
}

/**
 * A header value is either a literal or a reference to a stored secret. Models
 * are shown this schema, so they can ask for a credential by name without ever
 * being given its value.
 */
const SECRET_OR_STRING = {
  anyOf: [
    { type: 'string' as const },
    {
      type: 'object' as const,
      properties: { $secret: { type: 'string' as const, description: 'Name of a stored secret' } },
      required: ['$secret'],
      additionalProperties: false,
    },
  ],
};

const HTTP_INPUT = {
  type: 'object' as const,
  properties: {
    url: { type: 'string' as const, format: 'uri' as const, description: 'Absolute http(s) URL' },
    headers: {
      type: 'object' as const,
      description: 'Extra request headers. Use {"$secret":"NAME"} to reference a stored credential by name.',
      additionalProperties: SECRET_OR_STRING,
    },
    query: { type: 'object' as const, additionalProperties: { type: 'string' as const } },
  },
  required: ['url'],
  additionalProperties: false,
};

async function readBody(response: Response): Promise<JsonValue> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

function buildUrl(url: string, query: JsonValue | undefined): string {
  if (!isJsonObject(query)) return url;
  const parsed = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === 'string') parsed.searchParams.set(k, v);
  }
  return parsed.toString();
}

/** Resolve `{"$secret":"NAME"}` header values at call time and record them. */
async function resolveHeaders(
  raw: JsonValue | undefined,
  context: Parameters<ToolDefinition['handler']>[1],
): Promise<Record<string, string>> {
  if (!isJsonObject(raw)) return {};
  const { resolveSecrets } = await import('@agentos/core');
  const resolved = await resolveSecrets(raw, context.orgId, context.secrets, context.usedSecrets);
  const out: Record<string, string> = {};
  if (isJsonObject(resolved)) {
    for (const [k, v] of Object.entries(resolved)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

export const httpGetTool: ToolDefinition = {
  name: 'http.get',
  description: 'Fetch a URL over HTTP GET and return the response body. Read-only.',
  inputSchema: HTTP_INPUT,
  operations: ['read', 'network'],
  destructive: false,
  idempotent: true,
  extractDomains: (args) => hostOf(args['url']),
  describeImpact: (args) => `GET ${String(args['url'])}`,
  timeoutMs: 30_000,
  rateLimit: { limit: 60, windowMs: 60_000 },
  source: 'builtin',
  async handler(args, context) {
    const url = buildUrl(String(args['url']), args['query']);
    const response = await context.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/*;q=0.9, */*;q=0.5', ...(await resolveHeaders(args['headers'], context)) },
    });
    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries([...response.headers].filter(([k]) => !/^set-cookie$/i.test(k))),
      body: await readBody(response),
    };
  },
};

export const httpPostTool: ToolDefinition = {
  name: 'http.post',
  description: 'Send an HTTP POST request with a JSON body. Writes data to a remote system.',
  inputSchema: {
    type: 'object',
    properties: {
      ...HTTP_INPUT.properties,
      body: { description: 'JSON request body' },
      method: { enum: ['POST', 'PUT', 'PATCH'], default: 'POST' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  operations: ['write', 'network'],
  destructive: false,
  idempotent: false,
  extractDomains: (args) => hostOf(args['url']),
  describeImpact: (args) => `${String(args['method'] ?? 'POST')} ${String(args['url'])} with a JSON body`,
  timeoutMs: 30_000,
  rateLimit: { limit: 30, windowMs: 60_000 },
  source: 'builtin',
  async handler(args, context) {
    const response = await context.fetch(buildUrl(String(args['url']), args['query']), {
      method: String(args['method'] ?? 'POST'),
      headers: { 'content-type': 'application/json', ...(await resolveHeaders(args['headers'], context)) },
      body: args['body'] === undefined ? undefined : JSON.stringify(args['body']),
    });
    return { status: response.status, ok: response.ok, body: await readBody(response) };
  },
};

export const httpDeleteTool: ToolDefinition = {
  name: 'http.delete',
  description: 'Send an HTTP DELETE request. Destructive: removes a remote resource.',
  inputSchema: HTTP_INPUT,
  operations: ['delete', 'network'],
  destructive: true,
  idempotent: true,
  extractDomains: (args) => hostOf(args['url']),
  describeImpact: (args) => `DELETE ${String(args['url'])} — this removes a remote resource`,
  timeoutMs: 30_000,
  rateLimit: { limit: 10, windowMs: 60_000 },
  source: 'builtin',
  async handler(args, context) {
    const response = await context.fetch(String(args['url']), {
      method: 'DELETE',
      headers: await resolveHeaders(args['headers'], context),
    });
    return { status: response.status, ok: response.ok, body: await readBody(response) };
  },
};

export const mathTool: ToolDefinition = {
  name: 'math.evaluate',
  description:
    'Evaluate an arithmetic expression. Supports + - * / % ^, parentheses, pi, e and abs/ceil/floor/round/sqrt/min/max/log/log10/exp/pow.',
  inputSchema: {
    type: 'object',
    properties: { expression: { type: 'string', maxLength: 500 } },
    required: ['expression'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { result: { type: 'number' } }, required: ['result'] },
  operations: ['read'],
  destructive: false,
  idempotent: true,
  timeoutMs: 1_000,
  source: 'builtin',
  describeImpact: (args) => `evaluate ${String(args['expression'])}`,
  async handler(args) {
    return { result: evaluateExpression(String(args['expression'])) };
  },
};

export const timeTool: ToolDefinition = {
  name: 'time.now',
  description: 'Return the current time as an ISO-8601 UTC timestamp and epoch milliseconds.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  operations: ['read'],
  destructive: false,
  idempotent: true,
  timeoutMs: 1_000,
  source: 'builtin',
  async handler(_args, context) {
    const now = context.clock.now();
    return { iso: new Date(now).toISOString(), epochMs: now };
  },
};

export const jsonPickTool: ToolDefinition = {
  name: 'json.pick',
  description: 'Read a value out of a JSON document using a dotted path such as "a.b[0].c".',
  inputSchema: {
    type: 'object',
    properties: {
      document: { description: 'The JSON document to read from' },
      path: { type: 'string', maxLength: 200 },
    },
    required: ['document', 'path'],
    additionalProperties: false,
  },
  operations: ['read'],
  destructive: false,
  idempotent: true,
  timeoutMs: 1_000,
  source: 'builtin',
  async handler(args) {
    const segments = String(args['path'])
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .filter(Boolean);
    let current: JsonValue = (args['document'] ?? null) as JsonValue;
    for (const segment of segments) {
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index)) throw new AgentOSError('invalid_request', `'${segment}' is not an array index`);
        current = current[index] ?? null;
      } else if (isJsonObject(current)) {
        current = (current as JsonObject)[segment] ?? null;
      } else {
        return { value: null, found: false };
      }
    }
    return { value: current, found: current !== null };
  },
};

export const BUILTIN_TOOLS: ToolDefinition[] = [
  httpGetTool,
  httpPostTool,
  httpDeleteTool,
  mathTool,
  timeTool,
  jsonPickTool,
];
