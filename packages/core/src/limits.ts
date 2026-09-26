import type { MicroUsd, UsageTotals } from './usage.js';

export interface LimitSpec {
  maxSteps: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxTokens: number;
  maxCostMicroUsd: MicroUsd;
  maxDurationMs: number;
  /** What to do when a limit is hit: stop cleanly, or pause for a human. */
  onExceeded: 'terminate' | 'pause';
}

export const DEFAULT_LIMITS: LimitSpec = {
  maxSteps: 16,
  maxModelCalls: 24,
  maxToolCalls: 48,
  maxTokens: 200_000,
  maxCostMicroUsd: 500_000, // $0.50
  maxDurationMs: 300_000,
  onExceeded: 'terminate',
};

export type LimitName =
  | 'maxSteps'
  | 'maxModelCalls'
  | 'maxToolCalls'
  | 'maxTokens'
  | 'maxCostMicroUsd'
  | 'maxDurationMs';

export interface LimitBreach {
  limit: LimitName;
  configured: number;
  observed: number;
}

/**
 * Check limits against observed usage. `projected` lets a caller ask "would this
 * next call breach?" before spending anything.
 */
export function checkLimits(
  spec: LimitSpec,
  usage: UsageTotals,
  elapsedMs: number,
  projected: Partial<Pick<UsageTotals, 'costMicroUsd' | 'totalTokens' | 'modelCalls' | 'toolCalls' | 'steps'>> = {},
): LimitBreach | null {
  const checks: Array<[LimitName, number, number]> = [
    ['maxSteps', spec.maxSteps, usage.steps + (projected.steps ?? 0)],
    ['maxModelCalls', spec.maxModelCalls, usage.modelCalls + (projected.modelCalls ?? 0)],
    ['maxToolCalls', spec.maxToolCalls, usage.toolCalls + (projected.toolCalls ?? 0)],
    ['maxTokens', spec.maxTokens, usage.totalTokens + (projected.totalTokens ?? 0)],
    ['maxCostMicroUsd', spec.maxCostMicroUsd, usage.costMicroUsd + (projected.costMicroUsd ?? 0)],
    ['maxDurationMs', spec.maxDurationMs, elapsedMs],
  ];
  for (const [limit, configured, observed] of checks) {
    if (configured >= 0 && observed > configured) {
      return { limit, configured, observed };
    }
  }
  return null;
}

export function mergeLimits(base: LimitSpec, override?: Partial<LimitSpec>): LimitSpec {
  return { ...base, ...(override ?? {}) };
}

/** An org ceiling always wins over a looser per-agent value. */
export function clampLimits(spec: LimitSpec, ceiling: Partial<LimitSpec>): LimitSpec {
  const out = { ...spec };
  for (const key of [
    'maxSteps',
    'maxModelCalls',
    'maxToolCalls',
    'maxTokens',
    'maxCostMicroUsd',
    'maxDurationMs',
  ] as const) {
    const cap = ceiling[key];
    if (typeof cap === 'number' && cap >= 0 && (out[key] < 0 || out[key] > cap)) {
      out[key] = cap;
    }
  }
  return out;
}
