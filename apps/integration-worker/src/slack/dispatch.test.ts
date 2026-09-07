import type { SlackChannelAdapter, SlackReceiveResult } from "@tulipfarm/integrations";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { dispatchSlackEnvelope } from "./dispatch";

function log() {
  return { warn: vi.fn() };
}

function durability() {
  return {
    receipts: { accept: vi.fn().mockResolvedValue({ outcome: "accepted" }) },
    now: () => "2026-09-07T10:00:00.000Z",
  };
}

function adapter(result: SlackReceiveResult): SlackChannelAdapter {
  return { receive: vi.fn().mockResolvedValue(result) } as unknown as SlackChannelAdapter;
}

/** The gate is mandatory, so every events_api case needs one; `mentioned` opens the thread path. */
function gate(mentioned = true) {
  return {
    businessId: "business-1",
    provider: "slack",
    mentionedThreads: {
      mark: vi.fn().mockResolvedValue(undefined),
      isMentioned: vi.fn().mockResolvedValue(mentioned),
    } as unknown as ChannelMentionedThreadStore,
  };
}

const DM_EVENT = {
  type: "event_callback",
  event: { type: "message", channel_type: "im", channel: "D1", ts: "1.1", user: "U1" },
};

describe("dispatchSlackEnvelope", () => {
  it("acks a curated event only after its receipt and durable event are recorded", async () => {
    const order: string[] = [];
    const channelAdapter = adapter({ outcome: "started" });
    const onCuratedEvent = vi.fn(async () => {
      order.push("event");
    });
    const receipts = {
      accept: vi.fn(async () => {
        order.push("receipt");
        return { outcome: "accepted" as const };
      }),
    };

    await dispatchSlackEnvelope(
      {
        envelope_id: "env-event",
        type: "events_api",
        payload: {
          type: "event_callback",
          event: { type: "reaction_added" },
        },
      },
      {
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        receipts,
        now: () => "2026-09-07T10:00:00.000Z",
        onCuratedEvent,
        log: log(),
      },
      async () => {
        order.push("ack");
      }
    );

    expect(order).toEqual(["receipt", "event", "ack"]);
  });

  it("does not ack when curated event persistence fails", async () => {
    const ack = vi.fn();

    await expect(
      dispatchSlackEnvelope(
        {
          envelope_id: "env-event",
          type: "events_api",
          payload: {
            type: "event_callback",
            event: { type: "reaction_added" },
          },
        },
        {
          ...durability(),
          businessId: "business-1",
          channelAdapter: adapter({ outcome: "started" }),
          mentionGate: gate(),
          onCuratedEvent: vi.fn().mockRejectedValue(new Error("event store unavailable")),
          log: log(),
        },
        ack
      )
    ).rejects.toThrow("event store unavailable");

    expect(ack).not.toHaveBeenCalled();
  });

  it("does not ack or dispatch when receipt persistence fails", async () => {
    const ack = vi.fn();
    const onInteractive = vi.fn();
    const channelAdapter = adapter({ outcome: "started" });

    await expect(
      dispatchSlackEnvelope(
        { envelope_id: "env-2", type: "interactive", payload: { action: "approve" } },
        {
          businessId: "business-1",
          channelAdapter,
          mentionGate: gate(),
          receipts: { accept: vi.fn().mockRejectedValue(new Error("database unavailable")) },
          now: () => "2026-09-07T10:00:00.000Z",
          onInteractive,
          log: log(),
        },
        ack
      )
    ).rejects.toThrow("database unavailable");
    expect(ack).not.toHaveBeenCalled();
    expect(onInteractive).not.toHaveBeenCalled();
  });

  it("runs interactive provider follow-up after acknowledgement", async () => {
    const order: string[] = [];
    const channelAdapter = adapter({ outcome: "started" });
    const onInteractive = vi.fn(async () => {
      order.push("reserved");
      return async () => {
        order.push("follow-up");
      };
    });

    await dispatchSlackEnvelope(
      { envelope_id: "env-2", type: "interactive", payload: { action: "approve" } },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        onInteractive,
        log: log(),
      },
      async () => {
        order.push("ack");
      }
    );

    expect(order).toEqual(["reserved", "ack", "follow-up"]);
  });

  it("runs message provider follow-up only after the adapter acknowledges the Run", async () => {
    const order: string[] = [];
    const channelAdapter = {
      receive: vi.fn(async (_businessId, _event, ack: () => Promise<void>) => {
        order.push("reserved");
        await ack();
        order.push("adapter-returned");
        return { outcome: "started" as const, runId: "run-1" };
      }),
    } as unknown as SlackChannelAdapter;
    const onMessageReserved = vi.fn(async () => {
      order.push("follow-up");
    });

    await dispatchSlackEnvelope(
      { envelope_id: "env-1", type: "events_api", payload: DM_EVENT },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        onMessageReserved,
        log: log(),
      },
      async () => {
        order.push("ack");
      }
    );

    expect(order).toEqual(["reserved", "ack", "adapter-returned", "follow-up"]);
    expect(onMessageReserved).toHaveBeenCalledWith({ channelId: "D1", threadId: "1.1" });
  });

  it("does not repeat message provider follow-up for a duplicate Run", async () => {
    const channelAdapter = {
      receive: vi.fn(async (_businessId, _event, ack: () => Promise<void>) => {
        await ack();
        return { outcome: "duplicate" as const, runId: "run-1" };
      }),
    } as unknown as SlackChannelAdapter;
    const onMessageReserved = vi.fn();

    await dispatchSlackEnvelope(
      { envelope_id: "env-1", type: "events_api", payload: DM_EVENT },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        onMessageReserved,
        log: log(),
      },
      vi.fn()
    );

    expect(onMessageReserved).not.toHaveBeenCalled();
  });

  it("routes an events_api envelope to the channel adapter", async () => {
    const channelAdapter = adapter({ outcome: "started", runId: "run-1" });
    const onCuratedEvent = vi.fn();

    await dispatchSlackEnvelope(
      { envelope_id: "env-1", type: "events_api", payload: DM_EVENT },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        onCuratedEvent,
        log: log(),
      }
    );

    expect(channelAdapter.receive).toHaveBeenCalledWith(
      "business-1",
      DM_EVENT,
      expect.any(Function)
    );
    expect(onCuratedEvent).not.toHaveBeenCalled();
  });

  it("logs a denial reason without throwing", async () => {
    const channelAdapter = adapter({ outcome: "denied", reason: "external_identity_unmapped" });
    const logger = log();

    await dispatchSlackEnvelope(
      { envelope_id: "env-1", type: "events_api", payload: DM_EVENT },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        log: logger,
      }
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
        payload: {
          type: "event_callback",
          team_id: "T1",
          event: { type: "message", user: "U1", channel: "C1", ts: "1.2", thread_ts: "1.1" },
        },
      },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        identityBindOffer,
        log: log(),
      }
    );

    expect(identityBindOffer.offer).toHaveBeenCalledWith({
      provider: "slack",
      externalSubject: "U1",
      externalTenantId: "T1",
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
        payload: {
          type: "event_callback",
          event: { type: "message", channel_type: "im", user: "U1", channel: "D1", ts: "1.1" },
        },
      },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        identityBindOffer,
        log: log(),
      }
    );

    expect(identityBindOffer.offer).not.toHaveBeenCalled();
  });

  it("propagates a channel reservation failure so the transport can retry it", async () => {
    const channelAdapter = {
      receive: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as SlackChannelAdapter;
    const logger = log();

    await expect(
      dispatchSlackEnvelope(
        { envelope_id: "env-1", type: "events_api", payload: DM_EVENT },
        {
          ...durability(),
          businessId: "business-1",
          channelAdapter,
          mentionGate: gate(),
          log: logger,
        }
      )
    ).rejects.toThrow("boom");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("routes an interactive envelope to onInteractive when provided", async () => {
    const onInteractive = vi.fn().mockResolvedValue(undefined);
    const channelAdapter = adapter({ outcome: "started" });

    await dispatchSlackEnvelope(
      { envelope_id: "env-2", type: "interactive", payload: { action: "approve" } },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        onInteractive,
        log: log(),
      }
    );

    expect(onInteractive).toHaveBeenCalledWith({ action: "approve" });
  });

  it("drops an interactive envelope silently when no handler is wired yet", async () => {
    const channelAdapter = adapter({ outcome: "started" });

    await expect(
      dispatchSlackEnvelope(
        { envelope_id: "env-2", type: "interactive", payload: {} },
        {
          ...durability(),
          businessId: "business-1",
          channelAdapter,
          mentionGate: gate(),
          log: log(),
        }
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
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(false),
        log: log(),
      }
    );

    expect(channelAdapter.receive).not.toHaveBeenCalled();
  });

  it("routes app_home_opened without passing it through the mention gate", async () => {
    const order: string[] = [];
    const channelAdapter = adapter({ outcome: "started" });
    const mentionGate = gate();
    const onAppHomeOpened = vi.fn(async () => {
      order.push("home-job");
    });
    const onCuratedEvent = vi.fn(async () => {
      order.push("event");
    });

    await dispatchSlackEnvelope(
      {
        envelope_id: "env-home",
        type: "events_api",
        payload: {
          type: "event_callback",
          team_id: "T1",
          api_app_id: "A1",
          event: { type: "app_home_opened", user: "U1", tab: "home" },
        },
      },
      {
        receipts: {
          accept: vi.fn(async () => {
            order.push("receipt");
            return { outcome: "accepted" as const };
          }),
        },
        now: () => "2026-09-07T10:00:00.000Z",
        businessId: "business-1",
        channelAdapter,
        mentionGate,
        onAppHomeOpened,
        onCuratedEvent,
        log: log(),
      },
      async () => {
        order.push("ack");
      }
    );

    expect(order).toEqual(["receipt", "event", "home-job", "ack"]);
    expect(onAppHomeOpened).toHaveBeenCalledWith({
      externalTenantId: "T1",
      externalAppId: "A1",
      externalSubject: "U1",
      tab: "home",
    });
    expect(mentionGate.mentionedThreads.isMentioned).not.toHaveBeenCalled();
    expect(channelAdapter.receive).not.toHaveBeenCalled();
    expect(onCuratedEvent).toHaveBeenCalledOnce();
  });

  it("routes non-message events to the curated event publisher without using the mention gate", async () => {
    const channelAdapter = adapter({ outcome: "started" });
    const mentionGate = gate();
    const onCuratedEvent = vi.fn().mockResolvedValue(undefined);
    const payload = {
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      event_id: "Ev1",
      event_time: 1_785_000_000,
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "eyes",
        item: { type: "message", channel: "C1", ts: "1.1" },
      },
    };

    await dispatchSlackEnvelope(
      { envelope_id: "env-event", type: "events_api", payload },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate,
        onCuratedEvent,
        log: log(),
      }
    );

    expect(onCuratedEvent).toHaveBeenCalledWith(payload);
    expect(mentionGate.mentionedThreads.isMentioned).not.toHaveBeenCalled();
    expect(channelAdapter.receive).not.toHaveBeenCalled();
  });

  it("forwards the gate's (possibly rewritten) envelope to the adapter when it passes", async () => {
    const channelAdapter = adapter({ outcome: "started" });
    const onCuratedEvent = vi.fn();

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
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        onCuratedEvent,
        log: log(),
      }
    );

    expect(channelAdapter.receive).toHaveBeenCalledWith(
      "business-1",
      expect.objectContaining({ event: expect.objectContaining({ type: "message" }) }),
      expect.any(Function)
    );
    expect(onCuratedEvent).not.toHaveBeenCalled();
  });

  it("ignores an unrecognized envelope type", async () => {
    const channelAdapter = adapter({ outcome: "started" });

    await dispatchSlackEnvelope(
      { envelope_id: "env-3", type: "slash_commands", payload: {} },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        log: log(),
      }
    );

    expect(channelAdapter.receive).not.toHaveBeenCalled();
  });

  it("routes slash command envelopes to the typed command handler", async () => {
    const channelAdapter = adapter({ outcome: "started" });
    const onSlashCommand = vi.fn().mockResolvedValue(undefined);
    const payload = { command: "/tulipfarm", text: "Review the queue" };

    await dispatchSlackEnvelope(
      { envelope_id: "env-command", type: "slash_commands", payload },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter,
        mentionGate: gate(),
        onSlashCommand,
        log: log(),
      }
    );

    expect(onSlashCommand).toHaveBeenCalledWith(payload, "env-command");
  });

  it("runs slash command response delivery only after acknowledgement", async () => {
    const order: string[] = [];
    const onSlashCommand = vi.fn(async () => {
      order.push("reserved");
      return async () => {
        order.push("follow-up");
      };
    });

    await dispatchSlackEnvelope(
      {
        envelope_id: "env-command",
        type: "slash_commands",
        payload: { command: "/tulipfarm", text: "Review the queue" },
      },
      {
        ...durability(),
        businessId: "business-1",
        channelAdapter: adapter({ outcome: "started" }),
        mentionGate: gate(),
        onSlashCommand,
        log: log(),
      },
      async () => {
        order.push("ack");
      }
    );

    expect(order).toEqual(["reserved", "ack", "follow-up"]);
  });
});
