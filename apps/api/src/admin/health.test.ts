import { describe, expect, it, vi } from "vitest";
import { llmProbe } from "./health";

/** A configured, resolvable model. Resolution alone cannot tell a live key from a revoked one. */
const configured = { effortModel: vi.fn(() => ({})) };

describe("llmProbe", () => {
  it("reports configuration only when no reachability check is supplied", async () => {
    const result = await llmProbe(configured).check();

    expect(result).toEqual({ status: "ok" });
  });

  it("degrades when the provider refuses the credential", async () => {
    // Resolution succeeds for a revoked key, so without a live check this reported `ok` and the
    // first person to learn the key was dead was a participant mid-chat.
    const probe = llmProbe(configured, {
      reachability: { verify: async () => Promise.reject(new Error("401 invalid api key")) },
    });

    const result = await probe.check();

    expect(result.status).toBe("degraded");
    expect(result.detail).toContain("401 invalid api key");
  });

  it("never reports down, so a provider cannot fail this deployment's readiness", async () => {
    const probe = llmProbe(configured, {
      reachability: { verify: async () => Promise.reject(new Error("anything")) },
    });

    expect((await probe.check()).status).not.toBe("down");
  });

  it("caches the verdict so scraping the health page cannot spend tokens per hit", async () => {
    const verify = vi.fn(async () => {});
    let clock = 1_000;
    const probe = llmProbe(configured, {
      reachability: { verify },
      ttlMs: 60_000,
      now: () => clock,
    });

    await probe.check();
    await probe.check();
    expect(verify).toHaveBeenCalledTimes(1);

    clock += 60_001;
    await probe.check();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("still reports down when the model is not configured at all", async () => {
    const probe = llmProbe({
      effortModel: () => {
        throw new Error("llm not configured");
      },
    });

    await expect(probe.check()).rejects.toThrow("llm not configured");
  });
});
