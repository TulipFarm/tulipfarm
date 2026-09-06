import type { ChannelRoutingSnapshot } from "../model";

export interface ChannelMediaReference {
  id: string;
  kind: "image" | "audio" | "video" | "document";
  contentType?: string;
  fileName?: string;
  sizeBytes?: number;
}

export interface ChannelInboundEvent {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  receivedAt: string;
  businessId: string;
  source: {
    provider: string;
    integrationId?: string;
    externalTenantId?: string;
    deliveryId?: string;
  };
  principal: { kind: "external"; externalId: string };
  record: { type: "message"; id: string };
  deduplicationKey: string;
  classification: string[];
  data: {
    externalAppId: string;
    channelId: string;
    threadId?: string;
    /**
     * The provider id of this very message, as opposed to `threadId`, which is the thread root.
     * The two are equal only for a top-level message; anything that must act on the message the
     * user actually sent — a reaction, most obviously — has to use this.
     */
    sourceMessageTs?: string;
    text: string;
    media: ChannelMediaReference[];
  };
  verification: { status: "verified"; method: string };
}

export interface ChannelInboundStore {
  /** Resolves only after the canonical inbox row and its outbox message commit. */
  accept(event: ChannelInboundEvent): Promise<{ outcome: "accepted" | "duplicate" }>;
}

export interface ChannelIdentityPort {
  /**
   * Resolve a verified external subject to its own Tulip principal or configured guest.
   * `undefined` is an unmapped denial; callers must never substitute another user.
   */
  resolve(input: { businessId: string; provider: string; externalSubject: string }): Promise<
    | {
        kind: "user" | "guest";
        id: string;
        /** Explicit grants/roles resolved for this principal; never inherited from a sponsor. */
        grantPrincipals?: { kind: string; id: string }[];
      }
    | undefined
  >;
}

export interface ChannelRoutingSource {
  load(input: {
    businessId: string;
    provider: string;
    externalTenantId: string;
  }): Promise<ChannelRoutingSnapshot>;
}

export interface ChannelRunStarter {
  start(input: {
    businessId: string;
    eventId: string;
    integrationId: string;
    routeId: string;
    agentId: string;
    principal: { kind: "user" | "guest"; id: string };
    message: ChannelInboundEvent["data"];
  }): Promise<{ runId: string; outcome: "started" | "duplicate" }>;
}

export type ChannelDeliveryStatus =
  | "pending"
  | "confirmed"
  | "retry_wait"
  | "ambiguous"
  | "failed"
  | "revoked";

export interface ChannelDeliveryAttempt {
  businessId: string;
  integrationId: string;
  routeId: string;
  idempotencyKey: string;
  provider: string;
  destination: string;
  agentId: string;
  principalId: string;
}

export interface ChannelDeliveryRecord extends ChannelDeliveryAttempt {
  status: ChannelDeliveryStatus;
  attempts: number;
  providerMessageId?: string;
}

export interface ChannelDeliveryLedger {
  begin(attempt: ChannelDeliveryAttempt): Promise<{
    outcome: "started" | "duplicate";
    record: ChannelDeliveryRecord;
  }>;
  complete(
    attempt: ChannelDeliveryAttempt,
    providerMessageId: string
  ): Promise<ChannelDeliveryRecord>;
  fail(
    attempt: ChannelDeliveryAttempt,
    outcome: {
      status: Exclude<ChannelDeliveryStatus, "pending" | "confirmed">;
      code: string;
      retryAfterMs?: number;
    }
  ): Promise<ChannelDeliveryRecord>;
}

export interface ChannelDeliveryAuthorizationPort {
  /** Re-evaluate current Integration/Route/Guardrail state on every delivery attempt. */
  authorize(input: {
    businessId: string;
    integrationId: string;
    routeId: string;
    agentId: string;
    principalId: string;
    destination: string;
  }): Promise<"allowed" | "revoked">;
}
