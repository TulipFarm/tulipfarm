import { LlmNotConfiguredError, UnknownModelError } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { llmProbe, probeHealth } from "./health";

/** A configured, resolvable model. Resolution alone cannot tell a live key from a revoked one. */
const configured = { effortModel: vi.fn(() => ({})) };

const at = () => "2026-01-01T00:00:00.000Z";

describe("llmProbe", () => {
  it("reports configuration only when no reachability check is supplied", async () => {
    const result = await llmProbe(configured).check();

    expect(result).toEqual({ status: "ok" });
  });

  it("reports up while a working provider is still answering the live call", async () => {
    // A real model call outlives the probe budget on a cold subscription provider. Awaiting it
    // here timed the probe out, so the page said `down` about a provider that was answering chats.
    const verify = vi.fn(() => new Promise<void>(() => {}));

    const [component] = await probeHealth([llmProbe(configured, { reachability: { verify } })], at);

    expect(component.status).toBe("ok");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("degrades once the provider refuses the credential", async () => {
    // Resolution succeeds for a revoked key, so without a live check this reported `ok` and the
    // first person to learn the key was dead was a participant mid-chat.
    const probe = llmProbe(configured, {
      reachability: { verify: async () => Promise.reject(new Error("401 invalid api key")) },
    });

    await probe.check();

    await vi.waitFor(async () => {
      const result = await probe.check();
      expect(result.status).toBe("degraded");
      expect(result.detail).toContain("401 invalid api key");
    });
  });

  it("never reports down, so a provider cannot fail this deployment's readiness", async () => {
    const probe = llmProbe(configured, {
      reachability: { verify: async () => Promise.reject(new Error("anything")) },
    });

    await probe.check();

    await vi.waitFor(async () => expect((await probe.check()).status).toBe("degraded"));
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
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    await probe.check();
    expect(verify).toHaveBeenCalledTimes(1);

    clock += 60_001;
    await probe.check();
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
  });

  it("reports unknown, not down, when no provider is configured at all", async () => {
    const probe = llmProbe({
      effortModel: () => {
        throw new LlmNotConfiguredError();
      },
    });

    const [component] = await probeHealth([probe], at);

    expect(component.status).toBe("unknown");
    expect(component.detail).toBe("no LLM provider is configured");
  });

  it("still reports down when a configured model cannot be resolved", async () => {
    const probe = llmProbe({
      effortModel: () => {
        throw new UnknownModelError("gpt-5.6-terra");
      },
    });

    const [component] = await probeHealth([probe], at);

    expect(component.status).toBe("down");
    expect(component.detail).toContain("gpt-5.6-terra");
  });
});
