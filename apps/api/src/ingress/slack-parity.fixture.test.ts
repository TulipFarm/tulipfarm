import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeHook } from "../hooks/hook-analyzer";
import { HookExecutor } from "../hooks/hook-executor";
import { type IngressDecision, parseDecision } from "./service";

/*
 * Parity guard for the REFERENCE integration: runs a vendored copy of the integrations repo's
 * slack/ingress.ts (__fixtures__/slack-ingress.hook.txt) through the real isolated-vm sandbox
 * and asserts the full classification matrix the old built-in adapter enforced. The fixture is
 * TEST DATA, not shipped code — keep it byte-identical to TulipFarm/integrations slack/ingress.ts.
 */

// isolated-vm has no abi141 prebuild (same caveat as hooks/routine-sandbox.test.ts).
const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
const skipNoIsovm = nodeMajor === 25;

const FAKE_DATABASE_URL = "postgresql://localhost:5432/test";
const BOT = "UBOT";

let source: string;
let executor: HookExecutor;

beforeAll(async () => {
  source = await readFile(
    join(import.meta.dirname, "__fixtures__", "slack-ingress.hook.txt"),
    "utf8"
  );
  executor = new HookExecutor(FAKE_DATABASE_URL);
  return async () => {
    await executor.close();
  };
});

function envelope(
  event: Record<string, unknown>,
  opts: { bot?: string | null } = {}
): Record<string, unknown> {
  const bot = opts.bot === undefined ? BOT : opts.bot;
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    ...(bot ? { authorizations: [{ user_id: bot, is_bot: true }] } : {}),
    event,
  };
}

async function classify(
  body: Record<string, unknown>,
  hasThreadMapping = false
): Promise<IngressDecision | null> {
  const raw = await executor.runRoutineHook(
    source,
    "classify",
    { body, hasThreadMapping },
    null,
    "ingress:slack-parity"
  );
  return parseDecision(raw);
}

describe("slack ingress.ts parity (real sandbox)", () => {
  it("passes the sandbox's static analysis", () => {
    expect(() => analyzeHook(source)).not.toThrow();
  });

  it.skipIf(skipNoIsovm)("app_mention → chat in-thread with the mention stripped", async () => {
    const d = await classify(
      envelope({
        type: "app_mention",
        user: "U1",
        channel: "C1",
        ts: "100.1",
        text: `<@${BOT}> summarize this`,
      })
    );
    expect(d).toEqual({
      kind: "chat",
      sender: "U1",
      text: "summarize this",
      requireExistingThread: false,
      reply: { binding: "thread", vars: { channel: "C1", thread: "100.1" } },
    });
  });

  it.skipIf(skipNoIsovm)("app_mention inside a thread keeps the thread root", async () => {
    const d = await classify(
      envelope({
        type: "app_mention",
        user: "U1",
        channel: "C1",
        ts: "200.2",
        thread_ts: "100.1",
        text: `<@${BOT}> and this`,
      })
    );
    expect(d).toMatchObject({ reply: { vars: { thread: "100.1" } } });
  });

  it.skipIf(skipNoIsovm)("DM → chat with the unthreaded default binding", async () => {
    const d = await classify(
      envelope({
        type: "message",
        channel_type: "im",
        user: "U1",
        channel: "D1",
        ts: "1.1",
        text: "hello",
      })
    );
    expect(d).toEqual({
      kind: "chat",
      sender: "U1",
      text: "hello",
      requireExistingThread: false,
      reply: { binding: "default", vars: { channel: "D1" } },
    });
  });

  it.skipIf(skipNoIsovm)("ignores bot messages, own messages, and subtyped messages", async () => {
    const cases = [
      envelope({ type: "message", bot_id: "B9", channel: "C1", ts: "1.1", text: "hi" }),
      envelope({ type: "message", user: BOT, channel: "C1", ts: "1.1", text: "hi" }),
      envelope({
        type: "message",
        subtype: "message_changed",
        user: "U1",
        channel: "C1",
        ts: "1.1",
      }),
    ];
    for (const body of cases) {
      expect(await classify(body)).toMatchObject({ kind: "ignore" });
    }
  });

  it.skipIf(skipNoIsovm)(
    "ignores a channel message carrying the mention (paired app_mention wins)",
    async () => {
      const d = await classify(
        envelope({ type: "message", user: "U1", channel: "C1", ts: "1.1", text: `<@${BOT}> hi` })
      );
      expect(d).toMatchObject({ kind: "ignore", reason: expect.stringContaining("app_mention") });
    }
  );

  it.skipIf(skipNoIsovm)(
    "thread-following: bot-rooted thread → chat without a mention",
    async () => {
      const d = await classify(
        envelope({
          type: "message",
          user: "U1",
          channel: "C1",
          ts: "3.3",
          thread_ts: "2.2",
          parent_user_id: BOT,
          text: "follow-up",
        })
      );
      expect(d).toMatchObject({ kind: "chat", text: "follow-up" });
    }
  );

  it.skipIf(skipNoIsovm)("thread-following: mapped thread → chat, unmapped → ignore", async () => {
    const reply = envelope({
      type: "message",
      user: "U1",
      channel: "C1",
      ts: "3.3",
      thread_ts: "2.2",
      text: "follow-up",
    });
    expect(await classify(reply, true)).toMatchObject({ kind: "chat" });
    expect(await classify(reply, false)).toMatchObject({ kind: "ignore" });
  });

  it.skipIf(skipNoIsovm)(
    "plain channel chatter is ignored, never an event (flood control)",
    async () => {
      const d = await classify(
        envelope({ type: "message", user: "U1", channel: "C1", ts: "1.1", text: "just chatting" })
      );
      expect(d).toMatchObject({ kind: "ignore" });
    }
  );

  it.skipIf(skipNoIsovm)("non-message subscribed events become integration events", async () => {
    const d = await classify(
      envelope({ type: "member_joined_channel", user: "U2", channel: "C1" })
    );
    expect(d).toEqual({
      kind: "event",
      eventType: "member_joined_channel",
      payload: { type: "member_joined_channel", user: "U2", channel: "C1" },
    });
  });

  it.skipIf(skipNoIsovm)("ignores malformed chat events (missing user/channel/ts)", async () => {
    const d = await classify(
      envelope({ type: "app_mention", channel: "C1", ts: "1.1", text: "x" })
    );
    expect(d).toMatchObject({ kind: "ignore", reason: "malformed chat event" });
  });

  it.skipIf(skipNoIsovm)(
    "works without authorizations: DMs still chat, bot-loop guard degrades",
    async () => {
      const dm = await classify(
        envelope(
          {
            type: "message",
            channel_type: "im",
            user: "U1",
            channel: "D1",
            ts: "1.1",
            text: "hey",
          },
          { bot: null }
        )
      );
      expect(dm).toMatchObject({ kind: "chat", text: "hey" });
    }
  );

  it.skipIf(skipNoIsovm)("ignores non-event_callback payloads", async () => {
    expect(await classify({ type: "url_verification", challenge: "c" })).toMatchObject({
      kind: "ignore",
    });
  });
});
