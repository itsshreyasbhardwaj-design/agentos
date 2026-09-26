import { AgentOSError, newId, type Logger } from '@agentos/core';
import type { Context } from 'hono';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

/**
 * Turn any thrown value into an HTTP response.
 *
 * Known AgentOSErrors keep their code, status and details so a client can
 * branch on them. Anything else becomes a generic 500 with a request id: the
 * detail goes to the log, not to the caller, because an unexpected error's
 * message may quote internals.
 */
export function toErrorResponse(error: unknown, requestId: string, logger: Logger): { status: number; body: ErrorBody } {
  if (AgentOSError.is(error)) {
    if (error.status >= 500) {
      logger.error('request failed', { requestId, code: error.code, message: error.message });
    }
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
          requestId,
        },
      },
    };
  }

  logger.error('unhandled error', {
    requestId,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  });
  return {
    status: 500,
    body: { error: { code: 'internal', message: 'internal server error', requestId } },
  };
}

export function requestIdOf(c: Context): string {
  return c.get('requestId') ?? newId('audit');
}
