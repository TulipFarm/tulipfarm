import type { OimEventType } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_NORMALIZATION_ATTEMPTS,
  type NormalizationInput,
  normalizeDelivery,
  retryDelaySeconds,
} from "./normalize";

const SCHEMA = {
  type: "object",
  required: ["city"],
  properties: { city: { type: "string" } },
  additionalProperties: false,
} as const;

function eventType(overrides: Partial<OimEventType> = {}): OimEventType {
  return {
    type: "forecast.updated",
    selector: { pointer: "/type", equals: "forecast_updated" },
    schema: structuredClone(SCHEMA),
    ...overrides,
  } as OimEventType;
}

const INPUT: NormalizationInput = {
  payload: { city: "Indore" },
  safeHeaders: { "x-delivery-id": "d-1" },
};

describe("normalizeDelivery", () => {
  it("passes a conforming payload straight through when no hook is declared", async () => {
    const result = await normalizeDelivery(eventType(), INPUT);
    expect(result).toEqual({
      kind: "normalized",
      event: { type: "forecast.updated", payload: { city: "Indore" } },
    });
  });

  it("runs the declared hook and types its output", async () => {
    const runHook = vi.fn(async () => ({ city: "Ujjain" }));
    const result = await normalizeDelivery(eventType({ normalize: "toForecast" }), INPUT, runHook);

    expect(runHook).toHaveBeenCalledWith("toForecast", INPUT);
    expect(result).toMatchObject({ kind: "normalized", event: { payload: { city: "Ujjain" } } });
  });

  it("gives a hook only the verified payload and the declared safe headers", async () => {
    const runHook = vi.fn(async (_name: string, input: NormalizationInput) => input.payload);
    await normalizeDelivery(eventType({ normalize: "toForecast" }), INPUT, runHook);

    expect(Object.keys(runHook.mock.calls[0]?.[1] ?? {})).toEqual(["payload", "safeHeaders"]);
  });

  it("rejects output that does not match the contract the Integration published", async () => {
    // The hook is the untrusted part. A subscriber trusting its output unchecked would be
    // trusting the author rather than the schema they declared.
    const runHook = vi.fn(async () => ({ town: "Indore" }));
    const result = await normalizeDelivery(eventType({ normalize: "toForecast" }), INPUT, runHook);

    expect(result.kind).toBe("rejected");
    expect(result).toMatchObject({ reason: expect.stringContaining("forecast.updated") });
  });

  it("rejects a payload that does not match even without a hook", async () => {
    const result = await normalizeDelivery(eventType(), { ...INPUT, payload: { town: "x" } });
    expect(result.kind).toBe("rejected");
  });

  it("retries a hook that threw, because that may not recur", async () => {
    const runHook = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await normalizeDelivery(eventType({ normalize: "toForecast" }), INPUT, runHook);

    expect(result).toEqual({ kind: "failed", reason: "toForecast failed: boom" });
  });

  it("does not retry output that can never satisfy the contract", async () => {
    const runHook = vi.fn(async () => undefined);
    const result = await normalizeDelivery(eventType({ normalize: "toForecast" }), INPUT, runHook);
    expect(result).toEqual({
      kind: "rejected",
      reason: "forecast.updated normalized to nothing",
    });
  });

  it("rejects output that cannot be serialized", async () => {
    const cyclic: Record<string, unknown> = { city: "Indore" };
    cyclic.self = cyclic;
    const runHook = vi.fn(async () => cyclic);
    const result = await normalizeDelivery(eventType({ normalize: "toForecast" }), INPUT, runHook);

    expect(result).toMatchObject({ kind: "rejected" });
    expect(result).toMatchObject({ reason: expect.stringContaining("non-serializable") });
  });

  it("rejects output large enough to be a denial of service", async () => {
    const runHook = vi.fn(async () => ({ city: "x".repeat(300_000) }));
    const result = await normalizeDelivery(eventType({ normalize: "toForecast" }), INPUT, runHook);
    expect(result).toMatchObject({ kind: "rejected" });
    expect(result).toMatchObject({ reason: expect.stringContaining("bytes") });
  });

  it("fails rather than passing a payload through when the hook cannot be run", async () => {
    // Silently skipping a declared hook would emit an event shaped like the provider's payload
    // under a type that promises the Integration's own shape.
    const result = await normalizeDelivery(eventType({ normalize: "toForecast" }), INPUT);
    expect(result).toMatchObject({ kind: "failed" });
  });
});

describe("retryDelaySeconds", () => {
  it("backs off and then stops growing", () => {
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(3)).toBe(120);
    expect(retryDelaySeconds(50)).toBe(3600);
  });

  it("bounds attempts so a broken mapping does not spin forever", () => {
    expect(MAX_NORMALIZATION_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
