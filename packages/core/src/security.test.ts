import { describe, expect, it } from 'vitest';
import { Redactor, REDACTED } from './redact.js';
import { validateSchema, applyDefaults, type JsonSchema } from './schema.js';
import { MemorySecretResolver, collectSecretRefs, resolveSecrets, secretRef } from './secrets.js';

describe('Redactor', () => {
  it('scrubs sensitive keys regardless of value', () => {
    const out = new Redactor().value({ apiKey: 'plain', nested: { password: 'hunter2' }, keep: 'ok' });
    expect(out).toEqual({ apiKey: REDACTED, nested: { password: REDACTED }, keep: 'ok' });
  });

  it('scrubs credential-shaped values under innocuous keys', () => {
    const r = new Redactor();
    expect(r.string('use sk-abcdefghijklmnopqrstuvwx now')).toContain(REDACTED);
    expect(r.string('ghp_0123456789abcdefghijABCDEFGHIJ')).toBe(REDACTED);
    expect(r.string('Authorization: Bearer abcdefghijklmnop')).toContain(REDACTED);
  });

  it('scrubs resolved secret literals wherever they appear', () => {
    const r = new Redactor({ literals: ['s3cret-value-123'] });
    expect(r.string('token is s3cret-value-123 ok')).toBe(`token is ${REDACTED} ok`);
    expect(r.containsLiteral('s3cret-value-123')).toBe(true);
  });

  it('truncates very long strings', () => {
    const r = new Redactor({ maxStringLength: 10 });
    expect(r.string('x'.repeat(50))).toMatch(/truncated 40 chars/);
  });
});

describe('validateSchema', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      mode: { enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    },
    required: ['url'],
    additionalProperties: false,
  };

  it('accepts a valid payload', () => {
    expect(validateSchema({ url: 'https://x.dev', count: 3, mode: 'a' }, schema).valid).toBe(true);
  });

  it('reports missing required fields', () => {
    const result = validateSchema({ count: 2 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.path)).toContain('url');
  });

  it('rejects unknown properties when additionalProperties is false', () => {
    const result = validateSchema({ url: 'https://x.dev', injected: true }, schema);
    expect(result.errors[0]?.path).toBe('injected');
  });

  it('enforces numeric bounds and integer-ness', () => {
    expect(validateSchema({ url: 'https://x.dev', count: 11 }, schema).valid).toBe(false);
    expect(validateSchema({ url: 'https://x.dev', count: 1.5 }, schema).valid).toBe(false);
  });

  it('enforces formats, enums and array bounds', () => {
    expect(validateSchema({ url: 'not a url' }, schema).valid).toBe(false);
    expect(validateSchema({ url: 'https://x.dev', mode: 'c' }, schema).valid).toBe(false);
    expect(validateSchema({ url: 'https://x.dev', tags: ['a', 'b', 'c'] }, schema).valid).toBe(false);
  });

  it('applies declared defaults', () => {
    const withDefaults = applyDefaults(
      {},
      { type: 'object', properties: { n: { type: 'number', default: 7 } } },
    );
    expect(withDefaults).toEqual({ n: 7 });
  });
});

describe('secret references', () => {
  it('resolves refs only at the execution boundary', async () => {
    const resolver = new MemorySecretResolver({ TOKEN: 'abc123xyz' });
    const collected = new Set<string>();
    const out = await resolveSecrets(
      { headers: { authorization: secretRef('TOKEN') }, plain: 'x' },
      'org_1',
      resolver,
      collected,
    );
    expect(out).toEqual({ headers: { authorization: 'abc123xyz' }, plain: 'x' });
    expect([...collected]).toEqual(['abc123xyz']);
  });

  it('throws secret_missing for unknown names', async () => {
    const resolver = new MemorySecretResolver({});
    await expect(resolveSecrets(secretRef('NOPE'), 'org_1', resolver)).rejects.toMatchObject({
      code: 'secret_missing',
    });
  });

  it('collects referenced names without resolving them', () => {
    const names = collectSecretRefs({ a: secretRef('A'), b: [secretRef('B')] });
    expect([...names].sort()).toEqual(['A', 'B']);
  });
});
