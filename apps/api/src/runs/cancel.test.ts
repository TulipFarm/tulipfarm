import { describe, expect, it, vi } from "vitest";
import { runCanceller } from "./cancel";

describe("runCanceller", () => {
  it("settles the Turn after queued cancellation becomes durable", async () => {
    const cancel = vi.fn(async () => ({
      runId: "run-1",
      outcome: "cancelled" as const,
      cancelledStateKeys: [],
      reconcilingStateKeys: [],
      cascadedChildRunIds: [],
      detachedChildRunIds: [],
    }));
    const reconcileRun = vi.fn(async () => true);
    const canceller = runCanceller({ cancel }, { reconcileRun });

    await expect(
      canceller.cancel({ businessId: "business-1", runId: "run-1", reason: "user_stop" })
    ).resolves.toBe(true);

    expect(reconcileRun).toHaveBeenCalledWith("business-1", "run-1");
  });

  it("keeps durable cancellation successful when immediate Turn settlement fails", async () => {
    const cancel = vi.fn(async () => ({
      runId: "run-1",
      outcome: "cancelled" as const,
      cancelledStateKeys: [],
      reconcilingStateKeys: [],
      cascadedChildRunIds: [],
      detachedChildRunIds: [],
    }));
    const canceller = runCanceller(
      { cancel },
      { reconcileRun: vi.fn(async () => Promise.reject(new Error("callback unavailable"))) }
    );

    await expect(
      canceller.cancel({ businessId: "business-1", runId: "run-1", reason: "user_stop" })
    ).resolves.toBe(true);
  });
});
