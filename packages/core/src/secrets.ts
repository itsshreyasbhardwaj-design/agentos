import { AgentOSError } from './errors.js';
import { isJsonObject, type JsonValue } from './json.js';

/** A reference to a secret. Definitions and API payloads only ever hold these. */
export interface SecretRef {
  $secret: string;
}

export function secretRef(name: string): SecretRef {
  return { $secret: name };
}

export function isSecretRef(value: unknown): value is SecretRef {
  return isJsonObject(value) && typeof (value as Record<string, unknown>)['$secret'] === 'string';
}

export interface SecretResolver {
  /** Returns the secret value, or throws `secret_missing`. */
  resolve(orgId: string, name: string): Promise<string>;
  /** Names visible to this org — used for validation, never values. */
  list(orgId: string): Promise<string[]>;
}

export class EnvSecretResolver implements SecretResolver {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly prefix = 'AGENTOS_SECRET_',
  ) {}

  async resolve(_orgId: string, name: string): Promise<string> {
    const value = this.env[`${this.prefix}${name}`];
    if (value === undefined || value === '') {
      throw new AgentOSError('secret_missing', `secret ${name} is not configured`, {
        details: { name },
      });
    }
    return value;
  }

  async list(_orgId: string): Promise<string[]> {
    return Object.keys(this.env)
      .filter((k) => k.startsWith(this.prefix))
      .map((k) => k.slice(this.prefix.length));
  }
}

export class MemorySecretResolver implements SecretResolver {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}, private readonly orgScope = '*') {
    for (const [k, v] of Object.entries(initial)) this.values.set(this.key(this.orgScope, k), v);
  }

  private key(orgId: string, name: string): string {
    return `${orgId}:${name}`;
  }

  set(orgId: string, name: string, value: string): void {
    this.values.set(this.key(orgId, name), value);
  }

  async resolve(orgId: string, name: string): Promise<string> {
    const value = this.values.get(this.key(orgId, name)) ?? this.values.get(this.key('*', name));
    if (value === undefined) {
      throw new AgentOSError('secret_missing', `secret ${name} is not configured`, {
        details: { name },
      });
    }
    return value;
  }

  async list(orgId: string): Promise<string[]> {
    const names = new Set<string>();
    for (const key of this.values.keys()) {
      const [scope, ...rest] = key.split(':');
      if (scope === orgId || scope === '*') names.add(rest.join(':'));
    }
    return [...names];
  }
}

/**
 * Walk a JSON value and replace every {@link SecretRef} with its resolved value.
 * Used at the boundary of a tool call — never before the value reaches a model.
 */
export async function resolveSecrets(
  value: JsonValue,
  orgId: string,
  resolver: SecretResolver,
  collected?: Set<string>,
): Promise<JsonValue> {
  if (isSecretRef(value)) {
    const resolved = await resolver.resolve(orgId, value.$secret);
    collected?.add(resolved);
    return resolved;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolveSecrets(v, orgId, resolver, collected)));
  }
  if (isJsonObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await resolveSecrets(v, orgId, resolver, collected);
    }
    return out;
  }
  return value;
}

/** Collect the secret names referenced anywhere inside a value. */
export function collectSecretRefs(value: JsonValue, into: Set<string> = new Set()): Set<string> {
  if (isSecretRef(value)) {
    into.add(value.$secret);
    return into;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectSecretRefs(v, into);
    return into;
  }
  if (isJsonObject(value)) {
    for (const v of Object.values(value)) collectSecretRefs(v, into);
  }
  return into;
}
