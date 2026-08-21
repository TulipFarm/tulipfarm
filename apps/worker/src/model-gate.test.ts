import { ProviderUnavailableError } from "@tulipfarm/llm";
import { describe, expect, it, vi } from "vitest";
import { ProviderGate } from "./model-gate";

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("ProviderGate", () => {
  it("caps parallel calls to one provider and queues the rest", async () => {
    const gate = new ProviderGate({ maxConcurrency: 2 });

    const first = await gate.acquire("openai");
    await gate.acquire("openai");
    let third = false;
    const pending = gate.acquire("openai").then((lease) => {
      third = true;
      return lease;
    });

    await settled();
    expect(third).toBe(false);
    expect(gate.inFlight("openai")).toBe(2);

    first.release();
    await pending;
    expect(third).toBe(true);
    expect(gate.inFlight("openai")).toBe(2);
  });

  it("does not let a fresh caller steal a slot handed to a waiter", async () => {
    const gate = new ProviderGate({ maxConcurrency: 1 });

    const held = await gate.acquire("openai");
    const waiter = gate.acquire("openai");

    held.release();
    // Arrives in the microtask window between the handoff and the waiter resuming.
    const jumper = gate.acquire("openai");

    await waiter;
    let jumped = false;
    void jumper.then(() => {
      jumped = true;
    });
    await settled();

    expect(jumped).toBe(false);
    expect(gate.inFlight("openai")).toBe(1);
  });

  it("counts providers separately", async () => {
    const gate = new ProviderGate({ maxConcurrency: 1 });

    await gate.acquire("openai");
    await gate.acquire("anthropic");

    expect(gate.inFlight("openai")).toBe(1);
    expect(gate.inFlight("anthropic")).toBe(1);
  });

  it("rejects rather than queueing forever when no slot frees up", async () => {
    vi.useFakeTimers();
    try {
      const gate = new ProviderGate({ maxConcurrency: 1, queueTimeoutMs: 1000 });
      await gate.acquire("openai");

      const pending = gate.acquire("openai");
      const assertion = expect(pending).rejects.toBeInstanceOf(ProviderUnavailableError);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("sheds a provider after repeated infrastructure failures", async () => {
    const gate = new ProviderGate({ failureThreshold: 2, recoveryAfterMs: 10_000 });

    for (let i = 0; i < 2; i += 1) {
      const lease = await gate.acquire("openai");
      lease.failed("model_provider_unavailable");
      lease.release();
    }

    await expect(gate.acquire("openai")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("sheds a provider after any model failure", async () => {
    const gate = new ProviderGate();

    const lease = await gate.acquire("openai");
    lease.failed("model_billing_inactive");
    lease.release();

    await expect(gate.acquire("openai")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("lets one probe through after the recovery window and reopens on success", async () => {
    let clock = 0;
    const gate = new ProviderGate({
      failureThreshold: 1,
      recoveryAfterMs: 5_000,
      now: () => clock,
    });

    const failing = await gate.acquire("openai");
    failing.failed("model_rate_limited");
    failing.release();
    await expect(gate.acquire("openai")).rejects.toBeInstanceOf(ProviderUnavailableError);

    clock += 5_001;
    const probe = await gate.acquire("openai");
    probe.succeeded();
    probe.release();

    await expect(gate.acquire("openai")).resolves.toBeDefined();
  });

  it("does not strand the half-open probe when the prober cannot get capacity", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const gate = new ProviderGate({
        maxConcurrency: 1,
        failureThreshold: 1,
        recoveryAfterMs: 5_000,
        queueTimeoutMs: 1_000,
        now: () => clock,
      });

      // Opens the breaker while still holding the only slot, so the recovery probe has to queue.
      const stuck = await gate.acquire("openai");
      stuck.failed("model_provider_unavailable");

      clock += 5_001;
      const starved = gate.acquire("openai");
      const assertion = expect(starved).rejects.toBeInstanceOf(ProviderUnavailableError);
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;

      stuck.release();

      // Fails if the timed-out caller consumed the breaker's one probe on its way out: the
      // provider would then be shut with nothing in flight left to reopen it.
      const probe = await gate.acquire("openai");
      probe.succeeded();
      probe.release();
      await expect(gate.acquire("openai")).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a second release so a retry cannot inflate capacity", async () => {
    const gate = new ProviderGate({ maxConcurrency: 1 });

    const lease = await gate.acquire("openai");
    lease.release();
    lease.release();

    expect(gate.inFlight("openai")).toBe(0);
  });
});
