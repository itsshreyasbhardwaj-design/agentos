import { AgentOSError } from '@agentos/core';
import { parseModelId, type ModelInfo, type ModelProvider } from './types.js';

export interface ResolvedModel {
  provider: ModelProvider;
  model: string;
  qualified: string;
  info: ModelInfo | null;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private defaultProviderId: string | null = null;

  register(provider: ModelProvider, options: { asDefault?: boolean } = {}): this {
    this.providers.set(provider.id, provider);
    if (options.asDefault || this.defaultProviderId === null) this.defaultProviderId = provider.id;
    return this;
  }

  unregister(id: string): void {
    this.providers.delete(id);
    if (this.defaultProviderId === id) this.defaultProviderId = this.providers.keys().next().value ?? null;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new AgentOSError('invalid_request', `unknown model provider '${id}'`, {
        details: { known: [...this.providers.keys()] },
      });
    }
    return provider;
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  /** Resolve `provider:model`, or a bare model id against the default provider. */
  resolve(qualified: string): ResolvedModel {
    const { provider: providerId, model } = parseModelId(qualified);
    if (providerId) {
      const provider = this.get(providerId);
      return { provider, model, qualified, info: provider.info(model), };
    }
    if (!this.defaultProviderId) {
      throw new AgentOSError('invalid_request', 'no model providers are registered');
    }
    // Prefer a provider that actually claims the model before falling back.
    const owner = this.list().find((p) => p.supports(model)) ?? this.get(this.defaultProviderId);
    return { provider: owner, model, qualified: `${owner.id}:${model}`, info: owner.info(model) };
  }

  catalog(): Array<ModelInfo & { provider: string; remote: boolean }> {
    return this.list().flatMap((p) => p.listModels().map((m) => ({ ...m, provider: p.id, remote: p.remote })));
  }
}
