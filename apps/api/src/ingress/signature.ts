import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack rejects requests older than 5 minutes to prevent replay; we mirror that window. */
const REPLAY_WINDOW_SECONDS = 5 * 60;

/** Constant-time string equality (length leak only), same shape as routines/routes.ts. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface SignatureCheck {
  ok: boolean;
  /** Set when ok=false; safe to log, never echoed to the caller verbatim. */
  reason?: "missing_headers" | "stale_timestamp" | "malformed_signature" | "mismatch";
}

/**
 * Verify a Slack request signature: HMAC-SHA256 over `v0:{timestamp}:{rawBody}` keyed with the
 * app's signing secret, compared constant-time against the `X-Slack-Signature` header
 * (`v0=<hex>`). `nowSeconds` is injectable for tests.
 */
export function verifySlackSignature(
  rawBody: Buffer | string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  signingSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SignatureCheck {
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: "missing_headers" };
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "stale_timestamp" };
  if (Math.abs(nowSeconds - timestamp) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (!signatureHeader.startsWith("v0=")) return { ok: false, reason: "malformed_signature" };
  const expected = computeSlackSignature(rawBody, timestampHeader, signingSecret);
  if (!constantTimeEquals(expected, signatureHeader)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/** Compute the `v0=<hex>` signature Slack would send. Exported for test fixtures. */
export function computeSlackSignature(
  rawBody: Buffer | string,
  timestamp: string,
  signingSecret: string
): string {
  const base = Buffer.concat([
    Buffer.from(`v0:${timestamp}:`),
    typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody,
  ]);
  return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
}
