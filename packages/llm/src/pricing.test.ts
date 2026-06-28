import { describe, expect, it } from "vitest";
import { priceFor } from "./pricing";

describe("priceFor", () => {
  it("prices a known model from input/output token counts", () => {
    // claude-opus-4-8 = $15/Mtok in, $75/Mtok out
    const { costUsd } = priceFor("claude-opus-4-8", 1_000_000, 1_000_000);
    expect(costUsd).toBe(90);
  });

  it("scales sub-million token counts", () => {
    // 10k in @ $3/M + 2k out @ $15/M = 0.03 + 0.03 = 0.06
    const { costUsd } = priceFor("claude-sonnet-4-6", 10_000, 2_000);
    expect(costUsd).toBeCloseTo(0.06, 6);
  });

  it("matches a dated provider id to its family prefix", () => {
    const { costUsd } = priceFor("claude-opus-4-20250901", 1_000_000, 0);
    expect(costUsd).toBe(15);
  });

  it("returns null cost for an unknown model (unpriced)", () => {
    expect(priceFor("some-unlisted-model", 1000, 1000).costUsd).toBeNull();
  });

  it("returns null cost for a missing model id", () => {
    expect(priceFor(null, 1000, 1000).costUsd).toBeNull();
    expect(priceFor(undefined, 1000, 1000).costUsd).toBeNull();
  });

  it("prefers an explicit override over the built-in map", () => {
    const { costUsd } = priceFor("claude-opus-4-8", 1_000_000, 0, {
      "claude-opus-4-8": { in: 1, out: 1 },
    });
    expect(costUsd).toBe(1);
  });

  it("prices a model only present in the extra map, prefix-tolerant", () => {
    const extra = { "gpt-5.4": { in: 2, out: 8 } };
    expect(priceFor("gpt-5.4", 1_000_000, 0, extra).costUsd).toBe(2);
    // dated/suffixed served id still matches the family prefix in the extra map
    expect(priceFor("gpt-5.4-2026-06-01", 1_000_000, 0, extra).costUsd).toBe(2);
  });
});
