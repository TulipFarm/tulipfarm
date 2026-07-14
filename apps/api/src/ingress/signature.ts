import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookSecurity } from "@tulipfarm/soul";

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

/**
 * Verify an HMAC-SHA256 webhook signature entirely from the manifest's declarative security
 * block — no provider-specific code. The canonical string is the `signing` template
 * (vars: {timestamp}, {body}; default "{body}") and the expected header value is the `format`
 * template (var: {hex}; default "{hex}"). Header names are matched case-insensitively.
 * `nowSeconds` is injectable for tests.
 */
export function verifyHmacSignature(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  security: WebhookSecurity,
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

/**
 * Compute the signature header value the provider would send for this security config.
 * Exported for test fixtures (route tests sign synthetic payloads with it).
 */
export function computeHmacSignature(
  rawBody: Buffer | string,
  security: Pick<WebhookSecurity, "signing" | "format">,
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
