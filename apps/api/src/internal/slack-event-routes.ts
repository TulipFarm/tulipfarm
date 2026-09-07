import type { EventEmitter } from "node:events";
import type { SlackNormalizedEvent } from "@tulipfarm/integrations";
import {
  DOMAIN_EVENTS,
  type EventStore,
  type PersistedRoutingSnapshot,
  type StoreEventInput,
} from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { ChannelSenderResolution } from "../ingress/identity";
import type {
  ClassifiedIntegrationEventPayload,
  EventTriggerGateway,
} from "../triggers/event-dispatch";
import {
  SlackEventBodySchema,
  SlackEventDispatchParamsSchema,
  SlackEventDispatchResponseSchema,
  SlackEventResponseSchema,
} from "./slack-event-schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SlackEventRouteDeps {
  readonly businessId: string;
  readonly integrations: {
    loadRoutingSnapshot(
      businessId: string,
      provider: string,
      externalTenantId: string
    ): Promise<PersistedRoutingSnapshot>;
  };
  readonly identity: {
    resolve(input: {
      slug: string;
      sender: string;
      externalTenantId: string;
    }): Promise<ChannelSenderResolution>;
  };
  readonly events: Pick<EventStore, "accept" | "find">;
  readonly eventTriggers: Pick<EventTriggerGateway, "dispatchIntegrationEvent">;
  readonly domainEvents?: EventEmitter;
  readonly now?: () => string;
}

type SlackEventBody =
  | { externalAppId: string; event: SlackNormalizedEvent }
  | {
      externalAppId: string;
      failure: {
        integrationId: string;
        externalTenantId: string;
        providerEventId: string;
        sourceEventType: string;
        occurredAt?: string;
        issues: readonly { path: string; keyword: string; message: string }[];
      };
    };

const HOST_SIGNAL_EVENTS = new Set([
  "slack.home.opened.v1",
  "slack.agent.thread.started.v1",
  "slack.agent.context.changed.v1",
]);

function activeBinding(snapshot: PersistedRoutingSnapshot, body: SlackEventBody): boolean {
  const subject = "event" in body ? body.event : body.failure;
  const integration = snapshot.integrations.find(
    (candidate) =>
      candidate.id === subject.integrationId &&
      candidate.externalTenantId === subject.externalTenantId &&
      candidate.status === "active"
  );
  return snapshot.apps.some(
    (app) =>
      app.id === integration?.appId &&
      app.provider === "slack" &&
      app.externalAppId === body.externalAppId &&
      app.status === "active"
  );
}

function activeDispatchBinding(
  snapshot: PersistedRoutingSnapshot,
  businessId: string,
  integrationId: string,
  externalTenantId: string
): boolean {
  const integration = snapshot.integrations.find(
    (candidate) =>
      candidate.id === integrationId &&
      candidate.businessId === businessId &&
      candidate.externalTenantId === externalTenantId &&
      candidate.status === "active"
  );
  return snapshot.apps.some(
    (app) =>
      app.id === integration?.appId &&
      app.businessId === businessId &&
      app.provider === "slack" &&
      app.status === "active"
  );
}

function payloadRecord(payload: Record<string, unknown>): { type?: string; id?: string } {
  const candidates = [
    ["message", payload.messageId],
    ["file", payload.fileId],
    ["conversation", payload.conversationId],
    ["user", payload.subjectExternalId],
    ["emoji", payload.emojiName],
  ] as const;
  const record = candidates.find((candidate) => typeof candidate[1] === "string");
  return record === undefined ? {} : { type: record[0], id: record[1] as string };
}

function externalActor(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.actorExternalId === "string") return payload.actorExternalId;
  return typeof payload.creatorExternalId === "string" ? payload.creatorExternalId : undefined;
}

function validationFailureEnvelope(
  businessId: string,
  failure: Extract<SlackEventBody, { failure: unknown }>["failure"],
  receivedAt: string
): StoreEventInput {
  return {
    eventId: failure.providerEventId,
    type: "slack.inbound.validation_failed.v1",
    version: 1,
    occurredAt: failure.occurredAt ?? receivedAt,
    receivedAt,
    businessId,
    source: {
      provider: "slack",
      integrationId: failure.integrationId,
      externalTenantId: failure.externalTenantId,
      deliveryId: failure.providerEventId,
    },
    principal: { kind: "service", internalId: "integration:slack" },
    record: {},
    deduplicationKey: failure.providerEventId,
    classification: ["untrusted.external"],
    data: { outcome: "validation_failed", ...failure },
    verification: { status: "failed", method: "slack_socket_mode" },
  };
}

