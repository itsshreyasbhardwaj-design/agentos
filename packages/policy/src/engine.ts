import {
  anyGlobMatch,
  anyHostMatch,
  EMPTY_PERMISSIONS,
  globMatch,
  type PermissionSpec,
  type ToolOperation,
} from '@agentos/core';
import type {
  MatchedRule,
  Policy,
  PolicyDecision,
  PolicyEffect,
  PolicyRequest,
  PolicyRule,
} from './types.js';

const EFFECT_RANK: Record<PolicyEffect, number> = { allow: 0, require_approval: 1, deny: 2 };

const ALL_OPERATIONS: ToolOperation[] = ['read', 'write', 'delete', 'network', 'exec'];

function ruleMatches(rule: PolicyRule, req: PolicyRequest): boolean {
  const m = rule.match;
  if (m.subjects && !m.subjects.includes(req.kind)) return false;
  if (m.modes && !m.modes.includes(req.mode)) return false;
  if (m.agents && !m.agents.some((a) => a === req.agentId || globMatch(a, req.agentSlug))) return false;

  if (m.labels) {
    for (const [k, v] of Object.entries(m.labels)) {
      if (req.agentLabels[k] !== v) return false;
    }
  }

  if (m.tools) {
    if (!req.tool) return false;
    if (!anyGlobMatch(m.tools, req.tool.name)) return false;
  }

  if (m.operations) {
    if (!req.tool) return false;
    if (!req.tool.operations.some((op) => m.operations?.includes(op))) return false;
  }

  if (m.destructive !== undefined) {
    if (!req.tool) return false;
    if (req.tool.destructive !== m.destructive) return false;
  }

  if (m.domains) {
    const hosts = req.network ? [req.network.host] : (req.tool?.domains ?? []);
    if (hosts.length === 0) return false;
    if (!hosts.some((h) => anyHostMatch(m.domains as string[], h))) return false;
  }

  if (m.models) {
    if (!req.model) return false;
    const qualified = `${req.model.provider}:${req.model.model}`;
    if (!anyGlobMatch(m.models, qualified) && !anyGlobMatch(m.models, req.model.model)) return false;
  }

  if (m.minCostMicroUsd !== undefined && (req.model?.estimatedCostMicroUsd ?? 0) < m.minCostMicroUsd) return false;
  if (m.minSpendMicroUsd !== undefined && req.usage.costMicroUsd < m.minSpendMicroUsd) return false;

  return true;
}

function denial(ruleId: string, reason: string): PolicyDecision {
  return { effect: 'deny', ruleId, source: 'agent.permissions', reason, matched: [] };
}

export interface PermissionGateOptions {
  /** Agent slugs this agent may delegate to. Empty means no delegation. */
  delegatesTo?: string[];
}

/**
 * Least-privilege gate. This runs *before* the policy rule contest and cannot be
 * overridden by any rule: an action outside the agent's declared permissions is
 * refused, full stop. A policy can only ever narrow what gets through here.
 */
export function checkPermissionGate(
  request: PolicyRequest,
  permissions: PermissionSpec,
  options: PermissionGateOptions = {},
): PolicyDecision | null {
  const p = { ...EMPTY_PERMISSIONS, ...permissions };

  if (request.kind === 'tool_call') {
    const tool = request.tool;
    if (!tool) return denial('agent.permissions:missing_tool_facts', 'tool call had no tool facts to evaluate');

    if (anyGlobMatch(p.deniedTools ?? [], tool.name)) {
      return denial('agent.permissions:denied_tools', `tool ${tool.name} is on the agent deny list`);
    }
    if (!anyGlobMatch(p.allowedTools, tool.name)) {
      return denial('agent.permissions:not_allowed', `tool ${tool.name} is not in the agent allow list`);
    }
    const allowedOps = p.allowedOperations ?? [];
    if (allowedOps.length > 0) {
      const forbidden = tool.operations.filter((op) => !allowedOps.includes(op));
      if (forbidden.length > 0) {
        return denial(
          'agent.permissions:forbidden_operations',
          `operation(s) ${forbidden.join(', ')} not permitted (allowed: ${allowedOps.join(', ') || 'none'})`,
        );
      }
    } else if (tool.operations.some((op) => ALL_OPERATIONS.includes(op))) {
      return denial(
        'agent.permissions:forbidden_operations',
        'agent declares no allowed operations, so no tool may run',
      );
    }
    // Any host the call would contact must itself be permitted.
    const hosts = tool.domains ?? [];
    if (hosts.length > 0) {
      const blocked = hosts.filter((h) => !anyHostMatch(p.allowedDomains ?? [], h));
      if (blocked.length > 0) {
        return denial(
          'agent.permissions:domain_not_allowed',
          `host(s) ${blocked.join(', ')} are not in the agent domain allow list`,
        );
      }
    }
    return null;
  }

  if (request.kind === 'network') {
    const host = request.network?.host ?? '';
    if (!anyHostMatch(p.allowedDomains ?? [], host)) {
      return denial('agent.permissions:domain_not_allowed', `host ${host} is not in the agent domain allow list`);
    }
    return null;
  }

  if (request.kind === 'delegate') {
    const target = request.delegate?.toAgentSlug ?? '';
    if (!anyGlobMatch(options.delegatesTo ?? [], target)) {
      return denial('agent.permissions:delegate_not_allowed', `agent may not delegate to ${target}`);
    }
    return null;
  }

  return null;
}

