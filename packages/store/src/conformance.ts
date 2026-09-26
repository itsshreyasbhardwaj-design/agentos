import {
  DEFAULT_LIMITS,
  emptyExecutionState,
  emptyUsage,
  newId,
  type AgentRecord,
  type AgentSpec,
  type ApprovalRecord,
  type ExecutionRecord,
  type Org,
  type TaskRecord,
  type User,
} from '@agentos/core';
import type { AnyEvent } from '@agentos/events';

export const ORG_A = 'org_aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const ORG_B = 'org_bbbbbbbbbbbbbbbbbbbbbbbbbb';

export function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    model: { primary: 'scripted:test' },
    instructions: 'be useful',
    tools: ['math.evaluate'],
    permissions: { allowedTools: ['math.evaluate'], allowedOperations: ['read'] },
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

export function org(id = ORG_A, slug = 'acme'): Org {
  return { id, name: 'Acme', slug, createdAt: 1_000 };
}

export function user(id = 'usr_1', email = 'a@example.com'): User {
  return { id, email, name: 'Ada', createdAt: 1_000 };
}

export function agent(orgId = ORG_A, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: newId('agent'),
    orgId,
    slug: 'researcher',
    name: 'Researcher',
    description: 'Finds things out',
    draft: spec(),
    publishedVersionId: null,
    latestVersionNumber: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    createdBy: 'usr_1',
    archived: false,
    labels: {},
    ...overrides,
  };
}

export function execution(orgId: string, agentId: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: newId('execution'),
    orgId,
    agentId,
    agentVersionId: 'ver_1',
    versionNumber: 1,
    status: 'queued',
    mode: 'live',
    replayOfExecutionId: null,
    parentExecutionId: null,
    taskId: null,
    trigger: { type: 'api' },
    userId: 'usr_1',
    input: { question: 'hello' },
    output: null,
    error: null,
    state: emptyExecutionState(),
    usage: emptyUsage(),
    createdAt: 2_000,
    startedAt: null,
    updatedAt: 2_000,
    finishedAt: null,
    lease: null,
    attempt: 0,
    idempotencyKey: null,
    labels: {},
    ...overrides,
  };
}

export function approval(orgId: string, executionId: string, agentId: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: newId('approval'),
    orgId,
    executionId,
    agentId,
    toolCall: { id: 'tc_1', name: 'http.delete', arguments: { url: 'https://api.example.com/x' } },
    reason: 'destructive tool',
    ruleId: 'baseline:destructive_requires_approval',
    impact: 'DELETE https://api.example.com/x',
    operations: ['delete', 'network'],
    destructive: true,
    status: 'pending',
    requestedAt: 3_000,
    expiresAt: null,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    editedArguments: null,
    ...overrides,
  };
}

export function task(orgId: string, agentId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: newId('task'),
    orgId,
    agentId,
    parentTaskId: null,
    title: 'Research topic',
    status: 'created',
    input: {},
    output: null,
    error: null,
    dependsOn: [],
    executionId: null,
    createdAt: 1_500,
    updatedAt: 1_500,
    finishedAt: null,
    createdBy: 'usr_1',
    labels: {},
    ...overrides,
  };
}

export function event(orgId: string, executionId: string, seq: number, overrides: Partial<AnyEvent> = {}): AnyEvent {
  return {
    id: newId('event'),
    orgId,
    seq,
    type: 'execution.started',
    at: 2_000 + seq,
    executionId,
    agentId: 'agt_1',
    taskId: null,
    traceId: 'trace_1',
    spanId: null,
    parentSpanId: null,
    durationMs: null,
    payload: { workerId: 'w1', attempt: 1 },
    ...overrides,
  } as AnyEvent;
}