export function registerSlackEventRoutes(
  app: FastifyInstance,
  deps: SlackEventRouteDeps,
  requireAuth: PreHandler
): void {
  const requireService: PreHandler = async (req, reply) => {
    if (req.principal?.kind !== "service") {
      await reply.code(403).send({ error: "internal Slack event host is service-only" });
    }
  };

  app.post(
    "/api/v1/internal/slack/events",
    {
      preHandler: [requireAuth, requireService],
      schema: {
        description: "Persist one validated, normalized Slack event for durable dispatch.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        body: SlackEventBodySchema,
        response: {
          200: SlackEventResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as SlackEventBody;
      const subject = "event" in body ? body.event : body.failure;
      const snapshot = await deps.integrations.loadRoutingSnapshot(
        deps.businessId,
        "slack",
        subject.externalTenantId
      );
      if (!activeBinding(snapshot, body)) {
        return reply.code(404).send({ error: "Slack Integration is not active" });
      }

      if ("failure" in body) {
        const accepted = await deps.events.accept(
          validationFailureEnvelope(
            deps.businessId,
            body.failure,
            (deps.now ?? (() => new Date().toISOString()))()
          )
        );
        return reply.send({ outcome: "failed", eventId: accepted.event.id });
      }

      const untrustedPayload = body.event.untrustedPayload as Record<string, unknown>;
      const actorExternalId = externalActor(untrustedPayload);
      const resolution =
        actorExternalId === undefined
          ? undefined
          : await deps.identity.resolve({
              slug: "slack",
              sender: actorExternalId,
              externalTenantId: body.event.externalTenantId,
            });
      const actor =
        resolution?.outcome === "linked"
          ? {
              kind: resolution.principalKind,
              id: resolution.principalId,
              externalId: actorExternalId as string,
            }
          : undefined;
      const { actorPrincipalId: _untrustedActorPrincipalId, ...providerEvent } = body.event;
      const normalizedEvent = {
        ...providerEvent,
        ...(actor === undefined ? {} : { actorPrincipalId: actor.id }),
      };
      const accepted = await deps.events.accept({
        eventId: normalizedEvent.providerEventId,
        type: normalizedEvent.name,
        version: normalizedEvent.version,
        occurredAt: normalizedEvent.occurredAt,
        receivedAt: (deps.now ?? (() => new Date().toISOString()))(),
        businessId: deps.businessId,
        source: {
          provider: "slack",
          integrationId: normalizedEvent.integrationId,
          externalTenantId: normalizedEvent.externalTenantId,
          deliveryId: normalizedEvent.providerEventId,
        },
        principal:
          actor === undefined
            ? { kind: "service", internalId: "integration:slack" }
            : { kind: actor.kind, internalId: actor.id, externalId: actor.externalId },
        record: payloadRecord(untrustedPayload),
        classification: [...normalizedEvent.classification],
        verification: { status: "verified", method: "slack_socket_mode" },
        deduplicationKey: normalizedEvent.deduplicationKey,
        data: normalizedEvent,
      });
      return reply.send({ outcome: "recorded", eventId: accepted.event.id });
    }
  );

  app.post(
    "/api/v1/internal/slack/events/:eventId/dispatch",
    {
      preHandler: [requireAuth, requireService],
      schema: {
        description: "Dispatch one durable Slack event inbox record through the Trigger gateway.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        params: SlackEventDispatchParamsSchema,
        response: {
          200: SlackEventDispatchResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { eventId } = req.params as { eventId: string };
      const stored = await deps.events.find(deps.businessId, eventId);
      if (stored === null) return reply.code(404).send({ error: "Slack event not found" });

      const envelope = stored.canonicalEvent;
      if (
        envelope.source.provider !== "slack" ||
        envelope.verification.status !== "verified" ||
        envelope.type === "slack.inbound.validation_failed.v1"
      ) {
        return reply.send({ outcome: "ignored" });
      }

      const principalKind = envelope.principal.kind;
      const actor: ClassifiedIntegrationEventPayload["actor"] =
        (principalKind === "user" || principalKind === "guest") &&
        envelope.principal.internalId !== undefined &&
        envelope.principal.externalId !== undefined
          ? {
              kind: principalKind,
              id: envelope.principal.internalId,
              externalId: envelope.principal.externalId,
            }
          : undefined;
      const emitted: ClassifiedIntegrationEventPayload = {
        integration: "slack",
        protocol: "slack_socket_mode",
        event: envelope.type,
        eventId: stored.id,
        payload: envelope.data,
        occurredAt: envelope.occurredAt,
        ...(envelope.source.integrationId === undefined
          ? {}
          : { integrationId: envelope.source.integrationId }),
        ...(envelope.source.externalTenantId === undefined
          ? {}
          : { externalTenantId: envelope.source.externalTenantId }),
        ...(actor === undefined ? {} : { actor }),
        record: envelope.record,
        classification: envelope.classification,
        verification: envelope.verification,
      };
      if (emitted.integrationId === undefined || emitted.externalTenantId === undefined) {
        return reply.send({ outcome: "ignored" });
      }
      const snapshot = await deps.integrations.loadRoutingSnapshot(
        deps.businessId,
        "slack",
        emitted.externalTenantId
      );
      if (
        !activeDispatchBinding(
          snapshot,
          deps.businessId,
          emitted.integrationId,
          emitted.externalTenantId
        )
      ) {
        return reply.send({ outcome: "ignored" });
      }
      deps.domainEvents?.emit(DOMAIN_EVENTS.INTEGRATION_EVENT, emitted);
      if (!HOST_SIGNAL_EVENTS.has(envelope.type)) {
        await deps.eventTriggers.dispatchIntegrationEvent(emitted);
      }
      return reply.send({ outcome: "dispatched" });
    }
  );
}
