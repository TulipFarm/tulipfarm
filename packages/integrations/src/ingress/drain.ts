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

interface WebhookClaimFence {
  readonly expectedState: "accepted" | "normalized";
  readonly expectedAttempts: number;
  readonly expectedLeaseExpiresAt: Date;
}

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

export interface IntegrationEvent {
  readonly businessId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string | null;
  readonly externalTenantId: string | null;
  readonly externalAccountId: string | null;
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
  /** Atomically fences the Connection and delivery claim while inserting the durable event. */
  readonly emitIfAuthorized: (
    event: IntegrationEvent,
    fence: WebhookClaimFence
  ) => Promise<"inserted" | "duplicate" | "unauthorized" | "stale">;
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
  readonly undispatched: number;
}

type ProcessOutcome = "normalized_now" | "dispatched" | "retry" | "dead_letter" | "stale";

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
    if (outcome === "normalized_now") normalized += 1;
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
): Promise<ProcessOutcome> {
  if (delivery.state === "normalized") return dispatchOne(delivery, deps, now);
  const fence = claimFence(delivery);
  const fail = async (reason: string): Promise<ProcessOutcome> => {
    const state = await deps.inbox.markFailed(delivery.businessId, delivery.id, reason, {
      maxAttempts: MAX_NORMALIZATION_ATTEMPTS,
      backoffSeconds: retryDelaySeconds(delivery.attempts),
      now,
      ...fence,
    });
    return state === null ? "stale" : state === "dead_letter" ? "dead_letter" : "retry";
  };
  const reject = async (reason: string): Promise<ProcessOutcome> => {
    const state = await deps.inbox.markFailed(delivery.businessId, delivery.id, reason, {
      maxAttempts: 0,
      backoffSeconds: 0,
      now,
      ...fence,
    });
    return state === null ? "stale" : state === "dead_letter" ? "dead_letter" : "retry";
  };

  if (delivery.encryptedBody === null) {
    return reject("the raw payload was discarded before normalization");
  }
  const manifest = await deps.manifestFor(
    delivery.businessId,
    delivery.integrationId,
    delivery.integrationMajorVersion
  );
  if (manifest === null) {
    return fail(`no Integration ${delivery.integrationId} v${delivery.integrationMajorVersion}`);
  }
  const pollingIngress =
    delivery.verification === "verified_polling" && manifest.ingress?.kind === "polling"
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
    ? "normalized_now"
    : "stale";
}

async function dispatchOne(
  delivery: PersistedWebhookDelivery,
  deps: DrainDeps,
  now: Date
): Promise<ProcessOutcome> {
  const fence = claimFence(delivery);
  if (delivery.eventType === null) {
    const state = await deps.inbox.markFailed(
      delivery.businessId,
      delivery.id,
      "the normalized event has no event type",
      { maxAttempts: 0, backoffSeconds: 0, now, ...fence }
    );
    return state === null ? "stale" : state === "dead_letter" ? "dead_letter" : "retry";
  }
  const event: IntegrationEvent = {
    businessId: delivery.businessId,
    integrationId: delivery.integrationId,
    integrationMajorVersion: delivery.integrationMajorVersion,
    connectionId: delivery.connectionId,
    externalTenantId: delivery.externalTenantId,
    externalAccountId: delivery.externalAccountId,
    deliveryId: delivery.id,
    type: delivery.eventType,
    payload: delivery.normalizedPayload,
    safeHeaders: delivery.safeHeaders,
    replayOfId: delivery.replayOfId,
  };
  try {
    const emitted = await deps.emitIfAuthorized(event, fence);
    if (emitted === "stale") return "stale";
    if (emitted === "unauthorized") {
      throw new Error("delivery binding is no longer authorized");
    }
    return "dispatched";
  } catch (error) {
    const state = await deps.inbox.markFailed(
      delivery.businessId,
      delivery.id,
      `event dispatch failed: ${messageOf(error)}`,
      {
        maxAttempts: MAX_NORMALIZATION_ATTEMPTS,
        backoffSeconds: retryDelaySeconds(delivery.attempts),
        now,
        ...fence,
      }
    );
    return state === null ? "stale" : state === "dead_letter" ? "dead_letter" : "retry";
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
