import { describe, expect, it } from "vitest";
import { MAX_PROVIDER_RETRY_DELAY_MS, nextRetryDelayMs, retryDelayMs } from "./retry";

describe("nextRetryDelayMs", () => {
  it("falls back to our backoff when the provider states nothing", () => {
    expect(nextRetryDelayMs(3)).toBe(retryDelayMs(3));
  });

  it("waits the provider's window when it is longer than our backoff", () => {
    expect(nextRetryDelayMs(1, 45_000)).toBe(45_000);
  });

  it("never shortens our backoff to satisfy a provider asking for less", () => {
    expect(nextRetryDelayMs(8, 1)).toBe(retryDelayMs(8));
  });

  it("caps a provider that would park the attempt on its own clock", () => {
    expect(nextRetryDelayMs(1, 3_600_000)).toBe(MAX_PROVIDER_RETRY_DELAY_MS);
  });

  it("ignores a non-finite header value rather than waiting forever", () => {
    expect(nextRetryDelayMs(2, Number.POSITIVE_INFINITY)).toBe(retryDelayMs(2));
    expect(nextRetryDelayMs(2, Number.NaN)).toBe(retryDelayMs(2));
  });
});
