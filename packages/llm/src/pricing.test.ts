import { describe, expect, it } from "vitest";
import { type CostBasis, isPriceable, priceCall } from "./pricing";

/** The published-price path: an ordinary metered API provider. */
function meteredCall(modelId: string | null | undefined, tokensIn: number, tokensOut: number) {
  return priceCall({ provider: "anthropic", modelId, tokensIn, tokensOut });
}

function costOf(basis: CostBasis): number | null {
  return basis.kind === "priced" ? basis.costUsd : null;
}

describe("priceCall", () => {
  it("prices a known model from input/output token counts", () => {
    // claude-opus-4-8 = $15/Mtok in, $75/Mtok out
    expect(costOf(meteredCall("claude-opus-4-8", 1_000_000, 1_000_000))).toBe(90);
  });

  it("scales sub-million token counts", () => {
    // 10k in @ $3/M + 2k out @ $15/M = 0.03 + 0.03 = 0.06
    expect(costOf(meteredCall("claude-sonnet-4-6", 10_000, 2_000))).toBeCloseTo(0.06, 6);
  });

  it("matches a dated provider id to its family prefix", () => {
    expect(costOf(meteredCall("claude-opus-4-20250901", 1_000_000, 0))).toBe(15);
  });

  it("reports an unknown model as unpriced rather than as free", () => {
    const basis = meteredCall("some-unlisted-model", 1000, 1000);
    expect(basis.kind).toBe("unpriced");
    expect(costOf(basis)).toBeNull();
  });

  it("reports a missing model id as unpriced", () => {
    expect(meteredCall(null, 1000, 1000).kind).toBe("unpriced");
    expect(meteredCall(undefined, 1000, 1000).kind).toBe("unpriced");
  });

  it("names the authority a price came from", () => {
    const basis = meteredCall("claude-opus-4-8", 1_000_000, 0);
    expect(basis).toMatchObject({ kind: "priced", source: "table" });
  });
});

describe("priceCall authority order", () => {
  const spec = { input_cost_per_token: 0.00001, output_cost_per_token: 0.00002 };

  it("converts a pinned per-token spec to per-1M and prefers it over the table", () => {
    const basis = priceCall({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      tokensIn: 1_000_000,
      tokensOut: 0,
      spec,
    });
    // 0.00001 USD/token x 1M tokens = $10, not the table's $15.
    expect(basis).toMatchObject({ kind: "priced", costUsd: 10, source: "spec" });
  });

  it("lets an operator override outrank a pinned spec", () => {
    // An override exists to correct a drifted price. A spec that always won would make every
    // override unreachable for the models that have one — which is most of them.
    const basis = priceCall({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      tokensIn: 1_000_000,
      tokensOut: 0,
      spec,
      overrides: { "claude-opus-4-8": { in: 1, out: 1 } },
    });
    expect(basis).toMatchObject({ kind: "priced", costUsd: 1, source: "override" });
  });

  it("prices a model present only in the override map, prefix-tolerant", () => {
    const overrides = { "gpt-5.4": { in: 2, out: 8 } };
    expect(
      costOf(
        priceCall({
          provider: "openai",
          modelId: "gpt-5.4",
          tokensIn: 1_000_000,
          tokensOut: 0,
          overrides,
        })
      )
    ).toBe(2);
    expect(
      costOf(
        priceCall({
          provider: "openai",
          modelId: "gpt-5.4-2026-06-01",
          tokensIn: 1_000_000,
          tokensOut: 0,
          overrides,
        })
      )
    ).toBe(2);
  });
});

describe("priceCall subscription seats", () => {
  it("reports a subscription seat as unmetered, not at published API rates", () => {
    // The seat is already paid for. Charging it $90 fails Runs that had budget left.
    const basis = priceCall({
      provider: "claude-code",
      modelId: "claude-opus-4-8",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(basis.kind).toBe("subscription");
  });

  it("distinguishes a subscription seat from an unpriceable model", () => {
    // Both cost the budget nothing, but only one of them is knowably free. Collapsing them is
    // what let an unpriceable model run under a cost ceiling it could never trip.
    expect(
      priceCall({ provider: "claude-code", modelId: "anything", tokensIn: 1, tokensOut: 1 }).kind
    ).toBe("subscription");
    expect(meteredCall("anything", 1, 1).kind).toBe("unpriced");
  });

  it("recognises the seat by provider even when the model id is absent", () => {
    expect(
      priceCall({ provider: "claude-code", modelId: null, tokensIn: 0, tokensOut: 0 }).kind
    ).toBe("subscription");
  });
});

describe("isPriceable", () => {
  it("is true for a table model, a spec model and an override model", () => {
    expect(isPriceable({ provider: "anthropic", modelId: "claude-opus-4-8" })).toBe(true);
    expect(
      isPriceable({
        provider: "anthropic",
        modelId: "mystery",
        spec: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      })
    ).toBe(true);
    expect(
      isPriceable({
        provider: "anthropic",
        modelId: "mystery",
        overrides: { mystery: { in: 1, out: 2 } },
      })
    ).toBe(true);
  });

  it("is true for a subscription seat, whose zero cost is known rather than unknown", () => {
    expect(isPriceable({ provider: "claude-code", modelId: "mystery" })).toBe(true);
  });

  it("is false for a metered model no authority prices", () => {
    expect(isPriceable({ provider: "anthropic", modelId: "mystery" })).toBe(false);
  });
});
