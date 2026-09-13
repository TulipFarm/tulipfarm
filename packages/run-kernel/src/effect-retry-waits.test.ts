import type { PersistedWait } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  DurableEffectRetryWaitHost,
  EFFECT_RETRY_WAIT_SCHEMA_REF,
  effectRetryWaitId,
} from "./effect-retry-waits";
import type { RegisteredWait, RegisterWaitInput } from "./waits";

class MemoryRetryWaits {
  readonly rows = new Map<string, PersistedWait>();

  async find(businessId: string, waitId: string): Promise<PersistedWait | null> {
    const wait = this.rows.get(waitId);
    return wait?.businessId === businessId ? wait : null;
  }

  async register(input: RegisterWaitInput): Promise<RegisteredWait> {
    if (this.rows.has(input.id)) throw new Error("duplicate_wait");
    const wait: PersistedWait = {
      ...input,
      status: "pending",
      resolvedAt: null,
      version: 1,
    };
    this.rows.set(wait.id, wait);
    return { wait, token: "one-use-token" };
  }

  satisfy(waitId: string): void {
    const wait = this.rows.get(waitId);
    if (wait === undefined) throw new Error("wait_not_found");
    this.rows.set(waitId, {
      ...wait,
      status: "satisfied",
      resolvedAt: wait.deadlineAt,
      version: wait.version + 1,
    });
  }
}

const input = {
  businessId: "business-1",
  effectId: "effect-1",
  runId: "run-1",
  stateId: "Send",
  attempt: 2,
  reason: "provider_rate_limited",
  delayMs: 20_000,
  notBefore: "2026-09-13T10:00:20.000Z",
};

describe("DurableEffectRetryWaitHost", () => {
  it("registers one deterministic durable timer and reports it ready after satisfaction", async () => {
    const waits = new MemoryRetryWaits();
    const host = new DurableEffectRetryWaitHost(waits);
    const waitId = "8caefa9b-b742-4dbe-a971-1b494fdb9d97";

    expect(effectRetryWaitId(input.effectId, input.attempt)).toBe(waitId);
    await expect(host.parkRetry(input)).resolves.toEqual({ waitId });
    await expect(host.parkRetry(input)).resolves.toEqual({ waitId });
    expect(waits.rows.get(waitId)).toMatchObject({
      runId: input.runId,
      stateKey: input.stateId,
      kind: "timer",
      schemaRef: EFFECT_RETRY_WAIT_SCHEMA_REF,
      deadlineAt: input.notBefore,
      createdAt: "2026-09-13T10:00:00.000Z",
    });
    await expect(host.status(input.businessId, input.effectId, input.attempt)).resolves.toEqual({
      status: "pending",
      waitId,
      notBefore: input.notBefore,
    });

    waits.satisfy(waitId);
    await expect(host.status(input.businessId, input.effectId, input.attempt)).resolves.toEqual({
      status: "ready",
      waitId,
      notBefore: input.notBefore,
    });
  });

  it("rejects invalid registration and conflicting reuse of the deterministic id", async () => {
    const waits = new MemoryRetryWaits();
    const host = new DurableEffectRetryWaitHost(waits);

    await expect(host.parkRetry({ ...input, attempt: 0 })).rejects.toThrow(
      "invalid_oim_rate_retry_wait"
    );
    await host.parkRetry(input);
    await expect(
      host.parkRetry({ ...input, notBefore: "2026-09-13T10:00:21.000Z" })
    ).rejects.toThrow("oim_rate_retry_wait_conflict");
  });
});
