import { describe, expect, it } from "vitest";
import { classifySlackPayload, type SlackClassifyContext, stripBotMention } from "./slack-adapter";

const BOT = "UBOT";

function ctx(overrides: Partial<SlackClassifyContext> = {}): SlackClassifyContext {
  return {
    botUserId: BOT,
    hasThreadMapping: async () => false,
    ...overrides,
  };
}

function envelope(event: Record<string, unknown>): Record<string, unknown> {
  return { type: "event_callback", team_id: "T1", event_id: "Ev1", event };
}

describe("classifySlackPayload", () => {
  it("classifies an app_mention as chat with the mention stripped", async () => {
    const decision = await classifySlackPayload(
      envelope({
        type: "app_mention",
        user: "U1",
        channel: "C1",
        ts: "100.1",
        text: `<@${BOT}> summarize today`,
      }),
      ctx()
    );
    expect(decision).toEqual({
      kind: "chat",
      msg: {
        teamId: "T1",
        channel: "C1",
        threadTs: "100.1",
        isDm: false,
        slackUserId: "U1",
        text: "summarize today",
      },
    });
  });

  it("keeps thread_ts as the mapping key for a threaded mention", async () => {
    const decision = await classifySlackPayload(
      envelope({
        type: "app_mention",
        user: "U1",
        channel: "C1",
        ts: "200.2",
        thread_ts: "100.1",
        text: `<@${BOT}> and this?`,
      }),
      ctx()
    );
    expect(decision.kind).toBe("chat");
    if (decision.kind === "chat") expect(decision.msg.threadTs).toBe("100.1");
  });

  it("classifies a DM as chat (isDm, unthreaded reply)", async () => {
    const decision = await classifySlackPayload(
      envelope({
        type: "message",
        channel_type: "im",
        user: "U1",
        channel: "D1",
        ts: "1.1",
        text: "hi",
      }),
      ctx()
    );
    expect(decision.kind).toBe("chat");
    if (decision.kind === "chat") {
      expect(decision.msg.isDm).toBe(true);
      expect(decision.msg.text).toBe("hi");
    }
  });

  it("ignores the bot's own messages and other bots' messages", async () => {
    const own = await classifySlackPayload(
      envelope({ type: "message", channel_type: "im", user: BOT, channel: "D1", ts: "1.1" }),
      ctx()
    );
    expect(own.kind).toBe("ignore");
    const other = await classifySlackPayload(
      envelope({ type: "message", bot_id: "B99", channel: "C1", ts: "1.2", text: "beep" }),
      ctx()
    );
    expect(other.kind).toBe("ignore");
  });

  it("ignores subtyped messages (edits, joins, bot_message)", async () => {
    const decision = await classifySlackPayload(
      envelope({ type: "message", subtype: "message_changed", channel: "C1", user: "U1" }),
      ctx()
    );
    expect(decision.kind).toBe("ignore");
  });

  it("ignores a channel message containing the mention (paired app_mention handles it)", async () => {
    const decision = await classifySlackPayload(
      envelope({
        type: "message",
        user: "U1",
        channel: "C1",
        ts: "5.5",
        text: `<@${BOT}> hello`,
      }),
      ctx()
    );
    expect(decision).toEqual({ kind: "ignore", reason: "mention handled by paired app_mention" });
  });

  it("follows a thread with an existing conversation mapping (no fresh mention)", async () => {
    const decision = await classifySlackPayload(
      envelope({
        type: "message",
        user: "U1",
        channel: "C1",
        ts: "300.3",
        thread_ts: "100.1",
        text: "follow-up question",
      }),
      ctx({
        hasThreadMapping: async (team, channel, threadTs) =>
          threadTs === "100.1" && channel === "C1" && team === "T1",
      })
    );
    expect(decision.kind).toBe("chat");
    if (decision.kind === "chat") expect(decision.msg.threadTs).toBe("100.1");
  });

  it("follows a thread rooted on a bot message via parent_user_id", async () => {
    const decision = await classifySlackPayload(
      envelope({
        type: "message",
        user: "U1",
        channel: "C1",
        ts: "300.3",
        thread_ts: "250.0",
        parent_user_id: BOT,
        text: "replying to the bot",
      }),
      ctx()
    );
    expect(decision.kind).toBe("chat");
  });

  it("ignores unthreaded channel chatter and unmapped threads", async () => {
    const plain = await classifySlackPayload(
      envelope({ type: "message", user: "U1", channel: "C1", ts: "9.9", text: "random chatter" }),
      ctx()
    );
    expect(plain.kind).toBe("ignore");
    const unmapped = await classifySlackPayload(
      envelope({
        type: "message",
        user: "U1",
        channel: "C1",
        ts: "10.1",
        thread_ts: "8.8",
        text: "thread the bot is not in",
      }),
      ctx()
    );
    expect(unmapped.kind).toBe("ignore");
  });

  it("classifies non-message events as webhook-kind events", async () => {
    const decision = await classifySlackPayload(
      envelope({ type: "member_joined_channel", user: "U1", channel: "C1" }),
      ctx()
    );
    expect(decision.kind).toBe("event");
    if (decision.kind === "event") {
      expect(decision.eventType).toBe("member_joined_channel");
      expect(decision.payload.channel).toBe("C1");
    }
  });

  it("never turns message events into webhook-kind events", async () => {
    const decision = await classifySlackPayload(
      envelope({ type: "message", user: "U1", channel: "C1", ts: "1.1", text: "hello" }),
      ctx()
    );
    expect(decision.kind).toBe("ignore");
  });

  it("ignores non-event_callback payloads and works with a null botUserId", async () => {
    expect((await classifySlackPayload({ type: "url_verification" }, ctx())).kind).toBe("ignore");
    const dm = await classifySlackPayload(
      envelope({
        type: "message",
        channel_type: "im",
        user: "U1",
        channel: "D1",
        ts: "1.1",
        text: "hi",
      }),
      ctx({ botUserId: null })
    );
    expect(dm.kind).toBe("chat");
  });
});

describe("stripBotMention", () => {
  it("strips mention tokens and collapses whitespace", () => {
    expect(stripBotMention(`<@${BOT}>  what is  up`, BOT)).toBe("what is up");
    expect(stripBotMention("no mention here", BOT)).toBe("no mention here");
    expect(stripBotMention(`hey <@${BOT}> check this`, BOT)).toBe("hey check this");
    expect(stripBotMention("  trimmed  ", null)).toBe("trimmed");
  });
});
