import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { event as eventSchema } from "@tulipfarm/schema";

/**
 * Webhook ingress is fail-closed: cap, signature, parse, filter, encrypted raw payload, canonical
 * event, then `202`; denials expose only stable codes.
 */

export type WebhookVerificationMethod = "hmac_sha256" | "hmac_sha1" | "ed25519";

export interface WebhookVerification {
  readonly method: WebhookVerificationMethod;
  readonly secretRef: string;
  readonly signatureHeader: string;
  readonly signingTemplate?: string;
  readonly signatureFormat?: string;
  readonly timestampHeader?: string;
  readonly toleranceMs?: number;
}

export interface WebhookFilter {
  readonly path: string;
  readonly equals: unknown;
}

export interface WebhookTrigger {
  readonly triggerSlug: string;
  readonly businessId: string;
  readonly provider: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly verification: WebhookVerification;
  readonly maxBodyBytes?: number;
  readonly filter?: WebhookFilter;
  readonly deliveryIdHeader?: string;
  readonly integrationId?: string;
  readonly backgroundIdentity: { readonly principalKind: string; readonly principalId: string };
  readonly classification?: readonly string[];
}

export interface WebhookRequest {
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly receivedAt: string;
}

/** Resolves a Secret reference to plaintext. Never logged, never echoed. */
export interface WebhookSecretPort {
  resolve(secretRef: string): Promise<string>;
}

/** Stores the raw delivery bytes as an encrypted Artifact before the event is derived. */
export interface RawPayloadVault {
  store(input: {
    businessId: string;
    provider: string;
    triggerSlug: string;
    rawBody: Buffer;
    receivedAt: string;
  }): Promise<{ artifactId: string }>;
}

export interface WebhookEventSink {
  accept(
    envelope: eventSchema.EventEnvelope<Record<string, unknown>>
  ): Promise<{ outcome: "accepted" | "duplicate" }>;
}

export interface WebhookIngressDeps {
  readonly secrets: WebhookSecretPort;
  readonly vault: RawPayloadVault;
  readonly sink: WebhookEventSink;
  readonly nextEventId: () => string;
}

export type WebhookDenialCode =
  | "body_too_large"
  | "payload_not_json"
  | "secret_unavailable"
  | "signature_invalid"
  | "signature_missing"
  | "timestamp_missing"
  | "timestamp_stale"
  | "unsupported_method";

export type WebhookIngressResult =
  | {
      readonly status: 202;
      readonly outcome: "accepted" | "duplicate" | "ignored";
      readonly eventId: string | null;
      readonly deduplicationKey: string | null;
      /** Present only once the event is persisted, so a caller can bind it to a Trigger. */
      readonly envelope?: eventSchema.EventEnvelope<Record<string, unknown>>;
    }
  | { readonly status: 400 | 401 | 413; readonly code: WebhookDenialCode };

export const WEBHOOK_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TOLERANCE_MS = 300_000;

function deny(status: 400 | 401 | 413, code: WebhookDenialCode): WebhookIngressResult {
  return { status, code };
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function canonicalSigningInput(
  rawBody: Buffer,
  template: string,
  timestamp: string | undefined
): Buffer {
  const resolved = template.replaceAll("{timestamp}", timestamp ?? "");
  const parts = resolved.split("{body}");
  const chunks: Buffer[] = [];
  parts.forEach((part, index) => {
    chunks.push(Buffer.from(part));
    if (index < parts.length - 1) chunks.push(rawBody);
  });
  return Buffer.concat(chunks);
}

function verifyEd25519(signature: string, rawBody: Buffer, publicKeyHex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return false;
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "hex");
  } catch {
    // Malformed signature bytes verify as false (fail closed), never as valid.
    return false;
  }
  if (signatureBytes.length !== 64) return false;

  // Wrap the raw 32-byte key in the fixed Ed25519 SPKI prefix so `createPublicKey` accepts it.
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(publicKeyHex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  return verify(null, rawBody, key, signatureBytes);
}

