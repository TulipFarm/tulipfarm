import type { SlackChannelAdapter, SlackEventEnvelope } from "@tulipfarm/integrations";
import type { ChannelInboundStore } from "@tulipfarm/storage";
import type { ChannelIdentityBindOfferPort } from "../channels/identity-port";
import type { SlackDeferredWork } from "../channels/interactive-handler";
import type { MentionGateDeps } from "../channels/mention-gate";
import { applyMentionGate } from "../channels/mention-gate";
import type { SlackSocketEnvelope } from "./socket-transport";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface SlackDispatchDeps {
  businessId: string;
  channelAdapter: SlackChannelAdapter;
  /** Required: without it every subscribed DM/channel message would reach the adapter (#508). */
  mentionGate: MentionGateDeps;
  receipts: Pick<ChannelInboundStore, "accept">;
  now: () => string;
  /** Optional bind-link offer for `external_identity_unmapped` denials. */
  identityBindOffer?: ChannelIdentityBindOfferPort;
  /** Reserves an interaction and returns provider follow-up that is safe to run after ack. */
  onInteractive?: (payload: unknown) => Promise<SlackDeferredWork | undefined>;
  /** Reserves command work and returns provider follow-up that is safe to run after ack. */
  onSlashCommand?: (payload: unknown, envelopeId: string) => Promise<SlackDeferredWork | undefined>;
  /** Optional App Home refresh handler; omitted until Home publishing is configured. */
  onAppHomeOpened?: (event: SlackAppHomeOpenedEvent) => Promise<void>;
  /** Curated non-message Event API publisher; unknown events are ignored by the publisher. */
  onCuratedEvent?: (payload: unknown) => Promise<void>;
  /** Provider-only status update that runs after a fresh message Run is acknowledged. */
  onMessageReserved?: (message: { channelId: string; threadId: string }) => Promise<void>;
  log: { warn: (message: string, error?: unknown) => void };
}

export interface SlackAppHomeOpenedEvent {
  readonly integrationId?: string;
  readonly externalTenantId: string;
  readonly externalAppId?: string;
  readonly externalSubject: string;
  readonly tab: "home" | "messages";
}

export async function reserveSlackEnvelopeReceipt(
  envelope: SlackSocketEnvelope,
  deps: Pick<SlackDispatchDeps, "businessId" | "receipts" | "now">
): Promise<void> {
  await deps.receipts.accept({
    businessId: deps.businessId,
    provider: "slack",
    eventId: envelope.envelope_id,
    deduplicationKey: `socket:${envelope.envelope_id}`,
    receivedAt: deps.now(),
  });
}

/** Reserves durable work, acknowledges it, then performs non-durable provider follow-up. */
export async function dispatchSlackEnvelope(
  envelope: SlackSocketEnvelope,
  deps: SlackDispatchDeps,
  ack: () => Promise<void> = async () => {}
): Promise<void> {
  await reserveSlackEnvelopeReceipt(envelope, deps);

  if (envelope.type === "events_api") {
    const rawEvent = envelope.payload as SlackEventEnvelope;
    if (rawEvent.event?.type === "app_home_opened") {
      await deps.onCuratedEvent?.(envelope.payload);
      const homeEvent = rawEvent.event as unknown as Record<string, unknown>;
      const user = optionalString(homeEvent.user);
      const tab = homeEvent.tab;
      if (
        deps.onAppHomeOpened !== undefined &&
        user !== undefined &&
        optionalString((rawEvent as unknown as Record<string, unknown>).team_id) !== undefined &&
        (tab === "home" || tab === "messages")
      ) {
        await deps.onAppHomeOpened({
          externalTenantId: optionalString(
            (rawEvent as unknown as Record<string, unknown>).team_id
          ) as string,
          externalAppId: optionalString(
            (rawEvent as unknown as Record<string, unknown>).api_app_id
          ),
          externalSubject: user,
          tab,
        });
      }
      await ack();
      return;
    }
    if (rawEvent.event?.type !== "message" && rawEvent.event?.type !== "app_mention") {
      await deps.onCuratedEvent?.(envelope.payload);
      await ack();
      return;
    }
    const gate = await applyMentionGate(rawEvent, deps.mentionGate);
    if (gate.outcome === "drop") {
      await ack();
      return;
    }
    const gated = gate.envelope;
    const result = await deps.channelAdapter.receive(deps.businessId, gated, ack);
    if (result.outcome === "started" && deps.onMessageReserved !== undefined) {
      const channelId = optionalString(gated.event?.channel);
      const threadId = optionalString(gated.event?.thread_ts) ?? optionalString(gated.event?.ts);
      if (channelId !== undefined && threadId !== undefined) {
        await deps.onMessageReserved({ channelId, threadId });
      }
    }
    if (result.outcome === "denied") {
      deps.log.warn(`slack event denied: ${result.reason}`);
      if (result.reason === "external_identity_unmapped" && deps.identityBindOffer !== undefined) {
        const event = gated.event;
        const user = optionalString(event?.user);
        const channel = optionalString(event?.channel);
        if (user !== undefined && channel !== undefined) {
          await deps.identityBindOffer.offer({
            provider: "slack",
            externalSubject: user,
            externalTenantId: requiredTenantId(gated),
            channelId: channel,
            ...(optionalString(event?.thread_ts) === undefined
              ? {}
              : { threadId: optionalString(event?.thread_ts) }),
          });
        }
      }
    }
    return;
  }

  if (envelope.type === "interactive") {
    const followUp = await deps.onInteractive?.(envelope.payload);
    await ack();
    await followUp?.();
    return;
  }

  if (envelope.type === "slash_commands") {
    const followUp = await deps.onSlashCommand?.(envelope.payload, envelope.envelope_id);
    await ack();
    await followUp?.();
    return;
  }

  await ack();

  function requiredTenantId(eventEnvelope: SlackEventEnvelope): string {
    const tenantId = optionalString(eventEnvelope.team_id);
    if (tenantId === undefined) throw new Error("slack_event_rejected:missing_tenant");
    return tenantId;
  }
}
