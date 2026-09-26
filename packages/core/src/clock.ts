export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Deterministic clock: tests advance time explicitly instead of sleeping. */
export class TestClock implements Clock {
  private current: number;
  private waiters: Array<{ at: number; resolve: () => void }> = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ at: this.current + ms, resolve });
    });
  }

  advance(ms: number): void {
    this.current += ms;
    const due = this.waiters.filter((w) => w.at <= this.current);
    this.waiters = this.waiters.filter((w) => w.at > this.current);
    for (const w of due) w.resolve();
  }

  set(ms: number): void {
    this.current = ms;
  }
}

/**
 * Virtual clock whose sleeps resolve immediately while `now()` still advances by
 * the slept amount. Lets a test exercise real backoff and circuit-reset logic
 * without spending wall-clock time or needing to pump timers by hand.
 */
export class FastClock implements Clock {
  private current: number;
  private slept = 0;

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('aborted');
    this.current += Math.max(0, ms);
    this.slept += Math.max(0, ms);
  }

  /** Total virtual time spent sleeping, for asserting on backoff behaviour. */
  get totalSleptMs(): number {
    return this.slept;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
