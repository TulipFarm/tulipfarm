import { describe, expect, it } from "vitest";
import { computeSlackSignature, verifySlackSignature } from "./signature";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
const NOW = 1_752_480_000;
const TS = String(NOW - 30);

function signed(body: string = BODY, ts: string = TS, secret: string = SECRET) {
  return computeSlackSignature(body, ts, secret);
}

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request inside the replay window", () => {
    expect(verifySlackSignature(BODY, TS, signed(), SECRET, NOW)).toEqual({ ok: true });
  });

  it("accepts a Buffer body identically to a string body", () => {
    expect(verifySlackSignature(Buffer.from(BODY), TS, signed(), SECRET, NOW).ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const check = verifySlackSignature(`${BODY} `, TS, signed(), SECRET, NOW);
    expect(check).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a signature made with the wrong secret", () => {
    const check = verifySlackSignature(BODY, TS, signed(BODY, TS, "other-secret"), SECRET, NOW);
    expect(check).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects timestamps outside the 5-minute window (both directions)", () => {
    const past = String(NOW - 6 * 60);
    expect(verifySlackSignature(BODY, past, signed(BODY, past), SECRET, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
    const future = String(NOW + 6 * 60);
    expect(verifySlackSignature(BODY, future, signed(BODY, future), SECRET, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("accepts a timestamp just inside the window", () => {
    const edge = String(NOW - 4 * 60);
    expect(verifySlackSignature(BODY, edge, signed(BODY, edge), SECRET, NOW).ok).toBe(true);
  });

  it("rejects missing headers", () => {
    expect(verifySlackSignature(BODY, undefined, signed(), SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
    expect(verifySlackSignature(BODY, TS, undefined, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("rejects a non-numeric timestamp and a malformed signature prefix", () => {
    expect(verifySlackSignature(BODY, "yesterday", signed(), SECRET, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
    expect(verifySlackSignature(BODY, TS, signed().replace("v0=", "sha256="), SECRET, NOW)).toEqual(
      { ok: false, reason: "malformed_signature" }
    );
  });
});
