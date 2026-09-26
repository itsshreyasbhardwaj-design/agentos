import {
  AgentOSError,
  randomToken,
  roleHasPermission,
  sha256,
  type Permission,
  type Principal,
  type Role,
} from '@agentos/core';
import type { Store } from '@agentos/store';
import type { Context, MiddlewareHandler } from 'hono';

export const API_KEY_PREFIX = 'aos_';

export interface IssuedApiKey {
  id: string;
  /** Shown once at creation. Only its hash is stored. */
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(): IssuedApiKey {
  const secret = randomToken(32);
  const plaintext = `${API_KEY_PREFIX}${secret}`;
  return {
    id: '',
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: sha256(plaintext),
  };
}

function bearer(c: Context): string | null {
  const header = c.req.header('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

export interface AuthOptions {
  store: Store;
  /**
   * Development-only escape hatch: when set, requests without a key run as this
   * principal. Refused unless AGENTOS_DEV_AUTH is explicitly enabled.
   */
  devPrincipal?: Principal;
  now(): number;
}

/**
 * Authenticate by API key.
 *
 * Keys are looked up by SHA-256 hash, never by prefix or plaintext, and the row
 * carries the org — so the tenant comes from the credential rather than from
 * anything the caller can set in the request.
 */
export function authMiddleware(options: AuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const token = bearer(c);

    if (!token) {
      if (options.devPrincipal) {
        c.set('principal', options.devPrincipal);
        await next();
        return;
      }
      throw new AgentOSError('unauthenticated', 'missing bearer token');
    }

    const record = await options.store.apiKeys.getByHash(sha256(token));
    if (!record || record.revokedAt !== null) {
      throw new AgentOSError('unauthenticated', 'invalid or revoked API key');
    }

    const principal: Principal = {
      userId: record.userId,
      orgId: record.orgId,
      role: record.role,
      apiKeyId: record.id,
    };
    c.set('principal', principal);
    void options.store.apiKeys.touch(record.id, options.now()).catch(() => undefined);
    await next();
  };
}

export function principalOf(c: Context): Principal {
  const principal = c.get('principal') as Principal | undefined;
  if (!principal) throw new AgentOSError('unauthenticated', 'not authenticated');
  return principal;
}

/** Require a permission. Role → permission mapping lives in the core model. */
export function requirePermission(permission: Permission): MiddlewareHandler {
  return async (c, next) => {
    const principal = principalOf(c);
    if (!roleHasPermission(principal.role, permission)) {
      throw new AgentOSError('forbidden', `role '${principal.role}' may not ${permission}`, {
        details: { required: permission, role: principal.role },
      });
    }
    await next();
  };
}

export function assertRole(principal: Principal, ...roles: Role[]): void {
  if (!roles.includes(principal.role)) {
    throw new AgentOSError('forbidden', `this action requires one of: ${roles.join(', ')}`);
  }
}
