import { describe, expect, it, vi } from "vitest";
import type { InternalApiClient } from "../internal/client";
import { startCommandResponseRecoveryLoop } from "./command-response-recovery";

describe("startCommandResponseRecoveryLoop", () => {
  it("asks the API to retry durable response URL deliveries", async () => {
    const controller = new AbortController();
    const require = vi.fn(async () => {
      controller.abort();
      return { attempted: 1, delivered: 1 };
    });

    const loop = startCommandResponseRecoveryLoop(controller.signal, {
      internalApi: { require } as unknown as InternalApiClient,
      log: { warn: vi.fn() },
      wait: async () => {},
    });
    await loop.settled;

    expect(require).toHaveBeenCalledWith(
      "POST",
      "/api/v1/internal/channels/slack/command-responses/process"
    );
  });
});
