import { newId, systemClock, type Clock, type MemoryScope } from '@agentos/core';
import { HashingEmbeddingProvider } from './embeddings.js';
import { cosineSimilarity, type EmbeddingProvider, type MemoryHit, type MemoryProvider, type MemoryQuery, type MemoryRecord, type MemoryWrite } from './types.js';

export interface InMemoryMemoryOptions {
  clock?: Clock;
  embeddings?: EmbeddingProvider;
  /** Hard cap per (org, namespace); oldest entries are evicted first. */
  maxRecordsPerNamespace?: number;
  id?: string;
}

const ALL_SCOPES: MemoryScope[] = ['short_term', 'long_term', 'semantic', 'episodic'];

/**
 * Reference memory provider. Backs tests, the demo environment and single-node
 * deployments; the interface is what a hosted vector store (or MemoryDB AI)
 * plugs into, so nothing above this layer knows which one is in use.
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  readonly id: string;
  readonly scopes = ALL_SCOPES;
  private readonly records = new Map<string, MemoryRecord>();
  private readonly clock: Clock;
  private readonly embeddings: EmbeddingProvider;
  private readonly maxPerNamespace: number;

  constructor(options: InMemoryMemoryOptions = {}) {
    this.id = options.id ?? 'in-memory';
    this.clock = options.clock ?? systemClock;
    this.embeddings = options.embeddings ?? new HashingEmbeddingProvider();
    this.maxPerNamespace = options.maxRecordsPerNamespace ?? 5_000;
  }

  private nsKey(orgId: string, namespace: string): string {
    return `${orgId}::${namespace}`;
  }

  private live(record: MemoryRecord, now: number): boolean {
    return record.expiresAt === null || record.expiresAt > now;
  }

  async write(write: MemoryWrite): Promise<MemoryRecord> {
    const now = this.clock.now();
    const needsEmbedding = write.scope === 'semantic' || write.scope === 'episodic';
    const embedding = needsEmbedding ? ((await this.embeddings.embed([write.content]))[0] ?? null) : null;

    // Keyed writes upsert, so a fact can be corrected instead of duplicated.
    if (write.key) {
      for (const existing of this.records.values()) {
        if (
          existing.orgId === write.orgId &&
          existing.namespace === write.namespace &&
          existing.scope === write.scope &&
          existing.key === write.key
        ) {
          const updated: MemoryRecord = {
            ...existing,
            content: write.content,
            metadata: write.metadata ?? existing.metadata,
            embedding,
            updatedAt: now,
            expiresAt: write.ttlMs ? now + write.ttlMs : existing.expiresAt,
            sourceExecutionId: write.sourceExecutionId ?? existing.sourceExecutionId,
          };
          this.records.set(updated.id, updated);
          return updated;
        }
      }
    }

    const record: MemoryRecord = {
      id: newId('memory'),
      orgId: write.orgId,
      agentId: write.agentId ?? null,
      namespace: write.namespace,
      scope: write.scope,
      key: write.key ?? null,
      content: write.content,
      metadata: write.metadata ?? {},
      embedding,
      createdAt: now,
      updatedAt: now,
      expiresAt: write.ttlMs ? now + write.ttlMs : null,
      sourceExecutionId: write.sourceExecutionId ?? null,
    };
    this.records.set(record.id, record);
    this.evict(write.orgId, write.namespace);
    return record;
  }

  private evict(orgId: string, namespace: string): void {
    const inNamespace = [...this.records.values()].filter(
      (r) => this.nsKey(r.orgId, r.namespace) === this.nsKey(orgId, namespace),
    );
    if (inNamespace.length <= this.maxPerNamespace) return;
    inNamespace
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, inNamespace.length - this.maxPerNamespace)
      .forEach((r) => this.records.delete(r.id));
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const now = this.clock.now();
    const limit = query.limit ?? 5;
    const candidates = [...this.records.values()].filter(
      (r) =>
        r.orgId === query.orgId &&
        r.namespace === query.namespace &&
        this.live(r, now) &&
        (query.scope === undefined || r.scope === query.scope) &&
        (query.agentId === undefined || query.agentId === null || r.agentId === query.agentId),
    );

    if (query.key !== undefined) {
      return candidates.filter((r) => r.key === query.key).map((record) => ({ record, score: 1 }));
    }

    if (!query.query) {
      return candidates
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((record) => ({ record, score: 1 }));
    }

    const queryVector = (await this.embeddings.embed([query.query]))[0] ?? [];
    const minScore = query.minScore ?? 0.05;
    return candidates
      .map((record) => ({
        record,
        score: record.embedding ? cosineSimilarity(queryVector, record.embedding) : 0,
      }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async get(orgId: string, id: string): Promise<MemoryRecord | null> {
    const record = this.records.get(id);
    if (!record || record.orgId !== orgId) return null;
    return this.live(record, this.clock.now()) ? record : null;
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.orgId !== orgId) return false;
    return this.records.delete(id);
  }

  async clear(orgId: string, namespace?: string): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.orgId !== orgId) continue;
      if (namespace !== undefined && record.namespace !== namespace) continue;
      this.records.delete(id);
      removed += 1;
    }
    return removed;
  }

  async prune(now = this.clock.now()): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (!this.live(record, now)) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.records.size;
  }
}
