import type { ModelUsage } from "@tulipfarm/agent-runtime";
import { describe, expect, it } from "vitest";
import { addSpend, mergeSpend, NO_SPEND } from "./spend.ts";

const usage = (overrides: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 1000,
  outputTokens: 200,
  costUsd: 0.006,
  costBasis: "priced",
  ...overrides,
});

describe("addSpend", () => {
  it("carries cache and reasoning counts beside the totals they are already inside", () => {
    // These are a breakdown of the input and output counts, never an addend. Adding them
    // double-charges exactly the calls a well-cached harness makes most of.
    const total = addSpend(NO_SPEND, usage({ cacheReadTokens: 800, reasoningTokens: 50 }));

    expect(total).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 800,
      reasoningTokens: 50,
    });
  });

  it("counts a call nobody could price rather than charging it zero", () => {
    // `unpriced` and `subscription` are different facts. A seat genuinely costs nothing at the
    // margin; an unpriceable call costs an unknown amount, and folding it into zero is how a
    // Sweep runs past a ceiling while reporting it had budget left.
    const total = addSpend(NO_SPEND, { inputTokens: 10, outputTokens: 2, costBasis: "unpriced" });

    expect(total).toMatchObject({ costUsd: 0, unpriced: 1, subscription: 0, calls: 1 });
  });

  it("ignores a call that reported no usage at all", () => {
    expect(addSpend(NO_SPEND, undefined)).toEqual(NO_SPEND);
  });
});

describe("mergeSpend", () => {
  it("sums every field so a Sweep total is the sum of its Trials", () => {
    const one = addSpend(NO_SPEND, usage({ cacheReadTokens: 100 }));

    expect(mergeSpend(one, one)).toMatchObject({
      inputTokens: 2000,
      outputTokens: 400,
      cacheReadTokens: 200,
      costUsd: 0.012,
      calls: 2,
    });
  });
});
