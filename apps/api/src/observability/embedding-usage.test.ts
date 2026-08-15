import type { EmbeddingCallUsage } from "@tulipfarm/llm";
import { describe, expect, it } from "vitest";
import { createEmbeddingUsageSink, EMBEDDING_TIER } from "./embedding-usage";
import type { ObservabilityService, RecordObsInput } from "./service";

function capture(): { obs: ObservabilityService; rows: RecordObsInput[] } {
  const rows: RecordObsInput[] = [];
  const obs = {
    record: async (input: RecordObsInput) => {
      rows.push(input);
    },
  } as unknown as ObservabilityService;
  return { obs, rows };
}

const usage = (overrides: Partial<EmbeddingCallUsage> = {}): EmbeddingCallUsage => ({
  provider: "openai",
  model: "text-embedding-3-small",
  tokens: 1_000_000,
  values: 4,
  durationMs: 120,
  ...overrides,
});

describe("createEmbeddingUsageSink", () => {
  it("records an embedding call as a priceable llm_call", () => {
    const { obs, rows } = capture();
    createEmbeddingUsageSink(obs, () => undefined).record(
      usage({ spec: { input_cost_per_token: 0.00000002, output_cost_per_token: 0 } })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "llm_call",
      provider: "openai",
      model: "text-embedding-3-small",
      tier: EMBEDDING_TIER,
      tokensIn: 1_000_000,
      tokensOut: 0,
      costUsd: 0.02,
      durationMs: 120,
      status: "ok",
    });
    expect(rows[0]?.attributes).toMatchObject({
      kind: "embedding",
      values: 4,
      costBasis: "priced",
    });
  });

  it("lets an operator override outrank the pinned spec", () => {
    const { obs, rows } = capture();
    const sink = createEmbeddingUsageSink(obs, () => ({
      "text-embedding-3-small": { in: 1, out: 0 },
    }));
    sink.record(usage({ spec: { input_cost_per_token: 0.00000002, output_cost_per_token: 0 } }));

    expect(rows[0]?.costUsd).toBe(1);
  });

  it("records an unpriceable call rather than pricing it at zero", () => {
    // Zero and "we cannot say" are different facts. Collapsing them is what let unpriceable spend
    // read as free everywhere it was summed.
    const { obs, rows } = capture();
    createEmbeddingUsageSink(obs, () => undefined).record(usage());

    expect(rows[0]?.costUsd).toBeNull();
    expect(rows[0]?.attributes).toMatchObject({ costBasis: "unpriced" });
  });

  it("reads the override map at call time, not at construction", () => {
    // Observability config is parsed after the embedder is built and re-parsed on every Soul sync;
    // a captured snapshot would pin the first one forever.
    const { obs, rows } = capture();
    let overrides: Record<string, { in: number; out: number }> | undefined;
    const sink = createEmbeddingUsageSink(obs, () => overrides);

    sink.record(usage());
    expect(rows[0]?.costUsd).toBeNull();

    overrides = { "text-embedding-3-small": { in: 2, out: 0 } };
    sink.record(usage());
    expect(rows[1]?.costUsd).toBe(2);
  });
});
