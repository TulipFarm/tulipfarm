import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  dispatchEventTrigger,
  type EventTriggerDispatch,
  type RegisteredTrigger,
  type RunInvocation,
} from "@tulipfarm/run-kernel";
import { event as eventSchema } from "@tulipfarm/schema";
import type { IntegrationEventPayload, ResourceSideEffect } from "@tulipfarm/storage";

/**
 * Turning an internally raised event into a Routine Run.
 *
 * Record mutations and Integration events are both raised inside this process, so both bind here
 * rather than in a consumer. `webhook` binds in its own route, because a webhook already names its
 * Trigger in the URL and matching could only make that binding ambiguous.
 */

export interface EventTriggerGatewayDeps {
  listTriggers(): Promise<readonly RegisteredTrigger[]>;
  startRun(invocation: RunInvocation): Promise<{ runId: string; outcome: "started" | "duplicate" }>;
  nextEventId: () => string;
  now?: () => string;
}

/** Events raised by this deployment about itself. Never a third party's provider name. */
const INTERNAL_PROVIDER = "tulipfarm";

/**
 * These events are minted inside the trust boundary, so they carry proof of that rather than
 * `unverified`. A Trigger asking for `requireVerified` is asking not to act on unattested
 * third-party input, which is exactly what an internal event is not.
 */
const INTERNAL_VERIFICATION = { status: "verified" as const, method: "internal" };

export const RESOURCE_EVENT_VERSION = 1;
export const INTEGRATION_EVENT_VERSION = 1;

const RESOURCE_EVENT_TYPES = {
  create: "resource.created",
  update: "resource.updated",
  delete: "resource.deleted",
} as const;

/** One event a Routine announced, before it is normalized into an envelope. */
export interface InternalEventInput {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly data: Record<string, unknown>;
  readonly emitterRunId: string;
  readonly principal: { readonly kind: string; readonly id: string };
}

export class EventTriggerGateway {
  constructor(private readonly deps: EventTriggerGatewayDeps) {}

  private timestamp(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  /**
   * Bind a Record mutation to any matching Trigger.
   *
   * `outboxId` is the deduplication key on purpose: it is the identity of the delivery attempt, so
   * a redelivered side effect binds to the Run it already made instead of a second one. Deriving a
   * key from the Record's content would instead collapse two genuinely repeated updates into one.
   */
  async dispatchResourceMutation(
    effect: ResourceSideEffect,
    outboxId: string
  ): Promise<EventTriggerDispatch> {
    const at = this.timestamp();
    const envelope = eventSchema.validateEventEnvelope<Record<string, unknown>>({
      eventId: this.deps.nextEventId(),
      type: RESOURCE_EVENT_TYPES[effect.kind],
      version: RESOURCE_EVENT_VERSION,
      occurredAt: at,
      receivedAt: at,
      businessId: DEPLOYMENT_BUSINESS_ID,
      source: { provider: INTERNAL_PROVIDER },
      principal:
        effect.actorId === undefined
          ? { kind: "service", internalId: "resource-outbox" }
          : { kind: "user", internalId: effect.actorId },
      record: { type: effect.resourceType, id: effect.resourceId },
      deduplicationKey: outboxId,
      classification: [],
      data: {
        resourceType: effect.resourceType,
        resourceId: effect.resourceId,
        record: effect.record,
        ...(effect.actorId === undefined ? {} : { actorId: effect.actorId }),
      },
      verification: INTERNAL_VERIFICATION,
    });
    return this.dispatch(envelope);
  }

  /** Bind a classified Integration event to any matching Trigger. */
  async dispatchIntegrationEvent(event: IntegrationEventPayload): Promise<EventTriggerDispatch> {
    const at = this.timestamp();
    const envelope = eventSchema.validateEventEnvelope<Record<string, unknown>>({
      eventId: event.eventId,
      type: event.event,
      version: INTEGRATION_EVENT_VERSION,
      occurredAt: at,
      receivedAt: at,
      businessId: DEPLOYMENT_BUSINESS_ID,
      source: { provider: event.integration },
      principal: { kind: "service", internalId: `integration:${event.integration}` },
      record: {},
      deduplicationKey: event.eventId,
      classification: [],
      data: {
        integration: event.integration,
        protocol: event.protocol,
        event: event.event,
        payload: event.payload,
      },
      verification: INTERNAL_VERIFICATION,
    });
    return this.dispatch(envelope);
  }

  /**
   * Bind an event a Routine's `emit` State raised to any matching Trigger.
   *
   * `causationId` names the emitting Run, so the started Run's lineage is readable from the
   * event alone as well as from the link the emit host writes.
   */
  async dispatchInternalEvent(event: InternalEventInput): Promise<EventTriggerDispatch> {
    const at = this.timestamp();
    const envelope = eventSchema.validateEventEnvelope<Record<string, unknown>>({
      eventId: event.eventId,
      type: event.eventType,
      version: event.eventVersion,
      occurredAt: at,
      receivedAt: at,
      businessId: DEPLOYMENT_BUSINESS_ID,
      source: { provider: INTERNAL_PROVIDER },
      principal: { kind: event.principal.kind, internalId: event.principal.id },
      record: {},
      deduplicationKey: event.eventId,
      causationId: event.emitterRunId,
      classification: [],
      data: event.data,
      verification: INTERNAL_VERIFICATION,
    });
    return this.dispatch(envelope);
  }

  private dispatch(
    envelope: eventSchema.EventEnvelope<Record<string, unknown>>
  ): Promise<EventTriggerDispatch> {
    return dispatchEventTrigger(envelope, {
      listTriggers: () => this.deps.listTriggers(),
      startRun: (invocation) => this.deps.startRun(invocation),
    });
  }
}
