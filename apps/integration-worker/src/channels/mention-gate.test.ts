import type { SlackEventEnvelope } from "@tulipfarm/integrations";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { applyMentionGate, type MentionGateDeps } from "./mention-gate";

function deps(overrides: Partial<MentionGateDeps> = {}): MentionGateDeps {
  return {
    businessId: "business-1",
    provider: "slack",
    mentionedThreads: {
      mark: vi.fn().mockResolvedValue(undefined),
      isMentioned: vi.fn().mockResolvedValue(false),
    } as unknown as ChannelMentionedThreadStore,
    ...overrides,
  };
}

function envelope(event: Record<string, unknown>): SlackEventEnvelope {
  return {
    token: "t",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event_time: 1720000000,
    type: "event_callback",
    // biome-ignore lint/suspicious/noExplicitAny: test builds a raw Slack payload shape
    event: event as any,
  };
}

describe("applyMentionGate", () => {
  it("always passes a DM", async () => {
    const gateDeps = deps();
    const result = await applyMentionGate(
      envelope({ type: "message", channel: "D1", channel_type: "im", ts: "1.1", user: "U1" }),
      gateDeps
    );
    expect(result.outcome).toBe("pass");
    expect(gateDeps.mentionedThreads.mark).not.toHaveBeenCalled();
  });

  it("passes an app_mention and marks its own ts as the mentioned thread when top-level", async () => {
    const gateDeps = deps();
    const result = await applyMentionGate(
      envelope({ type: "app_mention", channel: "C1", ts: "1.1", user: "U1" }),
      gateDeps
    );
    expect(result.outcome).toBe("pass");
    expect(gateDeps.mentionedThreads.mark).toHaveBeenCalledWith({
      businessId: "business-1",
      provider: "slack",
      channelId: "C1",
      threadId: "1.1",
    });
    if (result.outcome === "pass") {
      expect((result.envelope.event as { type: unknown }).type).toBe("message");
    }
  });

  it("marks the parent thread_ts, not its own ts, for an in-thread app_mention", async () => {
    const gateDeps = deps();
    await applyMentionGate(
      envelope({ type: "app_mention", channel: "C1", ts: "1.2", thread_ts: "1.1", user: "U1" }),
      gateDeps
    );
    expect(gateDeps.mentionedThreads.mark).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "1.1" })
    );
  });

  it("drops a top-level channel message with no mention", async () => {
    const gateDeps = deps();
    const result = await applyMentionGate(
      envelope({ type: "message", channel: "C1", ts: "1.1", user: "U1" }),
      gateDeps
    );
    expect(result).toEqual({ outcome: "drop", reason: "unmentioned_top_level" });
  });

  it("drops a threaded reply when its thread was never mentioned", async () => {
    const gateDeps = deps();
    const result = await applyMentionGate(
      envelope({ type: "message", channel: "C1", ts: "1.2", thread_ts: "1.1", user: "U1" }),
      gateDeps
    );
    expect(result).toEqual({ outcome: "drop", reason: "unmentioned_thread" });
  });

  it("passes a threaded reply when its thread was already mentioned", async () => {
    const gateDeps = deps({
      mentionedThreads: {
        mark: vi.fn(),
        isMentioned: vi.fn().mockResolvedValue(true),
      } as unknown as ChannelMentionedThreadStore,
    });
    const result = await applyMentionGate(
      envelope({ type: "message", channel: "C1", ts: "1.2", thread_ts: "1.1", user: "U1" }),
      gateDeps
    );
    expect(result.outcome).toBe("pass");
  });

  it("drops a bot's own message to prevent a reply loop", async () => {
    const gateDeps = deps();
    const result = await applyMentionGate(
      envelope({ type: "message", channel: "C1", ts: "1.1", bot_id: "B1" }),
      gateDeps
    );
    expect(result).toEqual({ outcome: "drop", reason: "bot_message" });
  });

  it("drops the duplicate plain-message delivery paired with a fresh top-level app_mention", async () => {
    const gateDeps = deps();
    // Slack delivers both `app_mention` and `message` for the same top-level @mention; the
    // `message` copy carries no thread_ts, so it is dropped as an unmentioned top-level message —
    // the `app_mention` copy is what answers it.
    const result = await applyMentionGate(
      envelope({ type: "message", channel: "C1", ts: "1.1", user: "U1" }),
      gateDeps
    );
    expect(result.outcome).toBe("drop");
  });
});
