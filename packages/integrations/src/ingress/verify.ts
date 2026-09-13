import { createHmac, createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import type { OimVerification } from "@tulipfarm/schema";
import { parseFormBody, twilioSigningInput } from "./twilio-signature";

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerificationFailure =
  | "missing_signature"
  | "missing_callback_url"
  | "missing_timestamp"
  | "stale_timestamp"
  | "malformed_payload"
  | "malformed_signature"
  | "malformed_key"
  | "unsupported_algorithm"
  | "untrusted_claims"
  | "mismatch";

export type VerificationOutcome =
  | {
      readonly ok: true;
      readonly authenticatedEvidenceDigest: string;
      readonly signedAt?: number;
    }
  | { readonly ok: false; readonly reason: VerificationFailure };

export interface DeliveryRequest {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly callbackUrl?: string;
}

function headerValue(request: DeliveryRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const value =
    request.headers[wanted] ??
    Object.entries(request.headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
  const found = Array.isArray(value) ? value[0] : value;
  return found === undefined || found.length === 0 ? undefined : found;
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function decodeSignature(
  presented: string,
  encoding: OimVerification["signatureEncoding"],
  prefix: string | undefined
): Uint8Array | undefined {
  let value = presented.trim();
  if (prefix !== undefined) {
    if (!value.startsWith(prefix)) return undefined;
    value = value.slice(prefix.length);
  }
  if (value.length === 0) return undefined;
  try {
    switch (encoding ?? "hex") {
      case "hex":
        if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return undefined;
        return Uint8Array.from(Buffer.from(value, "hex"));
      case "base64":
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
        return Uint8Array.from(Buffer.from(value, "base64"));
      case "base64url":
        if (!/^[A-Za-z0-9\-_]+={0,2}$/.test(value)) return undefined;
        return Uint8Array.from(Buffer.from(value, "base64url"));
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

export function canonicalSigningInput(
  template: string,
  rawBody: Uint8Array,
  timestamp: string | undefined
): Uint8Array {
  const rendered = template.replaceAll("{timestamp}", timestamp ?? "");
  const parts = rendered.split("{body}");
  const chunks: Buffer[] = [];
  parts.forEach((part, index) => {
    chunks.push(Buffer.from(part, "utf8"));
    if (index < parts.length - 1) chunks.push(Buffer.from(rawBody));
  });
  return Uint8Array.from(Buffer.concat(chunks));
}

function checkTimestamp(
  verification: OimVerification,
  request: DeliveryRequest,
  nowSeconds: number
): { readonly value?: string; readonly failure?: VerificationFailure } {
  if (verification.timestampHeader === undefined) return {};
  const raw = headerValue(request, verification.timestampHeader);
  if (raw === undefined) return { failure: "missing_timestamp" };
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return { failure: "stale_timestamp" };
  const tolerance = verification.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - seconds) > tolerance) return { failure: "stale_timestamp" };
  return { value: raw };
}

function evidenceDigest(secret: string, scheme: string, proof: Uint8Array): string {
  return createHmac("sha256", secret)
    .update("tulipfarm-oim-ingress-evidence-v1\0")
    .update(scheme)
    .update("\0")
    .update(proof)
    .digest("hex");
}

function publicKeyOf(secret: string) {
  try {
    return createPublicKey(secret);
  } catch {
    return undefined;
  }
}

export function verifyDelivery(
  verification: OimVerification,
  request: DeliveryRequest,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): VerificationOutcome {
  const timestamp = checkTimestamp(verification, request, nowSeconds);
  if (timestamp.failure !== undefined) return { ok: false, reason: timestamp.failure };
  const signedAt = timestamp.value === undefined ? undefined : Number(timestamp.value);
  const accept = (proof: Uint8Array): VerificationOutcome => ({
    ok: true,
    authenticatedEvidenceDigest: evidenceDigest(secret, verification.scheme, proof),
    ...(signedAt === undefined ? {} : { signedAt }),
  });

  if (verification.scheme === "jwt") {
    return verifyJwt(verification, request, secret, nowSeconds);
  }

  const header =
    verification.scheme === "twilio_hmac_sha1"
      ? "X-Twilio-Signature"
      : verification.signatureHeader;
  if (header === undefined) return { ok: false, reason: "missing_signature" };
  const presented = headerValue(request, header);
  if (presented === undefined) return { ok: false, reason: "missing_signature" };

  if (verification.scheme === "shared_secret") {
    const offered = Uint8Array.from(Buffer.from(presented, "utf8"));
    const expected = Uint8Array.from(Buffer.from(secret, "utf8"));
    return constantTimeEquals(offered, expected)
      ? accept(request.rawBody)
      : { ok: false, reason: "mismatch" };
  }

  const signature = decodeSignature(
    presented,
    verification.signatureEncoding,
    verification.signaturePrefix
  );
  if (signature === undefined) return { ok: false, reason: "malformed_signature" };

  if (verification.scheme === "twilio_hmac_sha1") {
    if (signature.length !== 20) return { ok: false, reason: "malformed_signature" };
    if (request.callbackUrl === undefined) return { ok: false, reason: "missing_callback_url" };
    const contentType = headerValue(request, "content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      return { ok: false, reason: "malformed_payload" };
    }
    const body = parseFormBody(request.rawBody);
    if (body === undefined) return { ok: false, reason: "malformed_payload" };
    const expected = Uint8Array.from(
      createHmac("sha1", secret)
        .update(Buffer.from(twilioSigningInput(request.callbackUrl, body)))
        .digest()
    );
    return constantTimeEquals(signature, expected)
      ? accept(signature)
      : { ok: false, reason: "mismatch" };
  }

  const signed = canonicalSigningInput(
    verification.signingInput ?? "{body}",
    request.rawBody,
    timestamp.value
  );
  switch (verification.scheme) {
    case "hmac_sha256":
    case "hmac_sha512": {
      const algorithm = verification.scheme === "hmac_sha256" ? "sha256" : "sha512";
      const expected = Uint8Array.from(
        createHmac(algorithm, secret).update(Buffer.from(signed)).digest()
      );
      return constantTimeEquals(signature, expected)
        ? accept(signature)
        : { ok: false, reason: "mismatch" };
    }
    case "ed25519": {
      const key = publicKeyOf(secret);
      if (key === undefined || key.asymmetricKeyType !== "ed25519") {
        return { ok: false, reason: "malformed_key" };
      }
      return cryptoVerify(null, Buffer.from(signed), key, Buffer.from(signature))
        ? accept(signature)
        : { ok: false, reason: "mismatch" };
    }
    case "rsa_sha256": {
      const key = publicKeyOf(secret);
      if (key === undefined || key.asymmetricKeyType !== "rsa") {
        return { ok: false, reason: "malformed_key" };
      }
      return cryptoVerify("sha256", Buffer.from(signed), key, Buffer.from(signature))
        ? accept(signature)
        : { ok: false, reason: "mismatch" };
    }
  }
}

const JWT_ALGORITHMS = {
  HS256: { kind: "hmac", digest: "sha256" },
  HS512: { kind: "hmac", digest: "sha512" },
  RS256: { kind: "rsa", digest: "sha256" },
  RS512: { kind: "rsa", digest: "sha512" },
  EdDSA: { kind: "ed25519", digest: null },
} as const;

interface JwtClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
}

function decodeJwtSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function verifyJwt(
  verification: OimVerification,
  request: DeliveryRequest,
  secret: string,
  nowSeconds: number
): VerificationOutcome {
  const header = verification.signatureHeader;
  if (header === undefined) return { ok: false, reason: "missing_signature" };
  const raw = headerValue(request, header);
  if (raw === undefined) return { ok: false, reason: "missing_signature" };
  const token = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : raw.trim();
  const segments = token.split(".");
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (
    segments.length !== 3 ||
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return { ok: false, reason: "malformed_signature" };
  }

  const jwtHeader = decodeJwtSegment(encodedHeader);
  const algorithm =
    typeof jwtHeader === "object" && jwtHeader !== null
      ? (jwtHeader as { alg?: unknown }).alg
      : undefined;
  if (typeof algorithm !== "string" || !(algorithm in JWT_ALGORITHMS)) {
    return { ok: false, reason: "unsupported_algorithm" };
  }
  const spec = JWT_ALGORITHMS[algorithm as keyof typeof JWT_ALGORITHMS];
  const signed = Uint8Array.from(Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"));
  const signature = decodeSignature(encodedSignature, "base64url", undefined);
  if (signature === undefined) return { ok: false, reason: "malformed_signature" };

  if (spec.kind === "hmac") {
    if (publicKeyOf(secret) !== undefined) return { ok: false, reason: "unsupported_algorithm" };
    const expected = Uint8Array.from(
      createHmac(spec.digest, secret).update(Buffer.from(signed)).digest()
    );
    if (!constantTimeEquals(signature, expected)) return { ok: false, reason: "mismatch" };
  } else {
    const key = publicKeyOf(secret);
    if (key === undefined || key.asymmetricKeyType !== spec.kind) {
      return { ok: false, reason: "malformed_key" };
    }
    if (!cryptoVerify(spec.digest, Buffer.from(signed), key, Buffer.from(signature))) {
      return { ok: false, reason: "mismatch" };
    }
  }

  const claims = decodeJwtSegment(encodedPayload);
  if (typeof claims !== "object" || claims === null) {
    return { ok: false, reason: "malformed_signature" };
  }
  const { iss, aud, exp, nbf } = claims as JwtClaims;
  if (verification.issuer !== undefined && iss !== verification.issuer) {
    return { ok: false, reason: "untrusted_claims" };
  }
  if (verification.audience !== undefined) {
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(verification.audience)) {
      return { ok: false, reason: "untrusted_claims" };
    }
  }
  const skew = verification.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (typeof exp !== "number") return { ok: false, reason: "untrusted_claims" };
  if (nowSeconds > exp + skew) return { ok: false, reason: "stale_timestamp" };
  if (typeof nbf === "number" && nowSeconds + skew < nbf) {
    return { ok: false, reason: "stale_timestamp" };
  }
  return {
    ok: true,
    authenticatedEvidenceDigest: evidenceDigest(
      secret,
      verification.scheme,
      Buffer.from(token, "utf8")
    ),
    signedAt: exp,
  };
}
