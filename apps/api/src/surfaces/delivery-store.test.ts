import { describe, expect, it } from "vitest";
import { MemorySurfaceDeliveryStore } from "./delivery-store";

const key = {
  artifactId: "artifact-1",
  revision: 1,
  target: { channel: "slack", surface: "message" },
  destination: "channel:C1",
} as const;

describe("MemorySurfaceDeliveryStore", () => {
  it("deduplicates pending and delivered dispatches", async () => {
    const store = new MemorySurfaceDeliveryStore();
    await expect(store.reserve(key)).resolves.toMatchObject({ shouldDispatch: true });
    await expect(store.reserve(key)).resolves.toMatchObject({ shouldDispatch: false });
    await store.record(key, { status: "delivered", providerMessageId: "171.002" });
    await expect(store.reserve(key)).resolves.toMatchObject({
      shouldDispatch: false,
      delivery: { providerMessageId: "171.002", status: "delivered", attempts: 1 },
    });
  });

  it("retries failed or ambiguous dispatches through the ledger", async () => {
    const store = new MemorySurfaceDeliveryStore();
    await store.reserve(key);
    await store.record(key, { status: "ambiguous", error: "response lost" });
    await expect(store.reserve(key)).resolves.toMatchObject({
      shouldDispatch: true,
      delivery: { status: "pending", attempts: 2 },
    });
  });
});
