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

/**
 * The two limits a Sweep can be bounded by.
 *
 * Narrower than `SweepOptions` on purpose: a ceiling is a question about spend, so it belongs to
 * the module that owns spend. Taking the whole options object here would make this module depend
 * on the runner it is meant to serve.
 */
export interface Ceiling {
  readonly maxSpendUsd?: number;
  readonly maxTokens?: number;
}

/**
 * Whether the Sweep has run out of budget, checked before launching rather than after.
 *
 * Cost is only knowable once a call has been made, so no ceiling can be exact. Checking at the
 * Trial boundary bounds the overrun to one Trial instead of to the whole remaining Corpus.
 */
export function ceilingReached(
  spend: Spend,
  ceiling: Ceiling,
  done: number,
  planned: number
): string | undefined {
  const suffix = `after ${done} of ${planned} Trials`;
  if (ceiling.maxSpendUsd !== undefined && spend.costUsd >= ceiling.maxSpendUsd) {
    return `spend ceiling reached: $${spend.costUsd.toFixed(4)} of $${ceiling.maxSpendUsd} ${suffix}`;
  }
  // A dollar ceiling cannot bound a total it is known to understate. Continuing would let the
  // Sweep run to the end of the Corpus while reporting it had budget left.
  if (ceiling.maxSpendUsd !== undefined && ceiling.maxTokens === undefined && spend.unpriced > 0) {
    return `${spend.unpriced} call(s) could not be priced, so a dollar ceiling cannot bound this Sweep — pass --max-tokens ${suffix}`;
  }
  const tokens = spend.inputTokens + spend.outputTokens;
  if (ceiling.maxTokens !== undefined && tokens >= ceiling.maxTokens) {
    return `token ceiling reached: ${tokens} of ${ceiling.maxTokens} tokens ${suffix}`;
  }
  return undefined;
}
