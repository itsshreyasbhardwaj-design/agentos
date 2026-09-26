import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = randomBytes(RAND_LEN);
  return Array.from(bytes, (b) => b % 32);
}

function bumpRandom(chars: number[]): number[] {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i--) {
    const v = next[i] ?? 0;
    if (v < 31) {
      next[i] = v + 1;
      return next;
    }
    next[i] = 0;
  }
  return randomChars();
}

/**
 * ULID-style monotonic identifier: lexicographically sortable by creation time,
 * which is what lets the stores paginate with a plain `id > cursor` comparison.
 */
export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((c) => ALPHABET[c]).join('');
}

export const ID_PREFIXES = {
  org: 'org',
  user: 'usr',
  agent: 'agt',
  version: 'ver',
  execution: 'exec',
  event: 'evt',
  toolCall: 'tc',
  modelCall: 'mc',
  approval: 'apr',
  task: 'task',
  message: 'msg',
  schedule: 'sch',
  webhook: 'whk',
  job: 'job',
  policy: 'pol',
  secret: 'sec',
  memory: 'mem',
  apiKey: 'key',
  mcpServer: 'mcp',
  audit: 'aud',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${ID_PREFIXES[kind]}_`);
}
