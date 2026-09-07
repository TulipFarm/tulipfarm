import type { OimManifest } from "@tulipfarm/schema";
import type { RecordedDelivery, WebhookDeliveryInput } from "@tulipfarm/storage";
import { hasDeclaredOimHook } from "../oim-hooks";
import {
  bodyDigest,
  decideAcceptance,
  deduplicationKey,
  handshakeAnswer,
  normalizeHeaders,
  parseDeliveryBody,
  safeHeadersFor,
  safeHeadersForClassifier,
} from "./delivery";
import { verifyDelivery } from "./verify";

/** Persists an accepted delivery. Narrower than the store so a caller cannot widen it by passing one. */
export interface InboxWriter {
  record(businessId: string, input: WebhookDeliveryInput): Promise<RecordedDelivery>;
}

/** The Connection whose Secret signs this Integration's deliveries. */
export interface WebhookBinding {
  readonly connectionId: string;
  readonly secretRef: string;
}

export interface ReceiveDeliveryDeps {
  /**
   * Resolves the Connection whose Secret signs this Integration's deliveries, or null when
   * nothing is connected. The slot is passed because only the manifest knows which Secret signs.
   */
  readonly binding: (request: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly majorVersion: number;
    readonly secretSlot: string;
    /** Present only for a Team Connection's connection-specific webhook URL. */
    readonly connectionId?: string;
  }) => Promise<WebhookBinding | null>;
  /** Reads a signing Secret. Only the verification host ever sees the result. */
  readonly readSecret: (ref: string) => Promise<string | undefined>;
  /** Encrypts the raw payload. This module never persists plaintext. */
  readonly encryptPayload: (raw: Buffer) => Promise<string>;
  readonly inbox: InboxWriter;
  readonly newDeliveryId: () => string;
  readonly now?: () => Date;
}

export interface ReceiveDeliveryRequest {
  readonly businessId: string;
  readonly manifest: OimManifest;
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Trusted public URL registered with the provider; never reconstructed from request headers. */
  readonly callbackUrl?: string;
  /** Present only for a Team Connection's connection-specific webhook URL. */
  readonly connectionId?: string;
}

export type ReceiveDeliveryResult =
  /** The provider asked us to prove we own the endpoint. */
  | { readonly kind: "handshake"; readonly body: unknown }
  /** Durable. The provider may be acknowledged. */
  | { readonly kind: "accepted"; readonly deliveryId: string; readonly duplicate: boolean }
  /** Verified but deliberately not kept — acknowledge, do not retry. */
  | { readonly kind: "discarded"; readonly reason: string }
  | { readonly kind: "unverified"; readonly reason: string }
  /** The endpoint exists but nothing here can receive: never say which. */
  | { readonly kind: "unavailable"; readonly reason: string };

function majorVersionOf(manifest: OimManifest): number {
  return Number(manifest.metadata.version.split(".", 1)[0]);
}

/**
 * Receives one provider delivery, up to and including durable persistence.
 *
 * Order matters and is not an implementation detail: a handshake is answered before any Secret is
 * read, verification precedes parsing so unsigned bytes are never interpreted, and the row is
 * written before the caller may acknowledge — an acknowledgement the inbox cannot honour is a
 * delivery the provider will never send again.
 */
export async function receiveDelivery(
  request: ReceiveDeliveryRequest,
  deps: ReceiveDeliveryDeps
): Promise<ReceiveDeliveryResult> {
  const events = request.manifest.events;
  if (!events) return { kind: "unavailable", reason: "no_events_declared" };

  const headers = normalizeHeaders(request.headers);
  const body = parseDeliveryBody(
    request.rawBody,
    events.verification.scheme === "twilio_hmac_sha1" ? "form" : "json"
  );
  if (body === undefined) return { kind: "unverified", reason: "unparseable_payload" };

  const handshake = handshakeAnswer(events, { body, headers });
  if (handshake.kind === "respond") return { kind: "handshake", body: handshake.body };

  const majorVersion = majorVersionOf(request.manifest);
  const binding = await deps.binding({
    businessId: request.businessId,
    integrationId: request.manifest.metadata.id,
    majorVersion,
    secretSlot: events.verification.secretSlot,
    ...(request.connectionId === undefined ? {} : { connectionId: request.connectionId }),
  });
  if (!binding) return { kind: "unavailable", reason: "not_connected" };

  const secret = await deps.readSecret(binding.secretRef);
  if (secret === undefined) return { kind: "unavailable", reason: "secret_unavailable" };

  const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const verification = verifyDelivery(
    events.verification,
    {
      rawBody: request.rawBody,
      headers: request.headers,
      ...(request.callbackUrl === undefined ? {} : { callbackUrl: request.callbackUrl }),
    },
    secret,
    nowSeconds
  );
  if (!verification.ok) return { kind: "unverified", reason: verification.reason };

  const parsed = { body, headers };
  const hasClassifier = hasDeclaredOimHook(request.manifest, "webhook_classify");
  const acceptance = hasClassifier ? undefined : decideAcceptance(events, parsed);
  if (acceptance?.kind === "discard") return { kind: "discarded", reason: acceptance.reason };

  const eventType = acceptance?.kind === "accept" ? acceptance.eventType : undefined;
  const key = deduplicationKey(events, parsed, request.rawBody);

  const recorded = await deps.inbox.record(request.businessId, {
    id: deps.newDeliveryId(),
    integrationId: request.manifest.metadata.id,
    integrationMajorVersion: majorVersion,
    connectionId: binding.connectionId,
    deduplicationKey: key.kind === "none" ? null : key.value,
    bodySha256: bodyDigest(request.rawBody),
    safeHeaders: hasClassifier
      ? safeHeadersForClassifier(events, headers)
      : eventType
        ? safeHeadersFor(events, eventType, headers)
        : {},
    encryptedBody: await deps.encryptPayload(request.rawBody),
    eventType: eventType?.type ?? null,
    verification: events.verification.scheme,
  });

  return {
    kind: "accepted",
    deliveryId: recorded.delivery.id,
    duplicate: !recorded.accepted,
  };
}
