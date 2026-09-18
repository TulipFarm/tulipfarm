import { describe, expect, it, vi } from "vitest";
import { ConsumerReadiness } from "../consumer-readiness";
import { InternalApiClient } from "../internal/client";
import { startNativeEventLoop } from "./event-loop";

describe("native event loop", () => {
  it.each([
    { status: 200, body: { claimed: 0, dispatched: 0, denied: 0, retrying: 0 }, ready: true },
    { status: 404, body: { error: "missing" }, ready: false },
    { status: 200, body: { claimed: 0 }, ready: false },
  ])("tracks actual host dispatch success: $status $ready", async ({ status, body, ready }) => {
    const controller = new AbortController();
    const readiness = new ConsumerReadiness();
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    const warn = vi.fn();
    const loop = startNativeEventLoop(controller.signal, {
      internalApi: new InternalApiClient({
        baseUrl: "http://internal.test",
        credential: "test",
        fetch,
      }),
      readiness,
      log: { warn },
      wait: async () => controller.abort(),
    });
    await loop.settled;
    expect(readiness.isReady()).toBe(ready);
    expect(fetch).toHaveBeenCalledWith(
      "http://internal.test/api/v1/internal/channels/events/drain",
      expect.objectContaining({ method: "POST", body: '{"limit":20}' })
    );
    expect(warn).toHaveBeenCalledTimes(ready ? 0 : 1);
  });
});
