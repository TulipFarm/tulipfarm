import {
  normalizeSlackEvent,
  type SlackEventsApiEnvelope,
  type SlackNormalizedEvent,
} from "@tulipfarm/integrations";
import type { PersistedRoutingSnapshot } from "@tulipfarm/storage";
import type { InternalApiClient } from "../internal/client";

export interface SlackEventPublisherDeps {
  readonly businessId: string;
  readonly integrations: {
    loadRoutingSnapshot(
      businessId: string,
      provider: string,
      externalTenantId: string
    ): Promise<PersistedRoutingSnapshot>;
  };
  readonly internalApi: InternalApiClient;
  readonly log: { warn: (message: string, error?: unknown) => void };
}

interface SlackEventResponse {
  outcome: "recorded" | "failed";
  eventId: string;
}

function activeIntegrationId(
  snapshot: PersistedRoutingSnapshot,
  externalAppId: string
): string | undefined {
  const app = snapshot.apps.find(
    (candidate) =>
      candidate.provider === "slack" &&
      candidate.externalAppId === externalAppId &&
      candidate.status === "active"
  );
  return snapshot.integrations.find(
    (candidate) => candidate.appId === app?.id && candidate.status === "active"
  )?.id;
}

function routingMetadata(input: unknown):
  | {
      externalTenantId: string;
      externalAppId: string;
      providerEventId: string;
      occurredAt?: string;
    }
  | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const envelope = input as Record<string, unknown>;
  const externalTenantId =
    typeof envelope.team_id === "string"
      ? envelope.team_id
      : typeof envelope.enterprise_id === "string"
        ? envelope.enterprise_id
        : undefined;
  if (
    externalTenantId === undefined ||
    typeof envelope.api_app_id !== "string" ||
    typeof envelope.event_id !== "string"
  ) {
    return undefined;
  }
  return {
    externalTenantId,
    externalAppId: envelope.api_app_id,
    providerEventId: envelope.event_id,
    ...(typeof envelope.event_time === "number" && Number.isFinite(envelope.event_time)
      ? { occurredAt: new Date(envelope.event_time * 1000).toISOString() }
      : {}),
  };
}

/** Validates and durably records curated events before Socket Mode acknowledgement. */
export class SlackEventPublisher {
  constructor(private readonly deps: SlackEventPublisherDeps) {}

  async publish(input: unknown): Promise<void> {
    const normalized = normalizeSlackEvent(input, { integrationId: "unresolved" });
    if (normalized.outcome === "unsupported") return;
    if (normalized.outcome === "validation_failed") {
      const metadata = routingMetadata(input);
      if (metadata !== undefined && normalized.eventType !== undefined) {
        const snapshot = await this.deps.integrations.loadRoutingSnapshot(
          this.deps.businessId,
          "slack",
          metadata.externalTenantId
        );
        const integrationId = activeIntegrationId(snapshot, metadata.externalAppId);
        if (integrationId !== undefined) {
          await this.deps.internalApi.require<SlackEventResponse>(
            "POST",
            "/api/v1/internal/slack/events",
            {
              externalAppId: metadata.externalAppId,
              failure: {
                integrationId,
                externalTenantId: metadata.externalTenantId,
                providerEventId: metadata.providerEventId,
                sourceEventType: normalized.eventType,
                ...(metadata.occurredAt === undefined ? {} : { occurredAt: metadata.occurredAt }),
                issues: normalized.issues,
              },
            }
          );
          this.deps.log.warn("slack curated event validation failed", {
            eventType: normalized.eventType,
            issues: normalized.issues,
          });
          return;
        }
      }
      throw new Error("slack_curated_event_validation_failure_not_persisted");
    }

    const envelope = input as SlackEventsApiEnvelope;
    const snapshot = await this.deps.integrations.loadRoutingSnapshot(
      this.deps.businessId,
      "slack",
      normalized.event.externalTenantId
    );
    const integrationId = activeIntegrationId(snapshot, envelope.api_app_id);
    if (integrationId === undefined) {
      this.deps.log.warn("slack curated event binding is not active");
      return;
    }

    const event: SlackNormalizedEvent = { ...normalized.event, integrationId };
    await this.deps.internalApi.require<SlackEventResponse>(
      "POST",
      "/api/v1/internal/slack/events",
      { externalAppId: envelope.api_app_id, event }
    );
  }
}
