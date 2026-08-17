import type { ModelUsage } from "@tulipfarm/agent-runtime";

/**
 * What a Trial or a Sweep consumed.
 *
 * `costUsd` is a floor, not a total, whenever `unpriced` is non-zero: a call nobody could price
 * contributed real money and zero dollars to this record. Reporting the two together is the only
 * honest way to say "this is what it cost, and this is how much of it we cannot see".
 */
export interface Spend {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  /** Model calls whose cost could not be established. */
  readonly unpriced: number;
  /** Model calls billed against a seat, which have a genuine zero marginal cost. */
  readonly subscription: number;
  readonly calls: number;
}

export const NO_SPEND: Spend = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  unpriced: 0,
  subscription: 0,
  calls: 0,
};

/**
 * Running total across model calls.
 *
 * Cache and reasoning counts are carried alongside the totals they are already inside, never
 * added to them. Adding a cached-input count to the input count double-charges exactly the calls
 * a well-cached harness makes most of.
 */
export function addSpend(total: Spend, usage: ModelUsage | undefined): Spend {
  if (usage === undefined) return total;
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.reasoningTokens ?? 0),
    costUsd: total.costUsd + (usage.costUsd ?? 0),
    unpriced: total.unpriced + (usage.costBasis === "unpriced" ? 1 : 0),
    subscription: total.subscription + (usage.costBasis === "subscription" ? 1 : 0),
    calls: total.calls + 1,
  };
}

export function mergeSpend(a: Spend, b: Spend): Spend {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: a.costUsd + b.costUsd,
    unpriced: a.unpriced + b.unpriced,
    subscription: a.subscription + b.subscription,
    calls: a.calls + b.calls,
  };
}
