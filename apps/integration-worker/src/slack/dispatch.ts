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
  /**
   * Filters an `events_api` envelope before it reaches `channelAdapter.receive()` (plan §8).
   * Undefined skips gating entirely — every DM and channel message would then reach the adapter,
   * which is only ever intentional in narrow adapter-focused tests.
   */
  mentionGate?: MentionGateDeps;
  /**
   * Answers an unmapped sender with a bind link instead of silence, on `external_identity_unmapped`
   * denials only. Undefined skips the offer — the denial is still logged as before.
   */
  identityBindOffer?: ChannelIdentityBindOfferPort;
  /**
   * Handles a `block_actions` interactive payload (Approve/Deny clicks). Undefined until the
   * interactive Block Kit approvals piece lands — an interactive envelope is still acked (Slack
   * requires that within its 3s window regardless), just dropped with nothing further done.
   */
  onInteractive?: (payload: unknown) => Promise<void>;
  log: { warn: (message: string, error?: unknown) => void };
}

/**
 * Routes one already-acked Socket Mode envelope (the transport, `socket-transport.ts`, acks
 * before this ever runs) to the inbound-message path or the interactive-action path. Anything
 * else — `slash_commands`, unrecognized types — is dropped; Socket Mode only subscribes this app
 * to `events_api` and `interactive` today.
 */
export async function dispatchSlackEnvelope(
  envelope: SlackSocketEnvelope,
  deps: SlackDispatchDeps
): Promise<void> {
  if (envelope.type === "events_api") {
    try {
      const rawEvent = envelope.payload as SlackEventEnvelope;
      let gated = rawEvent;
      if (deps.mentionGate !== undefined) {
        const gate = await applyMentionGate(rawEvent, deps.mentionGate);
        if (gate.outcome === "drop") return;
        gated = gate.envelope;
      }
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
