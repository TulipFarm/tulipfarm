import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type IngressDecision, parseDecision } from "@tulipfarm/integrations";
import type { HookExecutor } from "@tulipfarm/sandbox";
import { analyzeHook } from "@tulipfarm/sandbox";
import { beforeAll, describe, expect, it } from "vitest";
import { createHookExecutor } from "../hooks/executor";

/** Parity guard: the API fixture must match the declarative Telegram ingress bundle. */

// isolated-vm has no abi141 prebuild (same caveat as hooks/routine-sandbox.test.ts).
const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
const skipNoIsovm = nodeMajor === 25;

const FAKE_DATABASE_URL = "postgresql://localhost:5432/test";
const BOT = "tulipfarm_bot";

let source: string;
let executor: HookExecutor;

beforeAll(async () => {
  source = await readFile(join(__dirname, "__fixtures__", "telegram-ingress.hook.txt"), "utf8");
  executor = createHookExecutor(FAKE_DATABASE_URL);
  return async () => {
    await executor.close();
  };
});

function update(message: Record<string, unknown> | null): Record<string, unknown> {
  return { update_id: 100, ...(message === null ? {} : { message }) };
}

function dm(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return update({
    message_id: 7,
    from: { id: 42, is_bot: false, username: "ada" },
    chat: { id: 42, type: "private" },
    text,
    ...overrides,
  });
}

function group(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return update({
    message_id: 7,
    from: { id: 42, is_bot: false, username: "ada" },
    chat: { id: -100, type: "supergroup" },
    ...overrides,
  });
}

/** A `mention` entity covering the bot's @handle at the start of `text`. */
function mention(text: string): Record<string, unknown>[] {
  return [{ type: "mention", offset: text.indexOf(`@${BOT}`), length: BOT.length + 1 }];
}

async function classify(
  body: Record<string, unknown>,
  opts: { hasThreadMapping?: boolean; env?: Record<string, string> } = {}
): Promise<IngressDecision | null> {
  const raw = await executor.runRoutineHook(
    source,
    "classify",
    {
      body,
      headers: {},
      hasThreadMapping: opts.hasThreadMapping ?? false,
      env: opts.env ?? { TELEGRAM_BOT_USERNAME: BOT },
    },
    null,
    "ingress:telegram-parity"
  );
  return parseDecision(raw);
}

describe("telegram ingress.ts (real sandbox)", () => {
  it("passes the sandbox's static analysis", () => {
    expect(() => analyzeHook(source)).not.toThrow();
  });

  it.skipIf(skipNoIsovm)("a DM is chat, replying plainly into the chat", async () => {
    const d = await classify(dm("what is on my plate today?"));

    expect(d).toEqual({
      kind: "chat",
      sender: "42",
      text: "what is on my plate today?",
      reply: { binding: "default", vars: { chat: "42", message: "7" } },
      requireExistingThread: false,
    });
  });

  it.skipIf(skipNoIsovm)(
    "a DM caption counts as text, so a photo with a question is answered",
    async () => {
      const body = dm("", { text: undefined, caption: "who signed this?" });

      await expect(classify(body)).resolves.toMatchObject({
        kind: "chat",
        text: "who signed this?",
      });
    }
  );

  it.skipIf(skipNoIsovm)("/start is Telegram's onboarding tap, not a question", async () => {
    await expect(classify(dm("/start"))).resolves.toMatchObject({ kind: "ignore" });
    await expect(classify(dm(`/start@${BOT}`))).resolves.toMatchObject({ kind: "ignore" });
  });

  it.skipIf(skipNoIsovm)(
    "ignores another bot, so two deployments cannot talk forever",
    async () => {
      const body = dm("hello", { from: { id: 99, is_bot: true, username: "other_bot" } });

      await expect(classify(body)).resolves.toEqual({ kind: "ignore", reason: "bot message" });
    }
  );

  it.skipIf(skipNoIsovm)("ignores a non-message update rather than guessing at it", async () => {
    await expect(classify(update(null))).resolves.toMatchObject({ kind: "ignore" });
    await expect(
      classify({ update_id: 1, edited_message: { message_id: 7 } })
    ).resolves.toMatchObject({ kind: "ignore", reason: "update type edited_message" });
  });

  it.skipIf(skipNoIsovm)("a group @mention is chat, with the mention stripped", async () => {
    const text = `@${BOT} summarise the thread`;
    const d = await classify(group({ text, entities: mention(text) }));

    expect(d).toEqual({
      kind: "chat",
      sender: "42",
      text: "summarise the thread",
      reply: { binding: "reply", vars: { chat: "-100", message: "7" } },
      requireExistingThread: false,
    });
  });

  it.skipIf(skipNoIsovm)("a name merely appearing in text is not a mention", async () => {
    const body = group({ text: `ask @${BOT} about it later` });

    await expect(classify(body)).resolves.toEqual({
      kind: "ignore",
      reason: "not addressed to the bot",
    });
  });

  it.skipIf(skipNoIsovm)("without ctx.env the bot cannot recognise its own mention", async () => {
    const text = `@${BOT} summarise the thread`;
    const body = group({ text, entities: mention(text) });

    await expect(classify(body, { env: {} })).resolves.toMatchObject({ kind: "ignore" });
  });

  it.skipIf(skipNoIsovm)("a reply to the bot continues without a fresh mention", async () => {
    const body = group({
      text: "and the second one?",
      reply_to_message: { message_id: 5, from: { id: 1, is_bot: true, username: BOT } },
    });

    await expect(classify(body)).resolves.toMatchObject({
      kind: "chat",
      text: "and the second one?",
    });
  });

  it.skipIf(skipNoIsovm)("a reply to somebody else is not addressed to the bot", async () => {
    const body = group({
      text: "agreed",
      reply_to_message: { message_id: 5, from: { id: 8, is_bot: false, username: "grace" } },
    });

    await expect(classify(body)).resolves.toMatchObject({ kind: "ignore" });
  });

  it.skipIf(skipNoIsovm)("a forum topic replies into the topic, not into General", async () => {
    const text = `@${BOT} status?`;
    const d = await classify(group({ text, entities: mention(text), message_thread_id: 31 }));

    expect(d).toMatchObject({
      kind: "chat",
      reply: { binding: "topic", vars: { chat: "-100", message: "7", topic: "31" } },
    });
  });

  it.skipIf(skipNoIsovm)("an already-mapped topic keeps flowing without a mention", async () => {
    const body = group({ text: "and the rollout?", message_thread_id: 31 });

    await expect(classify(body, { hasThreadMapping: true })).resolves.toMatchObject({
      kind: "chat",
      reply: { binding: "topic" },
    });
    await expect(classify(body)).resolves.toMatchObject({ kind: "ignore" });
  });

  it.skipIf(skipNoIsovm)("a mapped plain group chat still needs a mention", async () => {
    const body = group({ text: "unrelated chatter" });

    await expect(classify(body, { hasThreadMapping: true })).resolves.toMatchObject({
      kind: "ignore",
    });
  });

  it.skipIf(skipNoIsovm)("a mention with nothing else said is not a question", async () => {
    const text = `@${BOT}`;
    const body = group({ text, entities: mention(text) });

    await expect(classify(body)).resolves.toEqual({
      kind: "ignore",
      reason: "mention with no message",
    });
  });

  it.skipIf(skipNoIsovm)("ignores a message with no usable id or text", async () => {
    await expect(classify(update({ message_id: 7, chat: { type: "private" } }))).resolves.toEqual({
      kind: "ignore",
      reason: "malformed message",
    });
  });
});
