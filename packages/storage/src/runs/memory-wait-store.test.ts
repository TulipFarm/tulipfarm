import { describe, expect, it } from "vitest";
import { MemoryWaitStore } from "./memory-wait-store";
import type { CreateWaitInput } from "./wait-store";

function wait(overrides: Partial<CreateWaitInput> = {}): CreateWaitInput {
  return {
    id: "wait-1",
    businessId: "business-1",
    runId: "run-1",
    stateKey: "await-approval",
    kind: "event",
    aggregation: "first",
    schemaRef: "sha256:bundle-1#/states/await-approval/signal",
    allowedPrincipals: ["user:alice"],
    expectedSignals: 1,
    quorum: null,
    tokenHash: "sha256:token-1",
    deadlineAt: "2026-07-25T10:05:00.000Z",
    createdAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryWaitStore", () => {
  it("rejects a duplicate wait id", async () => {
    const store = new MemoryWaitStore();
    await store.create(wait());

    await expect(store.create(wait({ tokenHash: "sha256:token-2" }))).rejects.toThrow(
      "run_wait_conflict"
    );
  });

  it("rejects a reused resume token digest", async () => {
    const store = new MemoryWaitStore();
    await store.create(wait());

    await expect(store.create(wait({ id: "wait-2" }))).rejects.toThrow("run_wait_token_conflict");
  });

  it("isolates waits by business", async () => {
    const store = new MemoryWaitStore();
    await store.create(wait());

    expect(await store.find("business-2", "wait-1")).toBeNull();
    expect(
      await store.deliverSignal(
        {
          id: "signal-1",
          businessId: "business-2",
          tokenHash: "sha256:token-1",
          runId: "run-1",
          correlationKey: "delivery-1",
          signalDigest: "sha256:signal-1",
          principal: "user:alice",
          receivedAt: "2026-07-25T10:01:00.000Z",
        },
        { authorize: () => null, isSatisfied: () => true }
      )
    ).toMatchObject({ outcome: "unknown_token" });
  });
});
