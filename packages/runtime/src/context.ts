import {
  defaultRedactor,
  JsonLogger,
  systemClock,
  type Clock,
  type Logger,
  type Redactor,
  type SecretResolver,
} from '@agentos/core';
import type { EventBus, EventSink } from '@agentos/events';
import { MemoryManager } from '@agentos/memory';
import { PolicyEngine } from '@agentos/policy';
import type { ModelRouter } from '@agentos/providers';
import type { Queue } from '@agentos/queue';
import type { Store } from '@agentos/store';
import type { ToolExecutor, ToolRegistry } from '@agentos/tools';

export interface RuntimeContext {
  store: Store;
  queue: Queue;
  registry: ToolRegistry;
  executor: ToolExecutor;
  router: ModelRouter;
  policy: PolicyEngine;
  memory: MemoryManager;
  secrets: SecretResolver;
  bus?: EventBus;
  eventSink?: EventSink;
  clock: Clock;
  logger: Logger;
  redactor: Redactor;
  /** Refuse any remote model provider. Set for offline or air-gapped runs. */
  offlineOnly?: boolean;
  /** How long a worker holds an execution before it is considered dead. */
  leaseMs: number;
  /** Default approval expiry; null means approvals wait indefinitely. */
  approvalTtlMs: number | null;
}

export type RuntimeContextInput = Omit<
  RuntimeContext,
  'clock' | 'logger' | 'redactor' | 'policy' | 'memory' | 'leaseMs' | 'approvalTtlMs' | 'eventSink'
> &
  Partial<Pick<RuntimeContext, 'clock' | 'logger' | 'redactor' | 'policy' | 'memory' | 'leaseMs' | 'approvalTtlMs' | 'eventSink'>>;

export function createRuntimeContext(input: RuntimeContextInput): RuntimeContext {
  return {
    ...input,
    clock: input.clock ?? systemClock,
    logger: input.logger ?? new JsonLogger({ base: { component: 'runtime' } }),
    redactor: input.redactor ?? defaultRedactor,
    policy: input.policy ?? new PolicyEngine(),
    memory: input.memory ?? new MemoryManager(),
    // Events default to the store, so history survives a process restart.
    eventSink: input.eventSink ?? { append: (events) => input.store.events.append(events) },
    leaseMs: input.leaseMs ?? 30_000,
    approvalTtlMs: input.approvalTtlMs === undefined ? 24 * 60 * 60 * 1_000 : input.approvalTtlMs,
  };
}
