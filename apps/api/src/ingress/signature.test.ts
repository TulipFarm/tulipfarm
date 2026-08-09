import type { HmacWebhookSecurity, SharedSecretWebhookSecurity } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { computeHmacSignature, verifyHmacSignature, verifyWebhookRequest } from "./signature";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = 1_700_000_000;

/** Slack-shaped scheme: v0:{ts}:{body} canonical string, v0= prefixed hex, 5-min window. */
const slackStyle: HmacWebhookSecurity = {
  type: "hmac_sha256",
  header: "X-Provider-Signature",
  secret_env: "SIGNING_SECRET",
  signing: "v0:{timestamp}:{body}",
  format: "v0={hex}",
  timestamp_header: "X-Provider-Timestamp",
  tolerance_seconds: 300,
};

/** GitHub-shaped scheme: HMAC over the body alone, sha256= prefix, no timestamp. */
const githubStyle: HmacWebhookSecurity = {
  type: "hmac_sha256",
  header: "X-Hub-Signature-256",
  secret_env: "WEBHOOK_SECRET",
  format: "sha256={hex}",
};

function slackHeaders(body: string, ts: number = NOW): Record<string, string> {
  return {
    "x-provider-timestamp": String(ts),
    "x-provider-signature": computeHmacSignature(body, slackStyle, SECRET, String(ts)),
  };
}

describe("verifyHmacSignature", () => {
  it("accepts a correctly signed timestamped payload (slack-style scheme)", () => {
    const body = '{"type":"event_callback"}';
    expect(verifyHmacSignature(body, slackHeaders(body), slackStyle, SECRET, NOW)).toEqual({
      ok: true,
    });
  });

  it("accepts a body-only scheme with a format prefix (github-style scheme)", () => {
    const body = '{"action":"opened"}';
    const headers = {
      "x-hub-signature-256": computeHmacSignature(body, githubStyle, SECRET),
    };
    expect(verifyHmacSignature(body, headers, githubStyle, SECRET, NOW)).toEqual({ ok: true });
  });

  it("defaults to signing the raw body with no format wrapper", () => {
    const minimal: HmacWebhookSecurity = { type: "hmac_sha256", header: "X-Sig", secret_env: "S" };
    const body = "payload";
    const headers = { "x-sig": computeHmacSignature(body, minimal, SECRET) };
    expect(verifyHmacSignature(body, headers, minimal, SECRET, NOW)).toEqual({ ok: true });
  });

  it("rejects a missing signature header", () => {
    expect(verifyHmacSignature("{}", {}, githubStyle, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("rejects a missing timestamp header when the scheme requires one", () => {
    const body = "{}";
    const headers = slackHeaders(body);
    delete headers["x-provider-timestamp"];
    expect(verifyHmacSignature(body, headers, slackStyle, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("rejects a {timestamp} signing template without a configured timestamp_header", () => {
    const broken: HmacWebhookSecurity = {
      type: "hmac_sha256",
      header: "X-Sig",
      secret_env: "S",
      signing: "v0:{timestamp}:{body}",
    };
    expect(verifyHmacSignature("{}", { "x-sig": "v0=abc" }, broken, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("rejects a timestamp outside the tolerance window (replay)", () => {
    const body = "{}";
    const stale = NOW - 301;
    expect(verifyHmacSignature(body, slackHeaders(body, stale), slackStyle, SECRET, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("applies the default 300s tolerance when unset", () => {
    const noTolerance: HmacWebhookSecurity = { ...slackStyle, tolerance_seconds: undefined };
    const body = "{}";
    const okAge = NOW - 299;
    expect(verifyHmacSignature(body, slackHeaders(body, okAge), noTolerance, SECRET, NOW).ok).toBe(
      true
    );
    const staleAge = NOW - 301;
    expect(
      verifyHmacSignature(body, slackHeaders(body, staleAge), noTolerance, SECRET, NOW)
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a non-numeric timestamp", () => {
    const body = "{}";
    const headers = { ...slackHeaders(body), "x-provider-timestamp": "yesterday" };
    expect(verifyHmacSignature(body, headers, slackStyle, SECRET, NOW)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("rejects a tampered body", () => {
    const headers = slackHeaders('{"a":1}');
    expect(verifyHmacSignature('{"a":2}', headers, slackStyle, SECRET, NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = "{}";
    const headers = {
      "x-provider-timestamp": String(NOW),
      "x-provider-signature": computeHmacSignature(body, slackStyle, "wrong-secret", String(NOW)),
    };
    expect(verifyHmacSignature(body, headers, slackStyle, SECRET, NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("signs identical bytes for Buffer and string bodies", () => {
    const body = '{"emoji":"🌷"}';
    expect(computeHmacSignature(Buffer.from(body), slackStyle, SECRET, String(NOW))).toBe(
      computeHmacSignature(body, slackStyle, SECRET, String(NOW))
    );
  });
});

/** Telegram-shaped scheme: the provider echoes a token we chose; nothing signs the body. */
const telegramStyle: SharedSecretWebhookSecurity = {
  type: "shared_secret",
  header: "X-Telegram-Bot-Api-Secret-Token",
  secret_env: "TELEGRAM_WEBHOOK_SECRET",
};

describe("verifyWebhookRequest", () => {
  it("accepts a matching shared secret regardless of body", () => {
    const headers = { "x-telegram-bot-api-secret-token": SECRET };
    expect(verifyWebhookRequest("{}", headers, telegramStyle, SECRET)).toEqual({ ok: true });
    expect(verifyWebhookRequest('{"a":1}', headers, telegramStyle, SECRET)).toEqual({ ok: true });
  });

  it("matches the header case-insensitively, as providers send it", () => {
    const headers = { "X-Telegram-Bot-Api-Secret-Token": SECRET };
    expect(verifyWebhookRequest("{}", headers, telegramStyle, SECRET)).toEqual({ ok: true });
  });

  it("rejects a wrong secret", () => {
    const headers = { "x-telegram-bot-api-secret-token": "not-it" };
    expect(verifyWebhookRequest("{}", headers, telegramStyle, SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a missing header rather than treating absence as a match", () => {
    expect(verifyWebhookRequest("{}", {}, telegramStyle, SECRET)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("rejects an empty secret header, which would otherwise pass against an empty secret", () => {
    expect(
      verifyWebhookRequest("{}", { "x-telegram-bot-api-secret-token": "" }, telegramStyle, "")
    ).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("routes hmac manifests to the signature check", () => {
    const body = "{}";
    const headers = {
      "x-provider-timestamp": String(NOW),
      "x-provider-signature": computeHmacSignature(body, slackStyle, SECRET, String(NOW)),
    };
    expect(verifyWebhookRequest(body, headers, slackStyle, SECRET, NOW)).toEqual({ ok: true });
    expect(verifyWebhookRequest(body, headers, slackStyle, "wrong", NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
});
