import type { SlackChannelAdapter, SlackReceiveResult } from "@tulipfarm/integrations";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { dispatchSlackEnvelope } from "./dispatch";

function log() {
  return { warn: vi.fn() };
}

function adapter(result: SlackReceiveResult): SlackChannelAdapter {
  return { receive: vi.fn().mockResolvedValue(result) } as unknown as SlackChannelAdapter;
}

describe("dispatchSlackEnvelope", () => {
  it("routes an events_api envelope to the channel adapter with an already-acked no-op ack", async () => {
    const channelAdapter = adapter({ outcome: "started", runId: "run-1" });

    await dispatchSlackEnvelope(
      { envelope_id: "env-1", type: "events_api", payload: { event: {} } },
      { businessId: "business-1", channelAdapter, log: log() }
    );

    expect(channelAdapter.receive).toHaveBeenCalledWith(
      "business-1",
      { event: {} },
      expect.any(Function)
    );
  });

  it("logs a denial reason without throwing", async () => {
    const channelAdapter = adapter({ outcome: "denied", reason: "external_identity_unmapped" });
    const logger = log();

    await dispatchSlackEnvelope(
      { envelope_id: "env-1", type: "events_api", payload: {} },
      { businessId: "business-1", channelAdapter, log: logger }
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("external_identity_unmapped"));
  });

  it("offers a bind link on an unmapped-sender denial, with the sender/channel/thread", async () => {
    const channelAdapter = adapter({ outcome: "denied", reason: "external_identity_unmapped" });
    const identityBindOffer = { offer: vi.fn().mockResolvedValue(undefined) };

    await dispatchSlackEnvelope(
      {
        envelope_id: "env-1",
        type: "events_api",
        payload: { event: { user: "U1", channel: "C1", thread_ts: "1.1" } },
      },
      { businessId: "business-1", channelAdapter, identityBindOffer, log: log() }
    );

    expect(identityBindOffer.offer).toHaveBeenCalledWith({
      provider: "slack",
      externalSubject: "U1",
      channelId: "C1",
      threadId: "1.1",
    });
  });

  it("does not offer a bind link for a denial reason other than unmapped identity", async () => {
    const channelAdapter = adapter({ outcome: "denied", reason: "some_other_reason" });
    const identityBindOffer = { offer: vi.fn().mockResolvedValue(undefined) };

    await dispatchSlackEnvelope(
      {
        envelope_id: "env-1",
        type: "events_api",
        payload: { event: { user: "U1", channel: "C1" } },
      },
      { businessId: "business-1", channelAdapter, identityBindOffer, log: log() }
    );

    expect(identityBindOffer.offer).not.toHaveBeenCalled();
  });

  it("swallows a channel adapter failure rather than crashing the dispatch loop", async () => {
    const channelAdapter = {
      receive: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as SlackChannelAdapter;
    const logger = log();

    await expect(
      dispatchSlackEnvelope(
        { envelope_id: "env-1", type: "events_api", payload: {} },
        { businessId: "business-1", channelAdapter, log: logger }
      )
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("routes an interactive envelope to onInteractive when provided", async () => {
    const onInteractive = vi.fn().mockResolvedValue(undefined);
    const channelAdapter = adapter({ outcome: "started" });

    await dispatchSlackEnvelope(
      { envelope_id: "env-2", type: "interactive", payload: { action: "approve" } },
      { businessId: "business-1", channelAdapter, onInteractive, log: log() }
    );

    expect(onInteractive).toHaveBeenCalledWith({ action: "approve" });
  });

  it("drops an interactive envelope silently when no handler is wired yet", async () => {
    const channelAdapter = adapter({ outcome: "started" });

    await expect(
      dispatchSlackEnvelope(
        { envelope_id: "env-2", type: "interactive", payload: {} },
        { businessId: "business-1", channelAdapter, log: log() }
      )
    ).resolves.toBeUndefined();
  });

  it("drops an events_api envelope the mention gate rejects, without reaching the adapter", async () => {
    const channelAdapter = adapter({ outcome: "started" });

    await dispatchSlackEnvelope(
      {
        envelope_id: "env-4",
        type: "events_api",
        payload: {
          type: "event_callback",
          event: { type: "message", channel: "C1", ts: "1.1", user: "U1" },
        },
      },
      {
        businessId: "business-1",
        channelAdapter,
        mentionGate: {
          businessId: "business-1",
          provider: "slack",
          mentionedThreads: {
            mark: vi.fn(),
            isMentioned: vi.fn().mockResolvedValue(false),
          } as unknown as ChannelMentionedThreadStore,
        },
        log: log(),
      }
    );

    expect(channelAdapter.receive).not.toHaveBeenCalled();
  });

  it("forwards the gate's (possibly rewritten) envelope to the adapter when it passes", async () => {
    const channelAdapter = adapter({ outcome: "started" });

    await dispatchSlackEnvelope(
      {
        envelope_id: "env-5",
        type: "events_api",
        payload: {
          type: "event_callback",
          event: { type: "app_mention", channel: "C1", ts: "1.1", user: "U1" },
        },
      },
      {
        businessId: "business-1",
        channelAdapter,
        mentionGate: {
          businessId: "business-1",
          provider: "slack",
          mentionedThreads: {
            mark: vi.fn().mockResolvedValue(undefined),
            isMentioned: vi.fn(),
          } as unknown as ChannelMentionedThreadStore,
        },
        log: log(),
      }
    );

    expect(channelAdapter.receive).toHaveBeenCalledWith(
      "business-1",
      expect.objectContaining({ event: expect.objectContaining({ type: "message" }) }),
      expect.any(Function)
    );
  });

  it("ignores an unrecognized envelope type", async () => {
    const channelAdapter = adapter({ outcome: "started" });

    await dispatchSlackEnvelope(
      { envelope_id: "env-3", type: "slash_commands", payload: {} },
      { businessId: "business-1", channelAdapter, log: log() }
    );

    expect(channelAdapter.receive).not.toHaveBeenCalled();
  });
});
