import { type IntegrationHttpRequest, SLACK_TOOL_CONTRACTS } from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import {
  MemoryEffectStore,
  type ReserveEffectInput,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationConversation, IntegrationConversationsRepo } from "../../ingress/repo";
import type { RequestContext } from "../types";
import { buildSlackTooling } from "./compose";
import { buildSlackTools } from "./tools";

/**
 * Exercises `buildSlackTools()`'s `ToolDef.execute()` against a real `buildSlackTooling()` object
 * graph (channel resolution, `SlackToolAdapter` dispatch), faking only the two edges outside this
 * app's control — same shape as `../github/tools.test.ts`.
 */

const BUSINESS_ID = "biz-triage";

function fakeSecretsService(): () => Promise<SecretsService> {
  return async () =>
    ({
      get: async (key: string) => {
        if (key.includes("SLACK_BOT_TOKEN")) return "xoxb-fake";
        throw new Error(`no secret ${key}`);
      },
      // biome-ignore lint/suspicious/noExplicitAny: only `get` is exercised
    }) as any;
}

type MarkInput = { businessId: string; provider: string; channelId: string; threadId: string };

function fakeMentionedThreads(): ChannelMentionedThreadStore & { marked: MarkInput[] } {
  const marked: MarkInput[] = [];
  return {
    marked,
    async mark(input: MarkInput) {
      marked.push(input);
    },
    async isMentioned() {
      return true;
    },
    // biome-ignore lint/suspicious/noExplicitAny: only mark/isMentioned are exercised
  } as any;
}

function fakeThreads(): IntegrationConversationsRepo & { inserted: IntegrationConversation[] } {
  const inserted: IntegrationConversation[] = [];
  return {
    inserted,
    async find() {
      return null;
    },
    async exists() {
      return false;
    },
    async insert(doc: IntegrationConversation) {
      inserted.push(doc);
    },
    // biome-ignore lint/suspicious/noExplicitAny: only these three methods are exercised
  } as any;
}

