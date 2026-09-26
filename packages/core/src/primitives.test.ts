import { describe, expect, it } from 'vitest';
import { hashJson, safeEqual, sha256 } from './hash.js';
import { newId, ulid } from './ids.js';
import { stableStringify } from './json.js';
import { anyHostMatch, globMatch, hostMatch } from './match.js';
import { TestClock } from './clock.js';

describe('ulid', () => {
  it('is lexicographically sortable by time', () => {
    const early = ulid(1_000_000);
    const late = ulid(2_000_000);
    expect(early < late).toBe(true);
  });

  it('stays monotonic inside a single millisecond', () => {
    const ids = Array.from({ length: 500 }, () => ulid(1_700_000_000_000));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prefixes ids by kind', () => {
    expect(newId('execution')).toMatch(/^exec_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('stableStringify', () => {
  it('ignores key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('gives equal hashes for equal content', () => {
    expect(hashJson({ x: [1, 2], y: 'z' })).toBe(hashJson({ y: 'z', x: [1, 2] }));
  });
});

describe('safeEqual', () => {
  it('compares equal strings', () => {
    expect(safeEqual(sha256('a'), sha256('a'))).toBe(true);
  });
  it('rejects different strings and different lengths', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('glob and host matching', () => {
  it('matches tool globs', () => {
    expect(globMatch('github.*', 'github.list_issues')).toBe(true);
    expect(globMatch('github.*', 'gitlab.list_issues')).toBe(false);
    expect(globMatch('*', 'anything')).toBe(true);
    expect(globMatch('http.get', 'http.get')).toBe(true);
  });

  it('does not let a wildcard subdomain match the apex', () => {
    expect(hostMatch('*.example.com', 'api.example.com')).toBe(true);
    expect(hostMatch('*.example.com', 'example.com')).toBe(false);
    expect(hostMatch('example.com', 'example.com')).toBe(true);
    expect(hostMatch('example.com', 'evil-example.com')).toBe(false);
  });

  it('is not fooled by a suffix lookalike', () => {
    expect(anyHostMatch(['*.example.com'], 'api.example.com.evil.net')).toBe(false);
  });
});

describe('TestClock', () => {
  it('resolves sleepers when time advances', async () => {
    const clock = new TestClock(0);
    let done = false;
    const p = clock.sleep(100).then(() => {
      done = true;
    });
    clock.advance(50);
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advance(50);
    await p;
    expect(done).toBe(true);
  });
});
