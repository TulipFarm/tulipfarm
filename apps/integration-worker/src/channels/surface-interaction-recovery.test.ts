import { describe, expect, it, vi } from "vitest";
import type { InternalApiClient } from "../internal/client";
import { startSurfaceInteractionRecoveryLoop } from "./surface-interaction-recovery";

describe("startSurfaceInteractionRecoveryLoop", () => {
  it("asks the API to resume durable Surface reservations", async () => {
    const controller = new AbortController();
    const require = vi.fn(async () => {
      controller.abort();
      return { attempted: 1, processed: 1 };
    });

    const loop = startSurfaceInteractionRecoveryLoop(controller.signal, {
      internalApi: { require } as unknown as InternalApiClient,
      log: { warn: vi.fn() },
      wait: async () => {},
    });
    await loop.settled;

    expect(require).toHaveBeenCalledWith("POST", "/api/v1/internal/surfaces/interactions/recover");
  });
});
