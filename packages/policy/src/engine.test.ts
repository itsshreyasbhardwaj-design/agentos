import { DEFAULT_LIMITS, emptyUsage, type PermissionSpec } from '@agentos/core';
import { describe, expect, it } from 'vitest';
import { baselinePolicy, BASELINE_RULES } from './builtin.js';
import { checkPermissionGate, compilePermissionOverlay, PolicyEngine } from './engine.js';
import type { Policy, PolicyRequest } from './types.js';

const engine = new PolicyEngine();

function req(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    kind: 'tool_call',
    orgId: 'org_1',
    agentId: 'agt_1',
    agentSlug: 'researcher',
    agentLabels: {},
    executionId: 'exec_1',
    mode: 'live',
    usage: emptyUsage(),
    limits: DEFAULT_LIMITS,
    elapsedMs: 0,
    tool: { name: 'github.list_issues', operations: ['read'], destructive: false, domains: ['api.github.com'], arguments: {} },
    ...overrides,
  };
}

const perms: PermissionSpec = {
  allowedTools: ['github.*', 'http.request'],
  deniedTools: ['github.delete_repo'],
  allowedDomains: ['api.github.com'],
  allowedOperations: ['read', 'network'],
  requireApprovalFor: ['github.create_*'],
};

describe('default deny', () => {
  it('denies a tool that no rule allows', () => {
    const decision = engine.evaluate(req(), []);
    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBeNull();
  });

  it('denies a tool outside the allow list even when other tools are allowed', () => {
    const decision = engine.evaluateWithPermissions(
      req({ tool: { name: 'shell.exec', operations: ['exec'], destructive: true, domains: [], arguments: {} } }),
      perms,
      [],
    );
    expect(decision.effect).toBe('deny');
  });
});

describe('agent permissions', () => {
  it('allows a tool on the allow list', () => {
    expect(engine.evaluateWithPermissions(req(), perms, []).effect).toBe('allow');
  });

  it('lets the deny list beat the allow list', () => {
    const decision = engine.evaluateWithPermissions(
      req({ tool: { name: 'github.delete_repo', operations: ['delete'], destructive: true, domains: [], arguments: {} } }),
      perms,
      [],
    );
    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBe('agent.permissions:denied_tools');
  });

  it('requires approval for the configured globs', () => {
    const decision = engine.evaluateWithPermissions(
      req({ tool: { name: 'github.create_issue', operations: ['write'], destructive: false, domains: ['api.github.com'], arguments: {} } }),
      { ...perms, allowedOperations: ['read', 'write', 'network'] },
      [],
    );
    expect(decision.effect).toBe('require_approval');
  });

  it('denies operations outside allowedOperations even for an allowed tool', () => {
    const decision = engine.evaluateWithPermissions(
      req({ tool: { name: 'github.create_issue', operations: ['write'], destructive: false, domains: [], arguments: {} } }),
      perms,
      [],
    );
    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBe('agent.permissions:forbidden_operations');
  });
});

describe('network egress', () => {
  it('allows only listed hosts', () => {
    const allow = engine.evaluateWithPermissions(
      req({ kind: 'network', network: { host: 'api.github.com', method: 'GET' } }),
      perms,
      [],
    );
    expect(allow.effect).toBe('allow');

    const deny = engine.evaluateWithPermissions(
      req({ kind: 'network', network: { host: 'evil.example', method: 'POST' } }),
      perms,
      [],
    );
    expect(deny.effect).toBe('deny');
  });

  it('denies all egress when no domains are declared', () => {
    const decision = engine.evaluateWithPermissions(
      req({ kind: 'network', network: { host: 'api.github.com', method: 'GET' } }),
      { ...perms, allowedDomains: [] },
      [],
    );
    expect(decision.effect).toBe('deny');
  });
});

