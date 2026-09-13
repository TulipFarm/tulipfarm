import type { OimManifest } from "@tulipfarm/schema";
import type { RecordedDelivery, VerifiedWebhookDeliveryInput } from "@tulipfarm/storage";
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

export interface OimIngressRoute {
  readonly integrationKey: string;
  readonly connectionId: string;
}

export interface VerifiedProviderIdentity {
  readonly externalTenantId: string;
  readonly externalAccountId: string;
}

export interface WebhookIngressBinding {
  readonly businessId: string;
  readonly integrationKey: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly manifest: OimManifest;
  readonly callbackUrl: string;
  readonly registrationRevision: number;
  readonly manifestDigest: string;
  readonly configurationDigest: string;
  readonly secretSlot: string;
  readonly secretRef: `secret://${string}`;
  readonly verifiedIdentity: VerifiedProviderIdentity;
}

export interface ReceiveOimDeliveryDeps {
  readonly resolveBinding: (route: OimIngressRoute) => Promise<WebhookIngressBinding | null>;
  readonly useVerificationSecret: <T>(
    binding: WebhookIngressBinding,
    use: (secret: string) => Promise<T> | T
  ) => Promise<T>;
  /** Must use signed claims or an authenticated provider lookup, never ordinary payload fields. */
  readonly verifyProviderIdentity: (input: {
    readonly binding: WebhookIngressBinding;
    readonly payload: unknown;
    readonly safeHeaders: Readonly<Record<string, string>>;
    readonly authenticatedEvidenceDigest: string;
  }) => Promise<VerifiedProviderIdentity | null>;
  readonly reauthorizeBinding: (binding: WebhookIngressBinding) => Promise<boolean>;
  readonly encryptPayload: (raw: Buffer) => Promise<string>;
  readonly recordVerifiedIfActive: (
    binding: WebhookIngressBinding,
    input: VerifiedWebhookDeliveryInput
  ) => Promise<RecordedDelivery>;
  readonly newDeliveryId: () => string;
  readonly now?: () => Date;
}

export interface ReceiveOimDeliveryRequest {
  readonly route: OimIngressRoute;
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type ReceiveOimDeliveryResult =
  | { readonly kind: "handshake"; readonly body: unknown }
  | { readonly kind: "accepted"; readonly deliveryId: string; readonly duplicate: boolean }
  | { readonly kind: "discarded"; readonly reason: string }
  | { readonly kind: "unverified"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

function sameIdentity(a: VerifiedProviderIdentity, b: VerifiedProviderIdentity): boolean {
  return a.externalTenantId === b.externalTenantId && a.externalAccountId === b.externalAccountId;
}

export async function receiveOimDelivery(
  request: ReceiveOimDeliveryRequest,
  deps: ReceiveOimDeliveryDeps
): Promise<ReceiveOimDeliveryResult> {
  const binding = await deps.resolveBinding(request.route);
  if (binding === null) return { kind: "unavailable", reason: "not_connected" };
  if (
    binding.integrationKey !== request.route.integrationKey ||
    binding.connectionId !== request.route.connectionId ||
    binding.integrationId !== binding.manifest.metadata.id ||
    Number(binding.manifest.metadata.version.split(".", 1)[0]) !== binding.integrationMajorVersion
  ) {
    return { kind: "unavailable", reason: "binding_mismatch" };
  }

  const events = binding.manifest.events;
  if (events === undefined || events.verification.secretSlot !== binding.secretSlot) {
    return { kind: "unavailable", reason: "no_events_declared" };
  }

  const verification = await deps.useVerificationSecret(binding, (secret) =>
    verifyDelivery(
      events.verification,
      {
        rawBody: request.rawBody,
        headers: request.headers,
        callbackUrl: binding.callbackUrl,
      },
      secret,
      Math.floor((deps.now?.() ?? new Date()).getTime() / 1000)
    )
  );
  if (!verification.ok) return { kind: "unverified", reason: verification.reason };

  const headers = normalizeHeaders(request.headers);
  const body = parseDeliveryBody(
    request.rawBody,
    events.verification.scheme === "twilio_hmac_sha1" ? "form" : "json"
  );
  if (body === undefined) return { kind: "unverified", reason: "unparseable_payload" };

  const verifiedIdentity = await deps.verifyProviderIdentity({
    binding,
    payload: body,
    safeHeaders: headers,
    authenticatedEvidenceDigest: verification.authenticatedEvidenceDigest,
  });
  if (verifiedIdentity === null || !sameIdentity(verifiedIdentity, binding.verifiedIdentity)) {
    return { kind: "unverified", reason: "provider_identity_mismatch" };
  }
  if (!(await deps.reauthorizeBinding(binding))) {
    return { kind: "unavailable", reason: "binding_inactive" };
  }

  const handshake = handshakeAnswer(events, { body, headers });
  if (handshake.kind === "respond") return { kind: "handshake", body: handshake.body };

  const parsed = { body, headers };
  const hasClassifier = hasDeclaredOimHook(binding.manifest, "webhook_classify");
  const acceptance = hasClassifier ? undefined : decideAcceptance(events, parsed);
  if (acceptance?.kind === "discard") return { kind: "discarded", reason: acceptance.reason };

  const eventType = acceptance?.kind === "accept" ? acceptance.eventType : undefined;
  const key = deduplicationKey(events, parsed, request.rawBody);
  const recorded = await deps.recordVerifiedIfActive(binding, {
    id: deps.newDeliveryId(),
    integrationId: binding.integrationId,
    integrationMajorVersion: binding.integrationMajorVersion,
    connectionId: binding.connectionId,
    externalTenantId: binding.verifiedIdentity.externalTenantId,
    externalAccountId: binding.verifiedIdentity.externalAccountId,
    deduplicationKey: key.kind === "none" ? null : key.value,
    bodySha256: bodyDigest(request.rawBody),
    safeHeaders: hasClassifier
      ? safeHeadersForClassifier(events, headers)
      : eventType
        ? safeHeadersFor(events, eventType, headers)
        : {},
    encryptedBody: await deps.encryptPayload(request.rawBody),
    eventType: eventType?.type ?? null,
    verification: "verified",
    authenticatedEvidenceDigest: verification.authenticatedEvidenceDigest,
  });
  return {
    kind: "accepted",
    deliveryId: recorded.delivery.id,
    duplicate: !recorded.accepted,
  };
}
