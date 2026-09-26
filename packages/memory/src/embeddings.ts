import { AgentOSError, sha256 } from '@agentos/core';
import type { EmbeddingProvider } from './types.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'as', 'at', 'by',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Deterministic local embeddings via the hashing trick (bag of words + bigrams
 * hashed into a fixed vector, L2-normalised).
 *
 * This is lexical, not semantic: it will match paraphrases far worse than a real
 * embedding model. It exists so memory search works offline, in tests and in the
 * demo environment without an embedding API bill — swap in {@link remoteEmbeddingProvider}
 * for production semantic recall.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hashing';
  readonly remote = false;

  constructor(readonly dimensions = 384) {}

  private hashToIndex(token: string): number {
    return parseInt(sha256(token).slice(0, 8), 16) % this.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      const tokens = tokenize(text);
      const grams = [...tokens, ...tokens.slice(0, -1).map((t, i) => `${t}_${tokens[i + 1]}`)];
      for (const gram of grams) {
        const index = this.hashToIndex(gram);
        // Signed hashing reduces collision bias.
        const sign = parseInt(sha256(`sign:${gram}`).slice(0, 2), 16) % 2 === 0 ? 1 : -1;
        vector[index] = (vector[index] ?? 0) + sign;
      }
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      return norm === 0 ? vector : vector.map((v) => v / norm);
    });
  }
}

export interface RemoteEmbeddingOptions {
  id?: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKey: () => string | undefined;
  fetchImpl?: typeof fetch;
}

/** Any OpenAI-compatible `/embeddings` endpoint, including local servers. */
export function remoteEmbeddingProvider(options: RemoteEmbeddingOptions): EmbeddingProvider {
  return {
    id: options.id ?? 'remote-embeddings',
    dimensions: options.dimensions,
    remote: !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(options.baseUrl),
    async embed(texts) {
      const key = options.apiKey();
      const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: options.model, input: texts }),
      });
      if (!response.ok) {
        throw new AgentOSError('provider_unavailable', `embedding request failed with HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
      const vectors = payload.data?.map((d) => d.embedding) ?? [];
      if (vectors.length !== texts.length) {
        throw new AgentOSError('provider_error', 'embedding provider returned the wrong number of vectors');
      }
      return vectors;
    },
  };
}
