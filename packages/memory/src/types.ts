import type { JsonObject, MemoryScope } from '@agentos/core';

export interface MemoryRecord {
  id: string;
  orgId: string;
  agentId: string | null;
  namespace: string;
  scope: MemoryScope;
  /** Stable key for upserts. Omitted for append-only episodic entries. */
  key: string | null;
  content: string;
  metadata: JsonObject;
  embedding: number[] | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  /** Execution that produced this memory, for provenance. */
  sourceExecutionId: string | null;
}

export interface MemoryWrite {
  orgId: string;
  agentId?: string | null;
  namespace: string;
  scope: MemoryScope;
  key?: string | null;
  content: string;
  metadata?: JsonObject;
  ttlMs?: number;
  sourceExecutionId?: string | null;
}

export interface MemoryQuery {
  orgId: string;
  namespace: string;
  scope?: MemoryScope;
  agentId?: string | null;
  /** Free-text query; enables semantic ranking when embeddings are available. */
  query?: string;
  key?: string;
  limit?: number;
  minScore?: number;
}

export interface MemoryHit {
  record: MemoryRecord;
  /** 0–1 relevance. Exactly 1 for a direct key lookup. */
  score: number;
}

export interface MemoryProvider {
  readonly id: string;
  /** Scopes this provider can serve; the runtime skips the rest. */
  readonly scopes: readonly MemoryScope[];
  write(write: MemoryWrite): Promise<MemoryRecord>;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  get(orgId: string, id: string): Promise<MemoryRecord | null>;
  delete(orgId: string, id: string): Promise<boolean>;
  clear(orgId: string, namespace?: string): Promise<number>;
  /** Remove expired records. Returns how many were dropped. */
  prune?(now: number): Promise<number>;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  /** True when embedding leaves the machine (and may cost money). */
  readonly remote: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
