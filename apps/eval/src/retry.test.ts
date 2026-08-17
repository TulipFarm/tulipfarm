import { ModelInvocationError, type ModelPort } from "@tulipfarm/agent-runtime";
import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY, TRANSIENT_REASONS, withRetry } from "./retry.ts";

const ok = {
  requestId: "r1",
  output: { kind: "text" as const, text: "hi" },
  usage: { inputTokens: 10, outputTokens: 2, costBasis: "priced" as const, costUsd: 0.001 },
};

/** A port that throws the given errors in order, then succeeds. */
function flaky(errors: unknown[]): { port: ModelPort; attempts: () => number } {
  let attempts = 0;
  const queue = [...errors];
  return {
    attempts: () => attempts,
    port: {
      invoke: async () => {
        attempts += 1;
        const next = queue.shift();
        if (next !== undefined) throw next;
        return ok;
      },
    },
  };
}

const transient = (usage?: { inputTokens: number; outputTokens: number }) =>
  new ModelInvocationError(
    "model_rate_limited",
    new Error("429"),
    usage === undefined ? undefined : { ...usage, costBasis: "priced", costUsd: 0.01 }
  );

const policy = { attempts: 3, backoffMs: 0, sleep: async () => {} };

describe("withRetry", () => {
  it("retries a transient vendor failure and reports each one", async () => {
    const { port, attempts } = flaky([transient(), transient()]);
    const seen: string[] = [];

    const result = await withRetry(port, policy, { retried: (r) => seen.push(r) }).invoke({
      requestId: "r1",
      modelProfileId: "eval",
      messages: [],
      tools: [],
    });

    expect(result).toEqual(ok);
    expect(attempts()).toBe(3);
    expect(seen).toEqual(["model_rate_limited", "model_rate_limited"]);
  });

  it("does not retry a standing condition", async () => {
    // A wrong key or a withdrawn model answers the same way however many times it is asked, and
    // a Sweep that retries them spends its wall clock reaching the same failure.
    const { port, attempts } = flaky([
      new ModelInvocationError("model_authentication_failed", new Error("401")),
    ]);

    await expect(
      withRetry(port, policy).invoke({
        requestId: "r1",
        modelProfileId: "eval",
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({ reason: "model_authentication_failed" });
    expect(attempts()).toBe(1);
  });

  it("counts what every failed attempt consumed, not only the one that answered", async () => {
    // A throttled call still submitted its prompt and was billed for it. Counting only the
    // successful attempt is how a retry-heavy Sweep comes in under a ceiling it blew through.
    const { port } = flaky([
      transient({ inputTokens: 100, outputTokens: 0 }),
      transient({ inputTokens: 100, outputTokens: 0 }),
    ]);
    const charged: number[] = [];

    await withRetry(port, policy, {
      attemptUsage: (u) => charged.push(u?.inputTokens ?? 0),
    }).invoke({ requestId: "r1", modelProfileId: "eval", messages: [], tools: [] });

    expect(charged).toEqual([100, 100]);
  });

  it("gives up after the configured attempts and surfaces the last failure", async () => {
    const { port, attempts } = flaky([transient(), transient(), transient()]);

    await expect(
      withRetry(port, policy).invoke({
        requestId: "r1",
        modelProfileId: "eval",
        messages: [],
        tools: [],
      })
    ).rejects.toMatchObject({ reason: "model_rate_limited" });
    expect(attempts()).toBe(3);
  });

  it("makes exactly one attempt when the policy asks for none, and reports no retry", async () => {
    // The loop bound was clamped to 1 while the give-up test compared against the raw count, so a
    // zero-attempt policy slept a full backoff and reported a retry it never performed.
    const { port, attempts } = flaky([transient(), transient()]);
    const retried: string[] = [];

    await expect(
      withRetry(
        port,
        { attempts: 0, backoffMs: 10_000 },
        { retried: (reason) => retried.push(reason) }
      ).invoke({ requestId: "r1", modelProfileId: "eval", messages: [], tools: [] })
    ).rejects.toMatchObject({ reason: "model_rate_limited" });
    expect(attempts()).toBe(1);
    expect(retried).toEqual([]);
  });

  it("treats only throttling and unavailability as worth another attempt", () => {
    expect([...TRANSIENT_REASONS].sort()).toEqual([
      "model_provider_unavailable",
      "model_rate_limited",
    ]);
    expect(DEFAULT_RETRY.attempts).toBeGreaterThan(1);
  });
});
