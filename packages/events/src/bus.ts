import { newId, type Clock, type Logger, type Redactor, systemClock, nullLogger, defaultRedactor } from '@agentos/core';
import { matchesFilter, type AnyEvent, type EventFilter, type EventPayloads, type EventRecord, type EventType } from './types.js';

export type EventHandler = (event: AnyEvent) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

/** Durable sink. The in-memory bus fans out; the store persists. */
export interface EventSink {
  append(events: AnyEvent[]): Promise<void>;
}

export interface EventBus {
  publish(event: AnyEvent): Promise<void>;
  subscribe(filter: EventFilter, handler: EventHandler): Subscription;
}

export interface EmitContext {
  orgId: string;
  executionId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  traceId: string;
  spanId?: string | null;
  parentSpanId?: string | null;
  durationMs?: number | null;
}

/**
 * Buffers events for one execution, assigns sequence numbers, redacts payloads
 * and flushes to the sink + bus. Sequence numbers are assigned here so that the
 * trace can be rebuilt in order even if the sink writes out of order.
 */
export class EventEmitter {
  private seq: number;
  private buffer: AnyEvent[] = [];

  constructor(
    private readonly context: EmitContext,
    private readonly options: {
      sink?: EventSink;
      bus?: EventBus;
      clock?: Clock;
      redactor?: Redactor;
      logger?: Logger;
      startSeq?: number;
      autoFlush?: boolean;
    } = {},
  ) {
    this.seq = options.startSeq ?? 0;
  }

  get nextSeq(): number {
    return this.seq;
  }

  child(overrides: Partial<EmitContext>): EventEmitter {
    const emitter = new EventEmitter({ ...this.context, ...overrides }, { ...this.options, startSeq: this.seq });
    return emitter;
  }

  async emit<T extends EventType>(
    type: T,
    payload: EventPayloads[T],
    overrides: Partial<EmitContext> = {},
  ): Promise<EventRecord<T>> {
    const clock = this.options.clock ?? systemClock;
    const redactor = this.options.redactor ?? defaultRedactor;
    const ctx = { ...this.context, ...overrides };
    this.seq += 1;
    const event = {
      id: newId('event'),
      orgId: ctx.orgId,
      seq: this.seq,
      type,
      at: clock.now(),
      executionId: ctx.executionId ?? null,
      agentId: ctx.agentId ?? null,
      taskId: ctx.taskId ?? null,
      traceId: ctx.traceId,
      spanId: ctx.spanId ?? null,
      parentSpanId: ctx.parentSpanId ?? null,
      durationMs: ctx.durationMs ?? null,
      payload: redactor.value(payload as never) as EventPayloads[T],
    } as EventRecord<T>;

    this.buffer.push(event as AnyEvent);
    if (this.options.autoFlush !== false) await this.flush();
    else (this.options.logger ?? nullLogger).debug('event buffered', { type, seq: this.seq });
    return event;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    if (this.options.sink) await this.options.sink.append(batch);
    if (this.options.bus) {
      for (const event of batch) await this.options.bus.publish(event);
    }
  }
}

export class InMemoryEventBus implements EventBus {
  private readonly subscribers = new Set<{ filter: EventFilter; handler: EventHandler }>();
  private readonly log: AnyEvent[] = [];

  constructor(private readonly options: { retain?: number; logger?: Logger } = {}) {}

  async publish(event: AnyEvent): Promise<void> {
    const retain = this.options.retain ?? 1_000;
    this.log.push(event);
    if (this.log.length > retain) this.log.splice(0, this.log.length - retain);
    for (const sub of this.subscribers) {
      if (!matchesFilter(event, sub.filter)) continue;
      try {
        await sub.handler(event);
      } catch (error) {
        (this.options.logger ?? nullLogger).warn('event subscriber threw', {
          type: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  subscribe(filter: EventFilter, handler: EventHandler): Subscription {
    const entry = { filter, handler };
    this.subscribers.add(entry);
    return { unsubscribe: () => this.subscribers.delete(entry) };
  }

  /** Replay retained events, then stream new ones. Backs the SSE endpoint. */
  async *stream(filter: EventFilter, signal?: AbortSignal): AsyncGenerator<AnyEvent> {
    const queue: AnyEvent[] = this.log.filter((e) => matchesFilter(e, filter));
    let resolve: (() => void) | null = null;
    const sub = this.subscribe(filter, (event) => {
      queue.push(event);
      resolve?.();
      resolve = null;
    });
    try {
      while (!signal?.aborted) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        await new Promise<void>((r) => {
          resolve = r;
          signal?.addEventListener('abort', () => r(), { once: true });
        });
      }
    } finally {
      sub.unsubscribe();
    }
  }

  get size(): number {
    return this.log.length;
  }
}

/** Sink that never loses an event but also never blocks the runtime for long. */
export class BufferedEventSink implements EventSink {
  private queue: AnyEvent[] = [];
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly inner: EventSink,
    private readonly options: { maxBatch?: number; logger?: Logger } = {},
  ) {}

  async append(events: AnyEvent[]): Promise<void> {
    this.queue.push(...events);
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.flushing) return this.flushing;
    const maxBatch = this.options.maxBatch ?? 100;
    this.flushing = (async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, maxBatch);
        try {
          await this.inner.append(batch);
        } catch (error) {
          // Put the batch back so a transient store failure does not drop history.
          this.queue.unshift(...batch);
          (this.options.logger ?? nullLogger).error('event sink append failed', {
            error: error instanceof Error ? error.message : String(error),
            pending: this.queue.length,
          });
          throw error;
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  get pending(): number {
    return this.queue.length;
  }
}
