export type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'unauthenticated'
  | 'forbidden'
  | 'policy_denied'
  | 'approval_required'
  | 'approval_rejected'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error'
  | 'provider_unavailable'
  | 'tool_error'
  | 'tool_not_found'
  | 'schema_invalid'
  | 'secret_missing'
  | 'state_invalid'
  | 'cancelled'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  unauthenticated: 401,
  forbidden: 403,
  policy_denied: 403,
  approval_required: 409,
  approval_rejected: 409,
  limit_exceeded: 429,
  rate_limited: 429,
  timeout: 504,
  provider_error: 502,
  provider_unavailable: 503,
  tool_error: 500,
  tool_not_found: 404,
  schema_invalid: 400,
  secret_missing: 500,
  state_invalid: 409,
  cancelled: 499,
  internal: 500,
};

/**
 * Retrying these is safe for idempotent work; everything else is terminal.
 *
 * `provider_error` is deliberately absent: it means the provider understood the
 * request and rejected it (bad model id, malformed body, missing script), which
 * will fail identically on every retry and on every fallback. Callers that hit a
 * genuinely transient provider fault opt in with `{ retryable: true }`.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'timeout',
  'provider_unavailable',
  'rate_limited',
  'internal',
]);

export interface AgentOSErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
  retryable?: boolean;
}

export class AgentOSError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: AgentOSErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentOSError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown>; retryable: boolean } {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }

  static is(value: unknown): value is AgentOSError {
    return value instanceof AgentOSError;
  }

  static from(value: unknown, fallback: ErrorCode = 'internal'): AgentOSError {
    if (value instanceof AgentOSError) return value;
    if (value instanceof Error) {
      return new AgentOSError(fallback, value.message, { cause: value });
    }
    return new AgentOSError(fallback, String(value));
  }
}

export const err = {
  notFound: (what: string, id?: string) =>
    new AgentOSError('not_found', id ? `${what} ${id} not found` : `${what} not found`),
  invalid: (message: string, details?: Record<string, unknown>) =>
    new AgentOSError('invalid_request', message, { details: details ?? {} }),
  forbidden: (message: string, details?: Record<string, unknown>) =>
    new AgentOSError('forbidden', message, { details: details ?? {} }),
  conflict: (message: string, details?: Record<string, unknown>) =>
    new AgentOSError('conflict', message, { details: details ?? {} }),
};
