import type { OimEventType, OimManifest } from "@tulipfarm/schema";
import type { PersistedWebhookDelivery, WebhookDeliveryState } from "@tulipfarm/storage";
import type { OimHookPhaseRunner } from "../oim-hooks";
import { parseDeliveryBody, selectEventType } from "./delivery";
import {
  classifyWebhookDelivery,
  MAX_NORMALIZATION_ATTEMPTS,
  normalizeDelivery,
  retryDelaySeconds,
  WebhookClassificationError,
} from "./normalize";

/** The subset of the inbox a normalizer needs. It may not record new deliveries. */
export interface InboxProcessor {
  claim(
    limit: number,
    leaseSeconds: number,
    now?: Date
  ): Promise<readonly PersistedWebhookDelivery[]>;
  markNormalized(
    businessId: string,
    id: string,
    eventType: string,
    payload: unknown,
    options: WebhookClaimFence & { readonly now?: Date }
  ): Promise<boolean>;
  markDispatched(businessId: string, id: string, fence: WebhookClaimFence): Promise<boolean>;
  markFailed(
    businessId: string,
    id: string,
    error: string,
    options: WebhookClaimFence & {
      readonly maxAttempts: number;
      readonly backoffSeconds: number;
      readonly now?: Date;
    }
  ): Promise<WebhookDeliveryState | null>;
}

interface WebhookClaimFence {
  readonly expectedState: "accepted" | "normalized";
  readonly expectedAttempts: number;
  readonly expectedLeaseExpiresAt: Date;
}

/** A typed Integration event, ready for the single event-to-Run dispatch seam. */
export interface IntegrationEvent {
  readonly businessId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string | null;
  readonly deliveryId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly safeHeaders: Readonly<Record<string, string>>;
  readonly replayOfId: string | null;
}

export interface DrainDeps {
  readonly inbox: InboxProcessor;
  readonly manifestFor: (
    businessId: string,
    integrationId: string,
    majorVersion: number
  ) => Promise<OimManifest | null>;
  readonly decryptPayload: (encrypted: string) => Promise<Buffer>;
  readonly emit: (event: IntegrationEvent) => Promise<void>;
  readonly hookRunnerFor?: (input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly integrationMajorVersion: number;
    readonly manifest: OimManifest;
  }) => Promise<OimHookPhaseRunner | undefined>;
  readonly now?: () => Date;
}

export interface DrainOptions {
  readonly limit?: number;
  readonly leaseSeconds?: number;
}

export interface DrainSummary {
  readonly claimed: number;
  readonly normalized: number;
  readonly dispatched: number;
  readonly retrying: number;
  readonly deadLettered: number;
  /** Normalized, but the event could not reach the dispatch seam. */
  readonly undispatched: number;
}

/**
 * Advances one batch of accepted or normalized deliveries.
 *
 * Each delivery is handled independently and its failure is recorded rather than thrown: a single
 * poison payload must not stop the deliveries queued behind it, which is exactly what a batch that
 * aborts on the first error would do.
 */
export async function drainInbox(
  deps: DrainDeps,
  options: DrainOptions = {}
): Promise<DrainSummary> {
  const now = deps.now?.() ?? new Date();
  const claimed = await deps.inbox.claim(options.limit ?? 20, options.leaseSeconds ?? 120, now);

  let normalized = 0;
  let dispatched = 0;
  let retrying = 0;
  let deadLettered = 0;
  let undispatched = 0;

  for (const delivery of claimed) {
    const outcome = await processOne(delivery, deps, now);
    if (outcome === "stale") continue;
    if (outcome === "normalized") normalized += 1;
    else if (outcome === "dispatched") dispatched += 1;
    else if (outcome === "dead_letter") deadLettered += 1;
    else {
      retrying += 1;
      if (delivery.state === "normalized") undispatched += 1;
    }
  }

  return { claimed: claimed.length, normalized, dispatched, retrying, deadLettered, undispatched };
}