function dotPath(body: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = body;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

async function verifySignature(
  trigger: WebhookTrigger,
  request: WebhookRequest,
  secrets: WebhookSecretPort
): Promise<WebhookDenialCode | null> {
  const { verification } = trigger;
  const signature = headerValue(request.headers, verification.signatureHeader);
  if (signature === undefined || signature === "") return "signature_missing";

  const template = verification.signingTemplate ?? "{body}";
  let timestamp: string | undefined;
  if (verification.timestampHeader !== undefined) {
    timestamp = headerValue(request.headers, verification.timestampHeader);
    if (timestamp === undefined || timestamp === "") return "timestamp_missing";
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return "timestamp_stale";
    const tolerance = verification.toleranceMs ?? DEFAULT_TOLERANCE_MS;
    if (Math.abs(Date.parse(request.receivedAt) - seconds * 1000) > tolerance) {
      return "timestamp_stale";
    }
  } else if (template.includes("{timestamp}")) {
    // The canonical string needs a timestamp the Trigger never declared a header for.
    return "timestamp_missing";
  }

  let secret: string;
  try {
    secret = await secrets.resolve(verification.secretRef);
  } catch {
    // An unresolvable secret becomes the explicit "secret_unavailable" denial (a 401), never a pass.
    return "secret_unavailable";
  }
  if (secret === "") return "secret_unavailable";

  if (verification.method === "ed25519") {
    return verifyEd25519(signature, request.rawBody, secret) ? null : "signature_invalid";
  }
  if (verification.method !== "hmac_sha256" && verification.method !== "hmac_sha1") {
    return "unsupported_method";
  }

  const algorithm = verification.method === "hmac_sha1" ? "sha1" : "sha256";
  const digest = createHmac(algorithm, secret)
    .update(canonicalSigningInput(request.rawBody, template, timestamp))
    .digest("hex");
  const expected = (verification.signatureFormat ?? "{signature}").replaceAll(
    "{signature}",
    digest
  );
  return constantTimeEquals(expected, signature) ? null : "signature_invalid";
}

/** Return `202` only after `sink.accept` commits; propagate persistence failures for retry. */
export async function ingestWebhook(
  trigger: WebhookTrigger,
  request: WebhookRequest,
  deps: WebhookIngressDeps
): Promise<WebhookIngressResult> {
  if (request.rawBody.byteLength > (trigger.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES)) {
    return deny(413, "body_too_large");
  }

  const denial = await verifySignature(trigger, request, deps.secrets);
  if (denial !== null) return deny(denial === "payload_not_json" ? 400 : 401, denial);

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(request.rawBody.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return deny(400, "payload_not_json");
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return deny(400, "payload_not_json");
  }

  if (trigger.filter !== undefined) {
    if (dotPath(data, trigger.filter.path) !== trigger.filter.equals) {
      return { status: 202, outcome: "ignored", eventId: null, deduplicationKey: null };
    }
  }

  const rawPayloadHash = createHash("sha256").update(request.rawBody).digest("hex");
  const deliveryId =
    trigger.deliveryIdHeader === undefined
      ? undefined
      : headerValue(request.headers, trigger.deliveryIdHeader);

  const { artifactId } = await deps.vault.store({
    businessId: trigger.businessId,
    provider: trigger.provider,
    triggerSlug: trigger.triggerSlug,
    rawBody: request.rawBody,
    receivedAt: request.receivedAt,
  });

  const eventId = deps.nextEventId();
  const envelope = eventSchema.validateEventEnvelope<Record<string, unknown>>({
    eventId,
    type: trigger.eventType,
    version: trigger.eventVersion,
    occurredAt: request.receivedAt,
    receivedAt: request.receivedAt,
    businessId: trigger.businessId,
    source: {
      provider: trigger.provider,
      ...(trigger.integrationId === undefined ? {} : { integrationId: trigger.integrationId }),
      ...(deliveryId === undefined ? {} : { deliveryId }),
    },
    principal: {
      kind: trigger.backgroundIdentity.principalKind,
      internalId: trigger.backgroundIdentity.principalId,
    },
    record: {},
    deduplicationKey: `${trigger.triggerSlug}:${deliveryId ?? rawPayloadHash}`,
    classification: [...(trigger.classification ?? [])],
    data,
    rawArtifactId: artifactId,
    rawPayloadHash,
    verification: { status: "verified", method: trigger.verification.method },
  });

  const { outcome } = await deps.sink.accept(envelope);
  return { status: 202, outcome, eventId, deduplicationKey: envelope.deduplicationKey, envelope };
}