/** Rules derived from permissions that participate in the contest (not gates). */
export function compilePermissionOverlay(permissions: PermissionSpec, source = 'agent.permissions'): PolicyRule[] {
  const approvalGlobs = permissions.requireApprovalFor ?? [];
  if (approvalGlobs.length === 0) return [];
  return [
    {
      id: `${source}:require_approval`,
      description: 'Tool requires human approval for this agent',
      effect: 'require_approval',
      priority: 800,
      match: { subjects: ['tool_call'], tools: approvalGlobs },
    },
  ];
}

export interface PolicyEngineOptions {
  defaultEffect?: Partial<Record<PolicyRequest['kind'], PolicyEffect>>;
}

const DEFAULT_EFFECTS: Record<PolicyRequest['kind'], PolicyEffect> = {
  tool_call: 'deny',
  network: 'deny',
  model_call: 'allow',
  delegate: 'deny',
  memory: 'allow',
};

/**
 * Deterministic policy evaluation. Resolution is total and repeatable:
 *   1. the permission gate (allow-lists) must pass, or the answer is deny
 *   2. among matching rules, strongest effect wins (deny > approval > allow)
 *   3. within an effect, highest priority wins
 *   4. ties break on rule id.
 */
export class PolicyEngine {
  private readonly defaults: Record<PolicyRequest['kind'], PolicyEffect>;

  constructor(options: PolicyEngineOptions = {}) {
    this.defaults = { ...DEFAULT_EFFECTS, ...(options.defaultEffect ?? {}) };
  }

  evaluate(
    request: PolicyRequest,
    sources: Array<{ source: string; rules: PolicyRule[] }>,
    defaultEffect?: PolicyEffect,
  ): PolicyDecision {
    const matched: MatchedRule[] = [];
    for (const { source, rules } of sources) {
      for (const rule of rules) {
        if (ruleMatches(rule, request)) matched.push({ rule, source });
      }
    }

    if (matched.length === 0) {
      const effect = defaultEffect ?? this.defaults[request.kind];
      return {
        effect,
        ruleId: null,
        source: 'default',
        reason:
          effect === 'deny'
            ? `no policy allows this ${request.kind.replace('_', ' ')}`
            : `default ${effect} for ${request.kind}`,
        matched: [],
      };
    }

    const winner = [...matched].sort((a, b) => {
      const byEffect = EFFECT_RANK[b.rule.effect] - EFFECT_RANK[a.rule.effect];
      if (byEffect !== 0) return byEffect;
      const byPriority = b.rule.priority - a.rule.priority;
      if (byPriority !== 0) return byPriority;
      return a.rule.id.localeCompare(b.rule.id);
    })[0];

    if (!winner) {
      return {
        effect: defaultEffect ?? this.defaults[request.kind],
        ruleId: null,
        source: 'default',
        reason: 'no rule matched',
        matched,
      };
    }

    return {
      effect: winner.rule.effect,
      ruleId: winner.rule.id,
      source: winner.source,
      reason: winner.rule.description,
      matched,
    };
  }

  /**
   * Full evaluation: permission gate first, then the rule contest. Once the gate
   * passes, the action is permitted unless a rule narrows it, so the default
   * effect here is `allow`.
   */
  evaluateWithPermissions(
    request: PolicyRequest,
    permissions: PermissionSpec,
    policies: Policy[],
    options: PermissionGateOptions = {},
  ): PolicyDecision {
    const gate = checkPermissionGate(request, permissions, options);
    if (gate) return gate;

    const sources: Array<{ source: string; rules: PolicyRule[] }> = [
      { source: 'agent.permissions', rules: compilePermissionOverlay(permissions) },
    ];
    for (const policy of policies) {
      if (!policy.enabled) continue;
      sources.push({ source: `policy:${policy.name}`, rules: policy.rules });
    }
    return this.evaluate(request, sources, 'allow');
  }
}