async function processOne(
  delivery: PersistedWebhookDelivery,
  deps: DrainDeps,
  now: Date
): Promise<WebhookDeliveryState | "stale"> {
  if (delivery.state === "normalized") return dispatchOne(delivery, deps, now);

  const fence = claimFence(delivery);
  const fail = async (reason: string) =>
    (await deps.inbox.markFailed(delivery.businessId, delivery.id, reason, {
      maxAttempts: MAX_NORMALIZATION_ATTEMPTS,
      backoffSeconds: retryDelaySeconds(delivery.attempts),
      now,
      ...fence,
    })) ?? "stale";
  const reject = async (reason: string) =>
    (await deps.inbox.markFailed(delivery.businessId, delivery.id, reason, {
      maxAttempts: 0,
      backoffSeconds: 0,
      now,
      ...fence,
    })) ?? "stale";

  if (delivery.encryptedBody === null) {
    // Retention removed the payload before anything normalized it. No later attempt can succeed,
    // so it dead-letters immediately rather than burning its remaining attempts on nothing.
    return (
      (await deps.inbox.markFailed(
        delivery.businessId,
        delivery.id,
        "the raw payload was discarded before normalization",
        { maxAttempts: 0, backoffSeconds: 0, now, ...fence }
      )) ?? "stale"
    );
  }

  const manifest = await deps.manifestFor(
    delivery.businessId,
    delivery.integrationId,
    delivery.integrationMajorVersion
  );
  if (manifest === null) {
    // The Integration may be mid-upgrade or briefly unreadable, so this is retryable.
    return fail(`no Integration ${delivery.integrationId} v${delivery.integrationMajorVersion}`);
  }
  const pollingIngress =
    delivery.verification === "polling" && manifest.ingress?.kind === "polling"
      ? manifest.ingress
      : undefined;
  const eventTypes = pollingIngress?.eventTypes ?? manifest.events?.eventTypes;
  if (eventTypes === undefined) {
    return fail(
      `no event contract for Integration ${delivery.integrationId} v${delivery.integrationMajorVersion}`
    );
  }

  let body: unknown;
  try {
    body = parseDeliveryBody(
      await deps.decryptPayload(delivery.encryptedBody),
      pollingIngress === undefined && manifest.events?.verification.scheme === "twilio_hmac_sha1"
        ? "form"
        : "json"
    );
  } catch (error) {
    return fail(`the stored payload could not be read: ${messageOf(error)}`);
  }
  if (body === undefined) return fail("the stored payload could not be read");

  let runner: OimHookPhaseRunner | undefined;
  try {
    runner = await deps.hookRunnerFor?.({
      businessId: delivery.businessId,
      integrationId: delivery.integrationId,
      integrationMajorVersion: delivery.integrationMajorVersion,
      manifest,
    });
  } catch (error) {
    return fail(`the Hook runner could not be created: ${messageOf(error)}`);
  }

  let classified: OimEventType | null | undefined;
  if (pollingIngress === undefined) {
    try {
      classified = await classifyWebhookDelivery(
        manifest,
        { payload: body, safeHeaders: delivery.safeHeaders },
        runner
      );
    } catch (error) {
      const reason = `webhook classification failed: ${messageOf(error)}`;
      return error instanceof WebhookClassificationError && !error.retryable
        ? reject(reason)
        : fail(reason);
    }
    if (classified === null) return reject("webhook classifier returned no known event type");
  }

  const eventType =
    classified ??
    (delivery.eventType
      ? eventTypes.find((candidate) => candidate.type === delivery.eventType)
      : selectEventType({ eventTypes }, { body, headers: delivery.safeHeaders }));
  if (!eventType) {
    // The type the delivery was accepted as no longer exists in the installed major version.
    return fail(`event type ${delivery.eventType ?? "(unmatched)"} is no longer declared`);
  }

  const result = await normalizeDelivery(
    manifest,
    eventType,
    { payload: body, safeHeaders: delivery.safeHeaders },
    runner
  );
  if (result.kind === "failed") return fail(result.reason);
  if (result.kind === "rejected") return reject(result.reason);

  return (await deps.inbox.markNormalized(
    delivery.businessId,
    delivery.id,
    result.event.type,
    result.event.payload,
    { now, ...fence }
  ))
    ? "normalized"
    : "stale";
}

async function dispatchOne(
  delivery: PersistedWebhookDelivery,
  deps: DrainDeps,
  now: Date
): Promise<WebhookDeliveryState | "stale"> {
  const fence = claimFence(delivery);
  if (delivery.eventType === null) {
    return (
      (await deps.inbox.markFailed(
        delivery.businessId,
        delivery.id,
        "the normalized event has no event type",
        { maxAttempts: 0, backoffSeconds: 0, now, ...fence }
      )) ?? "stale"
    );
  }

  try {
    await deps.emit({
      businessId: delivery.businessId,
      integrationId: delivery.integrationId,
      integrationMajorVersion: delivery.integrationMajorVersion,
      connectionId: delivery.connectionId,
      deliveryId: delivery.id,
      type: delivery.eventType,
      payload: delivery.normalizedPayload,
      safeHeaders: delivery.safeHeaders,
      replayOfId: delivery.replayOfId,
    });
  } catch (error) {
    return (
      (await deps.inbox.markFailed(
        delivery.businessId,
        delivery.id,
        `event dispatch failed: ${messageOf(error)}`,
        {
          maxAttempts: MAX_NORMALIZATION_ATTEMPTS,
          backoffSeconds: retryDelaySeconds(delivery.attempts),
          now,
          ...fence,
        }
      )) ?? "stale"
    );
  }
  return (await deps.inbox.markDispatched(delivery.businessId, delivery.id, fence))
    ? "dispatched"
    : "stale";
}

/** Kept for callers that classify legacy dispatch errors. Durable dispatch now records failures. */
export class IntegrationEventDispatchError extends Error {
  constructor(
    readonly deliveryId: string,
    reason: string
  ) {
    super(`delivery ${deliveryId} normalized but its event could not be dispatched: ${reason}`);
    this.name = "IntegrationEventDispatchError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function claimFence(delivery: PersistedWebhookDelivery): WebhookClaimFence {
  if (
    (delivery.state !== "accepted" && delivery.state !== "normalized") ||
    delivery.leaseExpiresAt === null
  ) {
    throw new Error(`delivery ${delivery.id} is not an active inbox claim`);
  }
  return {
    expectedState: delivery.state,
    expectedAttempts: delivery.attempts,
    expectedLeaseExpiresAt: delivery.leaseExpiresAt,
  };
}
