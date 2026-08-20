import type { CostBasis } from "@tulipfarm/llm";
import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import { tokenDetail, UsageAccumulator } from "./usage";

const usage = (u: Partial<LanguageModelUsage>): LanguageModelUsage =>
  ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, ...u }) as LanguageModelUsage;

const priced = (tokensIn: number, tokensOut: number): CostBasis => ({
  kind: "priced",
  costUsd: (tokensIn + tokensOut) / 1_000,
  source: "table",
});

describe("tokenDetail", () => {
  it("drops zeros so a provider that reports none of this stores no empty keys", () => {
    expect(tokenDetail(usage({ inputTokens: 10 }))).toEqual({});
  });

  it("reports the cache and reasoning splits a provider does send", () => {
    const detail = tokenDetail(
      usage({
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4, noCacheTokens: 1 },
        outputTokenDetails: { reasoningTokens: 5, textTokens: 10 },
      })
    );

    expect(detail).toEqual({ cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 });
  });
});

describe("UsageAccumulator", () => {
  it("reports nothing when a call consumed nothing, keeping it out of the spend ledger", () => {
    expect(new UsageAccumulator().settle(priced)).toBeUndefined();
  });

  it("charges what a mid-stream failure had already consumed", () => {
    const acc = new UsageAccumulator();
    acc.add(usage({ inputTokens: 100, outputTokens: 20 }));
    acc.add(usage({ inputTokens: 0, outputTokens: 30 }));

    expect(acc.settle(priced)).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.15,
      costBasis: "priced",
    });
  });

  it("prices an attached image on the provider's own input count, inventing no separate total", () => {
    // Every provider folds image tokens into `inputTokens` and bills them at the input rate, and
    // the SDK exposes no image breakdown. Estimating one here would be a guess, and adding it to
    // the total would charge the same tokens twice — a detail is a breakdown, never an addend.
    const textOnly = new UsageAccumulator();
    textOnly.add(usage({ inputTokens: 40, outputTokens: 10 }));
    const withImage = new UsageAccumulator();
    withImage.add(usage({ inputTokens: 1_640, outputTokens: 10 }));

    const text = textOnly.settle(priced);
    const image = withImage.settle(priced);

    expect(image?.inputTokens).toBe(1_640);
    expect(image?.costUsd).toBeGreaterThan(text?.costUsd ?? 0);
    expect(image).not.toHaveProperty("imageTokens");
  });

  it("keeps cache reads as a breakdown of the input total rather than an addition to it", () => {
    const acc = new UsageAccumulator();
    acc.add(
      usage({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 90, cacheWriteTokens: 0, noCacheTokens: 10 },
      })
    );
    acc.add(usage({ outputTokens: 5 }));

    expect(acc.settle(priced)).toMatchObject({ inputTokens: 100, cacheReadTokens: 90 });
  });
});
