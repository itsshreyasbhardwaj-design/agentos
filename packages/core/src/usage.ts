/**
 * Money is tracked as integer micro-USD (1e-6 USD) so that summing thousands of
 * per-call costs never drifts the way float dollars do.
 */
export type MicroUsd = number;

export const USD = (dollars: number): MicroUsd => Math.round(dollars * 1_000_000);
export const toDollars = (micro: MicroUsd): number => micro / 1_000_000;
export const formatUsd = (micro: MicroUsd): string => `$${(micro / 1_000_000).toFixed(6)}`;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface UsageTotals {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicroUsd: MicroUsd;
  retries: number;
  approvals: number;
  steps: number;
}

export function emptyUsage(): UsageTotals {
  return {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costMicroUsd: 0,
    retries: 0,
    approvals: 0,
    steps: 0,
  };
}

export function addUsage(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    modelCalls: a.modelCalls + (b.modelCalls ?? 0),
    toolCalls: a.toolCalls + (b.toolCalls ?? 0),
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
    costMicroUsd: a.costMicroUsd + (b.costMicroUsd ?? 0),
    retries: a.retries + (b.retries ?? 0),
    approvals: a.approvals + (b.approvals ?? 0),
    steps: a.steps + (b.steps ?? 0),
  };
}
