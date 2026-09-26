import { AgentOSError, type MemorySpec, type MemoryScope } from '@agentos/core';
import type { MemoryHit, MemoryProvider, MemoryQuery, MemoryRecord, MemoryWrite } from './types.js';

/**
 * Routes memory operations to whichever provider serves the requested scope, so
 * an org can keep short-term state in Redis and semantic recall in pgvector
 * without the runtime knowing.
 */
export class MemoryManager {
  private readonly providers = new Map<string, MemoryProvider>();

  register(provider: MemoryProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  list(): MemoryProvider[] {
    return [...this.providers.values()];
  }

  resolve(spec: MemorySpec | undefined, scope: MemoryScope): MemoryProvider | null {
    if (!spec || !spec.scopes.includes(scope)) return null;
    const provider = this.providers.get(spec.provider);
    if (!provider) {
      throw new AgentOSError('invalid_request', `memory provider '${spec.provider}' is not registered`, {
        details: { known: [...this.providers.keys()] },
      });
    }
    if (!provider.scopes.includes(scope)) {
      throw new AgentOSError('invalid_request', `memory provider '${spec.provider}' does not support scope '${scope}'`);
    }
    return provider;
  }

  async write(spec: MemorySpec | undefined, write: MemoryWrite): Promise<MemoryRecord | null> {
    const provider = this.resolve(spec, write.scope);
    if (!provider) return null;
    return provider.write(write);
  }

  async search(spec: MemorySpec | undefined, query: MemoryQuery): Promise<MemoryHit[]> {
    const scope = query.scope ?? 'semantic';
    const provider = this.resolve(spec, scope);
    if (!provider) return [];
    return provider.search({ ...query, limit: query.limit ?? spec?.recallLimit ?? 5 });
  }

  /** Format recalled memories for the prompt. Provenance is always attached. */
  static render(hits: MemoryHit[]): string {
    if (hits.length === 0) return '';
    const lines = hits.map((hit, i) => {
      const when = new Date(hit.record.updatedAt).toISOString().slice(0, 10);
      return `${i + 1}. [${hit.record.scope}, ${when}, relevance ${hit.score.toFixed(2)}] ${hit.record.content}`;
    });
    return `Recalled memories (stored by earlier runs of this agent; verify before relying on them):\n${lines.join('\n')}`;
  }
}
