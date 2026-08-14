import { createHmac, timingSafeEqual } from "node:crypto";
import type { HmacWebhookSecurity, WebhookSecurity } from "@tulipfarm/soul";

/** Default replay window when the manifest sets a timestamp_header without tolerance_seconds. */
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

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
  reason?: "missing_headers" | "stale_timestamp" | "mismatch";
}

/** Verify manifest-declared HMAC-SHA256 templates; headers are case-insensitive. */
export function verifyHmacSignature(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  security: HmacWebhookSecurity,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SignatureCheck {
  const signatureHeader = headerValue(headers, security.header);
  if (!signatureHeader) return { ok: false, reason: "missing_headers" };

  const signing = security.signing ?? "{body}";
  let timestamp: string | undefined;
  if (security.timestamp_header) {
    timestamp = headerValue(headers, security.timestamp_header);
    if (!timestamp) return { ok: false, reason: "missing_headers" };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: "stale_timestamp" };
    const tolerance = security.tolerance_seconds ?? DEFAULT_TOLERANCE_SECONDS;
    if (Math.abs(nowSeconds - ts) > tolerance) return { ok: false, reason: "stale_timestamp" };
  } else if (signing.includes("{timestamp}")) {
    // Manifest bug: the canonical string needs a timestamp but none is configured.
    return { ok: false, reason: "missing_headers" };
  }

  const expected = computeHmacSignature(rawBody, security, secret, timestamp);
  if (!constantTimeEquals(expected, signatureHeader)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/** Compute provider signature headers for route test fixtures. */
export function computeHmacSignature(
  rawBody: Buffer | string,
  security: Pick<HmacWebhookSecurity, "signing" | "format">,
  secret: string,
  timestamp?: string
): string {
  const template = (security.signing ?? "{body}").replaceAll("{timestamp}", timestamp ?? "");
  // Split around {body} so raw body bytes are concatenated untouched (no string round-trip).
  const parts = template.split("{body}");
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const chunks: Buffer[] = [];
  parts.forEach((part, i) => {
    chunks.push(Buffer.from(part));
    if (i < parts.length - 1) chunks.push(body);
  });
  const hex = createHmac("sha256", secret).update(Buffer.concat(chunks)).digest("hex");
  return (security.format ?? "{hex}").replaceAll("{hex}", hex);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Add signature schemes here and in manifest types, not route hot paths. */
export function verifyWebhookRequest(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  security: WebhookSecurity,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SignatureCheck {
  if (security.type === "shared_secret") {
    const presented = headerValue(headers, security.header);
    if (!presented) return { ok: false, reason: "missing_headers" };
    return constantTimeEquals(presented, secret) ? { ok: true } : { ok: false, reason: "mismatch" };
  }
  return verifyHmacSignature(rawBody, headers, security, secret, nowSeconds);
}
