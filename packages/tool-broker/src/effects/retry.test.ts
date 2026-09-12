import { describe, expect, it } from "vitest";
import { MAX_PROVIDER_RETRY_DELAY_MS, nextRetryDelayMs, retryDelayMs } from "./retry";

describe("nextRetryDelayMs", () => {
  it("keeps local backoff when the provider gives no usable delay", () => {
    expect(nextRetryDelayMs(3)).toBe(retryDelayMs(3));
    expect(nextRetryDelayMs(3, Number.NaN)).toBe(retryDelayMs(3));
  });

  it("honors a longer provider delay within the host ceiling", () => {
    expect(nextRetryDelayMs(1, 45_000)).toBe(45_000);
    expect(nextRetryDelayMs(1, 3_600_000)).toBe(MAX_PROVIDER_RETRY_DELAY_MS);
  });
});
