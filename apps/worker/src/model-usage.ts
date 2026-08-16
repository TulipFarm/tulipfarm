import type { ModelUsage } from "@tulipfarm/agent-runtime";
import type { CostBasis } from "@tulipfarm/llm";
import type { LanguageModelUsage } from "ai";

/** Token accounting for a streaming model call, including the mid-stream failure path. */

/**
 * Cache and reasoning splits.
 *
 * Zeros are dropped alongside absent values: providers that support none of this still report
 * `0`, and carrying that into every record would bloat the stored attributes without saying
 * anything a missing key does not already say.
 */
export function tokenDetail(usage: LanguageModelUsage): Partial<ModelUsage> {
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
  return {
    ...(cacheReadTokens === 0 ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === 0 ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === 0 ? {} : { reasoningTokens }),
  };
}

/**
 * Running total of what a streaming call has consumed so far.
 *
 * Exists for the failure path. Usage was only ever read from the terminal chunk, which a call
 * that dies mid-stream never reaches — so every mid-stream failure was charged zero while the
 * provider billed for the submitted prompt and the partial output that had already been
 * streamed to, and durably stored for, the participant.
 */
export class UsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private reasoningTokens = 0;

  add(usage: LanguageModelUsage): void {
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
    this.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    this.reasoningTokens += usage.outputTokenDetails?.reasoningTokens ?? 0;
  }

  /**
   * Prices what was consumed, or reports nothing when no tokens were.
   *
   * The SDK synthesises a zero-usage step for a call that failed before the provider answered,
   * so "reported something" is not a usable test. Zero tokens is nothing to charge on either
   * reading, and reporting absence keeps a meaningless record out of the spend ledger.
   */
  settle(price: (tokensIn: number, tokensOut: number) => CostBasis): ModelUsage | undefined {
    if (this.inputTokens === 0 && this.outputTokens === 0) return undefined;
    const cost = price(this.inputTokens, this.outputTokens);
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.cacheReadTokens === 0 ? {} : { cacheReadTokens: this.cacheReadTokens }),
      ...(this.cacheWriteTokens === 0 ? {} : { cacheWriteTokens: this.cacheWriteTokens }),
      ...(this.reasoningTokens === 0 ? {} : { reasoningTokens: this.reasoningTokens }),
      ...(cost.kind === "priced" ? { costUsd: cost.costUsd } : {}),
      costBasis: cost.kind,
    };
  }
}
