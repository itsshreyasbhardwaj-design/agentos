import type { ExecutionMode, JsonObject, LimitSpec, ToolOperation, UsageTotals } from '@agentos/core';

export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export type PolicySubject = 'tool_call' | 'model_call' | 'network' | 'delegate' | 'memory';

export interface PolicyMatch {
  /** Request kinds this rule applies to. Omitted means every kind. */
  subjects?: PolicySubject[];
  /** Tool-name globs. */
  tools?: string[];
  /** Model ids or globs, e.g. `openrouter:*`. */
  models?: string[];
  /** Host patterns; `*.example.com` does not match the apex. */
  domains?: string[];
  operations?: ToolOperation[];
  /** Agent ids or slugs. */
  agents?: string[];
  /** Match only destructive (or only non-destructive) tools. */
  destructive?: boolean;
  /** Match only when the projected cost of the action is at least this much. */
  minCostMicroUsd?: number;
  /** Match only when total spend so far is at least this much. */
  minSpendMicroUsd?: number;
  modes?: ExecutionMode[];
  /** All listed labels must be present on the agent with the given value. */
  labels?: Record<string, string>;
}

export interface PolicyRule {
  id: string;
  description: string;
  effect: PolicyEffect;
  /** Higher priority wins among rules with the same effect. */
  priority: number;
  match: PolicyMatch;
}

export interface Policy {
  id: string;
  orgId: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Org-wide policies apply to every agent; otherwise attach by id. */
  scope: 'org' | 'agent';
  rules: PolicyRule[];
  createdAt: number;
  updatedAt: number;
}

export interface ToolRequestFacts {
  name: string;
  operations: ToolOperation[];
  destructive: boolean;
  /** Hosts this specific call will contact, already extracted from arguments. */
  domains: string[];
  arguments: JsonObject;
}

export interface ModelRequestFacts {
  provider: string;
  model: string;
  estimatedCostMicroUsd: number;
}

export interface PolicyRequest {
  kind: PolicySubject;
  orgId: string;
  agentId: string;
  agentSlug: string;
  agentLabels: Record<string, string>;
  executionId: string;
  mode: ExecutionMode;
  usage: UsageTotals;
  limits: LimitSpec;
  elapsedMs: number;
  tool?: ToolRequestFacts;
  model?: ModelRequestFacts;
  network?: { host: string; method: string };
  delegate?: { toAgentSlug: string };
  memory?: { scope: string; namespace: string; operation: 'read' | 'write' };
}

export interface MatchedRule {
  rule: PolicyRule;
  source: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** The rule that decided the outcome, or null for the default decision. */
  ruleId: string | null;
  source: string;
  reason: string;
  /** Every rule that matched, for the "why" panel in the dashboard. */
  matched: MatchedRule[];
}
