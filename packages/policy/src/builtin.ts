import type { Policy, PolicyRule } from './types.js';

/**
 * Safety rules that ship enabled by default. They are ordinary policies, so an
 * operator can inspect, tighten or (deliberately) disable them.
 */
export const BASELINE_RULES: PolicyRule[] = [
  {
    id: 'baseline:destructive_requires_approval',
    description: 'Destructive tools require human approval',
    effect: 'require_approval',
    priority: 500,
    match: { subjects: ['tool_call'], destructive: true },
  },
  {
    id: 'baseline:delete_requires_approval',
    description: 'Delete operations require human approval',
    effect: 'require_approval',
    priority: 500,
    match: { subjects: ['tool_call'], operations: ['delete'] },
  },
  {
    id: 'baseline:exec_denied',
    description: 'Arbitrary code execution is denied unless a policy explicitly allows it',
    effect: 'deny',
    priority: 600,
    match: { subjects: ['tool_call'], operations: ['exec'] },
  },
  {
    id: 'baseline:no_destructive_in_replay',
    description: 'Destructive tools never execute during a replay',
    effect: 'deny',
    priority: 2_000,
    match: { subjects: ['tool_call'], destructive: true, modes: ['replay'] },
  },
  {
    id: 'baseline:no_writes_in_replay',
    description: 'Write and delete operations never execute during a replay',
    effect: 'deny',
    priority: 2_000,
    match: { subjects: ['tool_call'], operations: ['write', 'delete'], modes: ['replay'] },
  },
];

export function baselinePolicy(orgId: string, now = Date.now()): Policy {
  return {
    id: 'pol_baseline',
    orgId,
    name: 'baseline-safety',
    description: 'Default AgentOS safety rules: approval for destructive actions, no side effects on replay.',
    enabled: true,
    scope: 'org',
    rules: BASELINE_RULES,
    createdAt: now,
    updatedAt: now,
  };
}
