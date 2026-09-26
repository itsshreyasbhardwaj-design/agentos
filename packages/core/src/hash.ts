import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { stableStringify } from './json.js';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable hash of any JSON value — key order does not change the result. */
export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

export function hmacSha256(key: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

/** Constant-time comparison that does not leak length through early return. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not reveal the length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
