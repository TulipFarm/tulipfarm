import { MAX_PROVIDER_RETRY_DELAY_MS } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "./retry-after";

const NOW = new Date("2026-09-18T00:00:00.000Z");

describe("parseRetryAfterMs", () => {
  it("parses seconds and case-insensitive provider headers", () => {
    expect(parseRetryAfterMs({ "retry-after": " 12 " }, NOW)).toBe(12_000);
    expect(parseRetryAfterMs({ "X-Backoff": "0" }, NOW, "x-backoff")).toBe(0);
  });

  it("bounds both delay seconds and HTTP dates by the durable wait limit", () => {
    expect(parseRetryAfterMs({ "Retry-After": "99999999" }, NOW)).toBe(MAX_PROVIDER_RETRY_DELAY_MS);
    expect(parseRetryAfterMs({ "Retry-After": "Tue, 18 Sep 2040 00:00:00 GMT" }, NOW)).toBe(
      MAX_PROVIDER_RETRY_DELAY_MS
    );
  });

  it("refuses missing, malformed, unsafe, and elapsed values", () => {
    for (const value of ["", "invalid", "9007199254740992", "Thu, 17 Sep 2026 00:00:00 GMT"]) {
      expect(parseRetryAfterMs({ "Retry-After": value }, NOW)).toBeUndefined();
    }
    expect(parseRetryAfterMs({}, NOW)).toBeUndefined();
  });
});
