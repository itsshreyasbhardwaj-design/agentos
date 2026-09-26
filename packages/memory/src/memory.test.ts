import { TestClock } from '@agentos/core';
import { describe, expect, it } from 'vitest';
import { HashingEmbeddingProvider, tokenize } from './embeddings.js';
import { InMemoryMemoryProvider } from './in-memory.js';
import { MemoryManager } from './manager.js';
import { cosineSimilarity } from './types.js';

describe('HashingEmbeddingProvider', () => {
  it('is deterministic and normalised', async () => {
    const provider = new HashingEmbeddingProvider(64);
    const [a] = await provider.embed(['deploy the api service']);
    const [b] = await provider.embed(['deploy the api service']);
    expect(a).toEqual(b);
    const norm = Math.sqrt((a ?? []).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('scores shared vocabulary above unrelated text', async () => {
    const provider = new HashingEmbeddingProvider(512);
    const [query, related, unrelated] = await provider.embed([
      'kubernetes deployment rollout failed',
      'the kubernetes deployment rollout has failed again',
      'banana bread recipe with walnuts',
    ]);
    expect(cosineSimilarity(query ?? [], related ?? [])).toBeGreaterThan(
      cosineSimilarity(query ?? [], unrelated ?? []),
    );
  });

  it('strips stop words', () => {
    expect(tokenize('the quick brown fox is a fox')).toEqual(['quick', 'brown', 'fox', 'fox']);
  });
});

describe('InMemoryMemoryProvider', () => {
  const base = { orgId: 'org_1', namespace: 'notes' };

  it('upserts on key and appends without one', async () => {
    const memory = new InMemoryMemoryProvider();
    await memory.write({ ...base, scope: 'long_term', key: 'owner', content: 'Alice owns billing' });
    await memory.write({ ...base, scope: 'long_term', key: 'owner', content: 'Bob owns billing' });
    await memory.write({ ...base, scope: 'long_term', content: 'unkeyed note' });
    const byKey = await memory.search({ ...base, scope: 'long_term', key: 'owner' });
    expect(byKey).toHaveLength(1);
    expect(byKey[0]?.record.content).toBe('Bob owns billing');
    expect(memory.size).toBe(2);
  });

  it('ranks semantic hits by similarity', async () => {
    const memory = new InMemoryMemoryProvider();
    await memory.write({ ...base, scope: 'semantic', content: 'The payments service uses Stripe webhooks' });
    await memory.write({ ...base, scope: 'semantic', content: 'Our office plants need watering weekly' });
    const hits = await memory.search({ ...base, scope: 'semantic', query: 'stripe webhooks payments', limit: 2 });
    expect(hits[0]?.record.content).toMatch(/Stripe/);
  });

  it('isolates organisations', async () => {
    const memory = new InMemoryMemoryProvider();
    await memory.write({ ...base, scope: 'long_term', content: 'org one secret note' });
    expect(await memory.search({ orgId: 'org_2', namespace: 'notes', scope: 'long_term' })).toHaveLength(0);
  });

  it('expires records after their TTL', async () => {
    const clock = new TestClock(0);
    const memory = new InMemoryMemoryProvider({ clock });
    await memory.write({ ...base, scope: 'short_term', content: 'ephemeral', ttlMs: 1_000 });
    expect(await memory.search({ ...base, scope: 'short_term' })).toHaveLength(1);
    clock.advance(1_001);
    expect(await memory.search({ ...base, scope: 'short_term' })).toHaveLength(0);
    expect(await memory.prune()).toBe(1);
  });

  it('evicts the oldest entries past the cap', async () => {
    const memory = new InMemoryMemoryProvider({ maxRecordsPerNamespace: 3 });
    for (let i = 0; i < 5; i++) {
      await memory.write({ ...base, scope: 'episodic', content: `note ${i}` });
    }
    expect(memory.size).toBe(3);
  });
});

describe('MemoryManager', () => {
  it('returns nothing when the agent declares no memory', async () => {
    const manager = new MemoryManager().register(new InMemoryMemoryProvider());
    expect(await manager.search(undefined, { orgId: 'org_1', namespace: 'n' })).toEqual([]);
  });

  it('refuses a scope the provider does not serve', () => {
    const manager = new MemoryManager().register(new InMemoryMemoryProvider());
    expect(() =>
      manager.resolve({ provider: 'nope', scopes: ['semantic'] }, 'semantic'),
    ).toThrowError(/not registered/);
  });

  it('renders recalled memories with provenance', async () => {
    const memory = new InMemoryMemoryProvider();
    const manager = new MemoryManager().register(memory);
    await memory.write({ orgId: 'org_1', namespace: 'n', scope: 'semantic', content: 'deploys happen on fridays' });
    const hits = await manager.search({ provider: 'in-memory', scopes: ['semantic'] }, {
      orgId: 'org_1', namespace: 'n', scope: 'semantic', query: 'deploys fridays',
    });
    const rendered = MemoryManager.render(hits);
    expect(rendered).toMatch(/verify before relying/);
    expect(rendered).toMatch(/deploys happen on fridays/);
  });
});
