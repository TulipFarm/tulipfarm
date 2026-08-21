import type { SlackChannelAdapter, SlackEventEnvelope } from "@tulipfarm/integrations";
import type { ChannelIdentityBindOfferPort } from "../channels/identity-port";
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
  /** Optional bind-link offer for `external_identity_unmapped` denials. */
  identityBindOffer?: ChannelIdentityBindOfferPort;
  /** Optional Approve/Deny block-action handler; Slack interactive envelopes are already acked. */
  onInteractive?: (payload: unknown) => Promise<void>;
  log: { warn: (message: string, error?: unknown) => void };
}

/** Routes one already-acked Socket Mode envelope; unsupported envelope types are dropped. */
export async function dispatchSlackEnvelope(
  envelope: SlackSocketEnvelope,
  deps: SlackDispatchDeps
): Promise<void> {
  if (envelope.type === "events_api") {
    try {
      const rawEvent = envelope.payload as SlackEventEnvelope;
      const gate = await applyMentionGate(rawEvent, deps.mentionGate);
      if (gate.outcome === "drop") return;
      const gated = gate.envelope;
      const result = await deps.channelAdapter.receive(deps.businessId, gated, async () => {
        // Already acked at the transport layer before dispatch ran.
      });
      if (result.outcome === "denied") {
        deps.log.warn(`slack event denied: ${result.reason}`);
        if (
          result.reason === "external_identity_unmapped" &&
          deps.identityBindOffer !== undefined
        ) {
          const event = gated.event;
          const user = optionalString(event?.user);
          const channel = optionalString(event?.channel);
          if (user !== undefined && channel !== undefined) {
            await deps.identityBindOffer.offer({
              provider: "slack",
              externalSubject: user,
              channelId: channel,
              ...(optionalString(event?.thread_ts) === undefined
                ? {}
                : { threadId: optionalString(event?.thread_ts) }),
            });
          }
        }
      }
    } catch (error) {
      deps.log.warn("slack events_api dispatch failed", error);
    }
    return;
  }

  if (envelope.type === "interactive") {
    if (deps.onInteractive === undefined) return;
    try {
      await deps.onInteractive(envelope.payload);
    } catch (error) {
      deps.log.warn("slack interactive dispatch failed", error);
    }
  }
}