describe('baseline policies', () => {
  const policies: Policy[] = [baselinePolicy('org_1')];

  it('requires approval for destructive tools', () => {
    const decision = engine.evaluateWithPermissions(
      req({ tool: { name: 'github.merge_pr', operations: ['write'], destructive: true, domains: [], arguments: {} } }),
      { ...perms, allowedTools: ['github.*'], allowedOperations: ['read', 'write', 'network'] },
      policies,
    );
    expect(decision.effect).toBe('require_approval');
  });

  it('denies destructive tools in replay mode outright', () => {
    const decision = engine.evaluateWithPermissions(
      req({
        mode: 'replay',
        tool: { name: 'github.merge_pr', operations: ['write'], destructive: true, domains: [], arguments: {} },
      }),
      { ...perms, allowedTools: ['github.*'], allowedOperations: ['read', 'write', 'network'] },
      policies,
    );
    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBe('baseline:no_destructive_in_replay');
  });

  it('is disabled when the policy is disabled', () => {
    const disabled = policies.map((p) => ({ ...p, enabled: false }));
    const decision = engine.evaluateWithPermissions(
      req({ tool: { name: 'github.merge_pr', operations: ['write'], destructive: true, domains: [], arguments: {} } }),
      { ...perms, allowedTools: ['github.*'], allowedOperations: ['read', 'write', 'network'] },
      disabled,
    );
    expect(decision.effect).toBe('allow');
  });
});

describe('resolution order', () => {
  it('deny beats require_approval beats allow regardless of priority', () => {
    const decision = engine.evaluate(req(), [
      {
        source: 'test',
        rules: [
          { id: 'a', description: 'allow', effect: 'allow', priority: 9_999, match: {} },
          { id: 'b', description: 'approve', effect: 'require_approval', priority: 1, match: {} },
          { id: 'c', description: 'deny', effect: 'deny', priority: 0, match: {} },
        ],
      },
    ]);
    expect(decision.effect).toBe('deny');
    expect(decision.ruleId).toBe('c');
    expect(decision.matched).toHaveLength(3);
  });

  it('is deterministic for equal effect and priority', () => {
    const sources = [
      {
        source: 'test',
        rules: [
          { id: 'z', description: 'z', effect: 'deny' as const, priority: 5, match: {} },
          { id: 'a', description: 'a', effect: 'deny' as const, priority: 5, match: {} },
        ],
      },
    ];
    expect(engine.evaluate(req(), sources).ruleId).toBe('a');
    expect(engine.evaluate(req(), sources).ruleId).toBe('a');
  });
});

describe('cost-triggered rules', () => {
  it('matches only above the spend threshold', () => {
    const policy: Policy = {
      ...baselinePolicy('org_1'),
      id: 'pol_cost',
      name: 'cost-guard',
      rules: [
        {
          id: 'cost:approval',
          description: 'Spending past $0.10 needs approval',
          effect: 'require_approval',
          priority: 700,
          match: { subjects: ['tool_call'], minSpendMicroUsd: 100_000 },
        },
      ],
    };
    const cheap = engine.evaluateWithPermissions(req(), perms, [policy]);
    expect(cheap.effect).toBe('allow');

    const expensive = engine.evaluateWithPermissions(
      req({ usage: { ...emptyUsage(), costMicroUsd: 150_000 } }),
      perms,
      [policy],
    );
    expect(expensive.effect).toBe('require_approval');
  });
});

describe('permission gate', () => {
  it('refuses anything when the allow list is empty', () => {
    const gate = checkPermissionGate(req(), { allowedTools: [] });
    expect(gate?.effect).toBe('deny');
    expect(gate?.ruleId).toBe('agent.permissions:not_allowed');
  });

  it('cannot be overridden by an allow rule in a policy', () => {
    const permissive: Policy = {
      ...baselinePolicy('org_1'),
      id: 'pol_x',
      name: 'too-permissive',
      rules: [{ id: 'x:allow_all', description: 'allow everything', effect: 'allow', priority: 99_999, match: {} }],
    };
    const decision = engine.evaluateWithPermissions(
      req({ tool: { name: 'shell.exec', operations: ['exec'], destructive: true, domains: [], arguments: {} } }),
      perms,
      [permissive],
    );
    expect(decision.effect).toBe('deny');
  });

  it('emits an approval overlay rule only when configured', () => {
    expect(compilePermissionOverlay({ allowedTools: ['*'] })).toHaveLength(0);
    expect(compilePermissionOverlay({ allowedTools: ['*'], requireApprovalFor: ['a.*'] })).toHaveLength(1);
  });
  it('ships five baseline rules', () => {
    expect(BASELINE_RULES).toHaveLength(5);
  });
});