function fakeHttp(ts: string) {
  return {
    async send(request: IntegrationHttpRequest, credential?: string) {
      expect(credential).toBe("xoxb-fake");
      if (request.path === "/conversations.list") {
        return {
          status: 200,
          headers: {},
          body: { ok: true, channels: [{ id: "C123", name: "slack-bot-test" }] },
        };
      }
      if (request.path === "/chat.postMessage") {
        return { status: 200, headers: {}, body: { ok: true, ts, channel: "C123" } };
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    },
  };
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return { userId: "user-1", runId: "run-1", toolCallId: "call-1", ...overrides };
}

function expectNoNullishTargetText(targets: unknown): void {
  expect(JSON.stringify(targets)).not.toMatch(/undefined|null/);
}

describe("buildSlackTools", () => {
  it("derives egress destinations from the published Slack contract", () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.000") });
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((candidate) => candidate.name === "send_slack_message");
    if (tool?.definition === undefined) throw new Error("send_slack_message not registered");

    expect(tool.definition.authorization.allowedDestinations).toEqual(
      SLACK_TOOL_CONTRACTS[0].spec.allowedDestinations
    );
  });

  it("keeps Slack target derivation total for raw model output", () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.000") });
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((candidate) => candidate.name === "send_slack_message");
    if (tool?.definition === undefined) throw new Error("send_slack_message not registered");
    const rawInputs: unknown[] = [{}, { unexpected: true }, { channel: 7 }, null, []];

    for (const input of rawInputs) {
      expect(() => tool.definition?.targetsFor(input), "send_slack_message targets").not.toThrow();
      expectNoNullishTargetText(tool.definition.targetsFor(input));
    }
  });

  it("normalizes channel-name targets and keeps raw Slack IDs in a separate stable namespace", () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.000") });
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((candidate) => candidate.name === "send_slack_message");
    if (tool?.definition === undefined) throw new Error("send_slack_message not registered");

    expect(tool.definition.targetsFor({ channel: "#general" })).toEqual([
      { type: "integration.slack", id: "channel-name:general" },
    ]);
    expect(tool.definition.targetsFor({ channel: "general" })).toEqual([
      { type: "integration.slack", id: "channel-name:general" },
    ]);
    expect(tool.definition.targetsFor({ channel: "C0123456789" })).toEqual([
      { type: "integration.slack", id: "channel:C0123456789" },
    ]);
  });

  it("resolves a channel name, sends, and returns the ledger dispatch output", async () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.001") });
    const threads = fakeThreads();
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads,
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");
    expect(tool.mutating).toBe(true);

    const result = await tool.execute(
      { channel: "#slack-bot-test", text: "hi" },
      context({ conversationId: "conv-1" })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ channelId: "C123", ts: "100.001", threadId: "100.001" });
    }
  });

  it("marks the sent thread as mentioned so a reply passes the ingress mention-gate", async () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.002") });
    const mentionedThreads = fakeMentionedThreads();
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads: fakeThreads(),
      mentionedThreads,
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");

    await tool.execute({ channel: "slack-bot-test", text: "hi" }, context());

    expect(mentionedThreads.marked).toEqual([
      { businessId: BUSINESS_ID, provider: "slack", channelId: "C123", threadId: "100.002" },
    ]);
  });

  it("writes an integration_conversations mapping so a thread reply routes back to this conversation", async () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.002") });
    const threads = fakeThreads();
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads,
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");

    await tool.execute(
      { channel: "slack-bot-test", text: "hi" },
      context({ conversationId: "conv-1" })
    );

    expect(threads.inserted).toEqual([
      {
        integrationSlug: "slack",
        externalKey: "slack:C123:100.002",
        conversationId: "conv-1",
        userId: "user-1",
      },
    ]);
  });

  it("skips channels.list and sends directly when given a raw channel ID", async () => {
    let listCalls = 0;
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/conversations.list") {
          listCalls += 1;
          return { status: 200, headers: {}, body: { ok: true, channels: [] } };
        }
        return { status: 200, headers: {}, body: { ok: true, ts: "100.003", channel: "C999" } };
      },
    };
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http });
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");

    const result = await tool.execute({ channel: "C999999999", text: "hi" }, context());

    expect(result.success).toBe(true);
    expect(listCalls).toBe(0);
  });

  it("replays the same effect instead of re-sending on a repeated call id", async () => {
    let posts = 0;
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/conversations.list") {
          return {
            status: 200,
            headers: {},
            body: { ok: true, channels: [{ id: "C123", name: "slack-bot-test" }] },
          };
        }
        posts += 1;
        return { status: 200, headers: {}, body: { ok: true, ts: "100.004", channel: "C123" } };
      },
    };
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http });
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");

    const args = { channel: "#slack-bot-test", text: "hi" };
    const ctx = context();
    const first = await tool.execute(args, ctx);
    const second = await tool.execute(args, ctx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.data).toMatchObject({ replayed: true });
    }
    expect(posts).toBe(1);
  });

  it("fails closed with an internal_error when the run context is missing", async () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.005") });
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");

    const result = await tool.execute({ channel: "slack-bot-test", text: "hi" }, { userId: "u" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("internal_error");
    }
  });

  it("reports not_found when the channel name doesn't resolve", async () => {
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/conversations.list") {
          return { status: 200, headers: {}, body: { ok: true, channels: [] } };
        }
        throw new Error(`unexpected request: ${request.path}`);
      },
    };
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http });
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects: new MemoryEffectStore(),
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");

    const result = await tool.execute({ channel: "nonexistent", text: "hi" }, context());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("not_found");
    }
  });
});

describe("intents carry the Tool's derived targets", () => {
  /** Captures what the handler actually reserved, which is where the intent becomes durable. */
  class RecordingEffectStore extends MemoryEffectStore {
    readonly intents: ToolIntent[] = [];
    override async reserve(input: ReserveEffectInput) {
      this.intents.push(input.intent);
      return super.reserve(input);
    }
  }

  // `targetRefs: []` was hardcoded here while the derivation existed only as a declaration, so the
  // gate would have authorized against the Tool's coarse static resource no matter which channel
  // the model named. This asserts the intent the handler builds is the one `targetsFor` describes.
  it("reserves an effect whose intent names the resolved channel", async () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.002") });
    const effects = new RecordingEffectStore();
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects,
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");

    await tool.execute({ channel: "C0123456789", text: "hi" }, context());

    expect(effects.intents.at(0)?.targetRefs).toEqual([
      { type: "integration.slack", id: "channel:C0123456789" },
    ]);
  });

  it("keeps an unresolved channel name in its own target namespace", async () => {
    const tooling = buildSlackTooling({ secrets: fakeSecretsService(), http: fakeHttp("100.002") });
    const effects = new RecordingEffectStore();
    const tools = buildSlackTools(BUSINESS_ID, {
      ...tooling,
      effects,
      threads: fakeThreads(),
      mentionedThreads: fakeMentionedThreads(),
    });
    const tool = tools.find((t) => t.name === "send_slack_message");
    if (tool === undefined) throw new Error("send_slack_message not registered");

    await tool.execute({ channel: "#slack-bot-test", text: "hi" }, context());

    expect(effects.intents.at(0)?.targetRefs).toEqual([
      { type: "integration.slack", id: "channel-name:slack-bot-test" },
    ]);
  });
});
