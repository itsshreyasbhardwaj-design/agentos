import { anyGlobMatch, err, type AgentSpec } from '@agentos/core';
import type { ToolRegistry } from '@agentos/tools';

/**
 * Reject agent definitions that cannot be run safely, at authoring time rather
 * than three steps into an execution.
 */
export function validateAgentSpec(spec: AgentSpec, registry: ToolRegistry): void {
  if (!spec.model?.primary) throw err.invalid('spec.model.primary is required');
  if (!spec.instructions || spec.instructions.trim().length === 0) {
    throw err.invalid('spec.instructions must not be empty');
  }

  const allowed = spec.permissions?.allowedTools ?? [];
  const known = registry.list().map((t) => t.name);

  // A glob that matches nothing is almost always a typo that would otherwise
  // surface as a silent "the agent never uses that tool".
  for (const pattern of allowed) {
    if (!known.some((name) => anyGlobMatch([pattern], name))) {
      throw err.invalid(`permissions.allowedTools entry '${pattern}' matches no registered tool`, {
        registered: known,
      });
    }
  }

  const needsNetwork = registry
    .forAgent(allowed, spec.permissions?.deniedTools ?? [])
    .some((t) => t.operations.includes('network'));
  if (needsNetwork && (spec.permissions?.allowedDomains ?? []).length === 0) {
    throw err.invalid(
      'this agent has network-capable tools but no permissions.allowedDomains; ' +
        'add the hosts it may reach, or remove the tools',
    );
  }

  const ops = spec.permissions?.allowedOperations ?? [];
  if (ops.length === 0 && allowed.length > 0) {
    throw err.invalid('permissions.allowedOperations must list at least one operation when tools are allowed');
  }

  if (spec.limits) {
    for (const [key, value] of Object.entries(spec.limits)) {
      if (typeof value === 'number' && value < 0 && value !== -1) {
        throw err.invalid(`limits.${key} must be >= 0 (or -1 for unlimited)`);
      }
    }
    if (spec.limits.maxSteps === 0) throw err.invalid('limits.maxSteps must be at least 1');
  }

  if (spec.memory && spec.memory.scopes.length === 0) {
    throw err.invalid('memory.scopes must list at least one scope when memory is configured');
  }
}
