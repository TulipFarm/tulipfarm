import type { OimManifest } from "@tulipfarm/schema";
import type { PersistedWebhookDelivery, WebhookDeliveryState } from "@tulipfarm/storage";
import { parseDeliveryBody, selectEventType } from "./delivery";
import {
  MAX_NORMALIZATION_ATTEMPTS,
  type NormalizeHookRunner,
  normalizeDelivery,
  retryDelaySeconds,
} from "./normalize";

/** The subset of the inbox a normalizer needs. It may not record new deliveries. */
export interface InboxProcessor {
  claim(
    limit: number,
    leaseSeconds: number,
    now?: Date
  ): Promise<readonly PersistedWebhookDelivery[]>;
  markNormalized(businessId: string, id: string, payload: unknown): Promise<void>;
  markFailed(
    businessId: string,
    id: string,
    error: string,
    options: { readonly maxAttempts: number; readonly backoffSeconds: number; readonly now?: Date }
  ): Promise<WebhookDeliveryState>;
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
  readonly runHook?: NormalizeHookRunner;
  readonly now?: () => Date;
}

export interface DrainOptions {
  readonly limit?: number;
  readonly leaseSeconds?: number;
}

export interface DrainSummary {
  readonly claimed: number;
  readonly normalized: number;
  readonly retrying: number;
  readonly deadLettered: number;
  /** Normalized, but the event could not reach the dispatch seam. */
  readonly undispatched: number;
}

/**
 * Normalizes one batch of accepted deliveries.
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
  let retrying = 0;
  let deadLettered = 0;
  let undispatched = 0;

  for (const delivery of claimed) {
    try {
      const outcome = await processOne(delivery, deps, now);
      if (outcome === "normalized") normalized += 1;
      else if (outcome === "dead_letter") deadLettered += 1;
      else retrying += 1;
    } catch (error) {
      if (!(error instanceof IntegrationEventDispatchError)) throw error;
      undispatched += 1;
    }
  }

  return { claimed: claimed.length, normalized, retrying, deadLettered, undispatched };
}

async function processOne(
  delivery: PersistedWebhookDelivery,
  deps: DrainDeps,
  now: Date
): Promise<WebhookDeliveryState> {
  const fail = (reason: string) =>
    deps.inbox.markFailed(delivery.businessId, delivery.id, reason, {
      maxAttempts: MAX_NORMALIZATION_ATTEMPTS,
      backoffSeconds: retryDelaySeconds(delivery.attempts),
      now,
    });

  if (delivery.encryptedBody === null) {
    // Retention removed the payload before anything normalized it. No later attempt can succeed,
    // so it dead-letters immediately rather than burning its remaining attempts on nothing.
    return deps.inbox.markFailed(
      delivery.businessId,
      delivery.id,
      "the raw payload was discarded before normalization",
      { maxAttempts: 0, backoffSeconds: 0, now }
    );
  }

  const manifest = await deps.manifestFor(
    delivery.businessId,
    delivery.integrationId,
    delivery.integrationMajorVersion
  );
  if (!manifest?.events) {
    // The Integration may be mid-upgrade or briefly unreadable, so this is retryable.
    return fail(`no Integration ${delivery.integrationId} v${delivery.integrationMajorVersion}`);
  }

  let body: unknown;
  try {
    body = parseDeliveryBody(await deps.decryptPayload(delivery.encryptedBody));
  } catch (error) {
    return fail(`the stored payload could not be read: ${messageOf(error)}`);
  }
  if (body === undefined) return fail("the stored payload could not be read");

  const eventType = delivery.eventType
    ? manifest.events.eventTypes.find((candidate) => candidate.type === delivery.eventType)
    : selectEventType(manifest.events, { body, headers: delivery.safeHeaders });
  if (!eventType) {
    // The type the delivery was accepted as no longer exists in the installed major version.
    return fail(`event type ${delivery.eventType ?? "(unmatched)"} is no longer declared`);
  }

  const result = await normalizeDelivery(
    eventType,
    { payload: body, safeHeaders: delivery.safeHeaders },
    deps.runHook
  );
  if (result.kind === "failed") return fail(result.reason);
  if (result.kind === "rejected") {
    return deps.inbox.markFailed(delivery.businessId, delivery.id, result.reason, {
      maxAttempts: 0,
      backoffSeconds: 0,
      now,
    });
  }

  await deps.inbox.markNormalized(delivery.businessId, delivery.id, result.event.payload);
  try {
    await deps.emit({
      businessId: delivery.businessId,
      integrationId: delivery.integrationId,
      integrationMajorVersion: delivery.integrationMajorVersion,
      connectionId: delivery.connectionId,
      deliveryId: delivery.id,
      type: result.event.type,
      payload: result.event.payload,
      safeHeaders: delivery.safeHeaders,
      replayOfId: delivery.replayOfId,
    });
  } catch (error) {
    // The delivery is already normalized. Re-running the hook on a retry would emit the event
    // twice, so a failed dispatch is surfaced without reopening the delivery.
    throw new IntegrationEventDispatchError(delivery.id, messageOf(error));
  }
  return "normalized";
}

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
