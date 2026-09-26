import { FastClock, userMessage, type ModelSelector } from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from './registry.js';
import { ModelRouter, type RouterHooks } from './router.js';
import { ScriptedProvider } from './scripted.js';

function registryWith(...providers: ScriptedProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const p of providers) registry.register(p);
  return registry;
}

const request = { messages: [userMessage('hello')] };

describe('ProviderRegistry', () => {
  it('resolves qualified ids', () => {
    const registry = registryWith(new ScriptedProvider({ id: 'a', scripts: { m1: [{ content: 'x' }] } }));
    const resolved = registry.resolve('a:m1');
    expect(resolved.provider.id).toBe('a');
    expect(resolved.model).toBe('m1');
  });

  it('routes a bare id to the provider that claims it', () => {
    const registry = registryWith(
      new ScriptedProvider({ id: 'a', scripts: { only_a: [{ content: 'x' }] } }),
      new ScriptedProvider({ id: 'b', scripts: { only_b: [{ content: 'y' }] } }),
    );
    expect(registry.resolve('only_b').provider.id).toBe('b');
  });

  it('throws for an unknown provider', () => {
    expect(() => registryWith().get('nope')).toThrowError(/unknown model provider/);
  });
});

describe('ModelRouter candidates', () => {
  it('puts the task-class route first and keeps the primary as a fallback', () => {
    const registry = registryWith(new ScriptedProvider({ id: 's', fallback: () => ({ content: 'x' }) }));
    const router = new ModelRouter({ registry });
    const selector: ModelSelector = {
      primary: 's:big',
      fallbacks: ['s:backup'],
      routes: { cheap: 's:small' },
    };
    expect(router.candidates(selector, 'cheap')).toEqual(['s:small', 's:big', 's:backup']);
    expect(router.candidates(selector, 'default')).toEqual(['s:big', 's:backup']);
  });
});

describe('retry and fallback', () => {
  it('retries a retryable error and then succeeds', async () => {
    const clock = new FastClock();
    const provider = new ScriptedProvider({
      id: 's',
      scripts: {
        m: [
          { error: { code: 'provider_unavailable', message: 'down' } },
          { content: 'recovered' },
        ],
      },
    });
    const router = new ModelRouter({ registry: registryWith(provider), clock });
    const result = await router.generate({ primary: 's:m' }, request);
    expect(result.content).toBe('recovered');
    expect(result.attempts).toBe(2);
    expect(result.fellBackFrom).toBeNull();
  });

  it('falls back to the next model when the primary is exhausted', async () => {
    const clock = new FastClock();
    const bad = new ScriptedProvider({
      id: 'bad',
      fallback: () => ({ error: { code: 'provider_unavailable' as const, message: 'always down' } }),
    });
    const good = new ScriptedProvider({ id: 'good', fallback: () => ({ content: 'from fallback' }) });
    const onFallback = vi.fn();
    const hooks: RouterHooks = { onFallback };
    const router = new ModelRouter({ registry: registryWith(bad, good), clock, hooks });
    const result = await router.generate({ primary: 'bad:m', fallbacks: ['good:m'] }, request);
    expect(result.content).toBe('from fallback');
    expect(result.fellBackFrom).toBe('bad:m');
    expect(onFallback).toHaveBeenCalled();
  });

  it('fails fast on a non-retryable error instead of walking the chain', async () => {
    const clock = new FastClock();
    const bad = new ScriptedProvider({ id: 'bad', scripts: {} });
    const good = new ScriptedProvider({ id: 'good', fallback: () => ({ content: 'unused' }) });
    const router = new ModelRouter({ registry: registryWith(bad, good), clock });
    await expect(
      router.generate({ primary: 'bad:missing', fallbacks: ['good:m'] }, request),
    ).rejects.toMatchObject({ code: 'provider_error' });
    expect(good.callCount).toBe(0);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures and skips the model', async () => {
    const clock = new FastClock();
    const bad = new ScriptedProvider({
      id: 'bad',
      fallback: () => ({ error: { code: 'provider_unavailable' as const, message: 'down' } }),
    });
    const onCircuitOpen = vi.fn();
    const router = new ModelRouter({
      registry: registryWith(bad),
      clock,
      circuit: { failureThreshold: 2, resetTimeoutMs: 60_000, successThreshold: 1 },
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, multiplier: 2, jitter: 0 },
      hooks: { onCircuitOpen },
    });

    await expect(router.generate({ primary: 'bad:m' }, request)).rejects.toBeDefined();
    expect(router.circuitStatus('bad:m')).toBe('open');

    const callsBefore = bad.callCount;
    await expect(router.generate({ primary: 'bad:m' }, request)).rejects.toBeDefined();
    expect(bad.callCount).toBe(callsBefore);
    expect(onCircuitOpen).toHaveBeenCalled();
  });
});

describe('cost guard', () => {
  it('refuses a call projected to exceed the remaining budget', async () => {
    const provider = new ScriptedProvider({
      id: 's',
      fallback: () => ({ content: 'x' }),
      pricePerMTokens: { input: 10_000_000, output: 30_000_000 },
    });
    const router = new ModelRouter({ registry: registryWith(provider) });
    await expect(
      router.generate({ primary: 's:m' }, { messages: [userMessage('x'.repeat(4_000))] }, { budgetMicroUsd: 10 }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(provider.callCount).toBe(0);
  });

  it('allows the call when the projection fits', async () => {
    const provider = new ScriptedProvider({ id: 's', fallback: () => ({ content: 'ok' }) });
    const router = new ModelRouter({ registry: registryWith(provider) });
    const result = await router.generate({ primary: 's:m' }, request, { budgetMicroUsd: 10_000_000 });
    expect(result.content).toBe('ok');
  });
});

describe('offline-only executions', () => {
  it('refuses remote providers', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'remote',
      remote: true,
      supports: () => true,
      listModels: () => [],
      info: () => null,
      generate: async () => {
        throw new Error('should not be called');
      },
    });
    const router = new ModelRouter({ registry });
    await expect(router.generate({ primary: 'remote:m' }, request, { offlineOnly: true })).rejects.toMatchObject({
      code: 'policy_denied',
    });
  });
});

describe('timeout', () => {
  it('aborts a call that outlives the router timeout', async () => {
    const provider = new ScriptedProvider({ id: 's', fallback: () => ({ content: 'slow', latencyMs: 50 }) });
    const router = new ModelRouter({
      registry: registryWith(provider),
      timeoutMs: 5,
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitter: 0 },
    });
    await expect(router.generate({ primary: 's:m' }, request)).rejects.toMatchObject({ code: 'timeout' });
  });
});
