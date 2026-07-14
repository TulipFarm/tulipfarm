import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngressUserLookup, UserDoc } from "../auth/users";
import { runHeadlessChatTurn } from "../chat/headless-chat-turn";
import type { ChatTurnContext } from "../chat/turn";
import { DOMAIN_EVENTS } from "../domain-events";
import { SlackIdentityResolver } from "./identity";
import type { IntegrationConversation } from "./repo";
import { handleIngressJob, type IngressServiceDeps, resetIngressAuthCache } from "./service";
import type { SlackClient } from "./slack-client";

vi.mock("../chat/headless-chat-turn", () => ({
  runHeadlessChatTurn: vi.fn(async () => ({
    conversationId: "convo-1",
    text: "Here is your answer",
    status: "ok" as const,
  })),
}));

const mockTurn = vi.mocked(runHeadlessChatTurn);

const BOT = "UBOT";

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeUser(email: string, role: "admin" | "member" = "admin"): UserDoc {
  return { _id: randomUUID(), email, passwordHash: "x", role, createdAt: new Date() };
}

function makeIntegration(): SoulIntegration {
  return {
    slug: "slack",
    sourceIntegration: "slack",
    manifest: {
      name: "slack",
      egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } },
    },
    connection: { enabled: true, env: { SLACK_BOT_TOKEN: "xoxb-test" } },
  } as SoulIntegration;
}

function envelope(event: Record<string, unknown>): Record<string, unknown> {
  return { type: "event_callback", team_id: "T1", event_id: "Ev1", event };
}

describe("handleIngressJob", () => {
  let admin: UserDoc;
  let mappings: Map<string, IntegrationConversation>;
  let insertedEvents: Array<Record<string, unknown>>;
  let postMessage: ReturnType<typeof vi.fn>;
  let bus: EventEmitter;
  let deps: IngressServiceDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIngressAuthCache();
    admin = makeUser("admin@example.com");
    mappings = new Map();
    insertedEvents = [];
    postMessage = vi.fn(async () => {});
    bus = new EventEmitter();

    const users: IngressUserLookup = {
      findByEmail: async () => null,
      findById: async (id) => (id === admin._id ? admin : null),
      findFirstAdmin: async () => admin,
    };
    const client = {
      authTest: vi.fn(async () => ({ botUserId: BOT, teamId: "T1" })),
      userEmail: vi.fn(async () => null),
      postMessage,
    } as unknown as SlackClient;

    deps = {
      soulLoader: {
        integrations: new Map([["slack", makeIntegration()]]),
      } as unknown as SoulLoader,
      conversations: {
        find: async (slug: string, key: string) => mappings.get(`${slug}:${key}`) ?? null,
        exists: async (slug: string, key: string) => mappings.has(`${slug}:${key}`),
        insert: async (doc: IntegrationConversation) => {
          mappings.set(`${doc.integrationSlug}:${doc.externalKey}`, doc);
        },
      } as IngressServiceDeps["conversations"],
      integrationEvents: {
        insert: async (doc: Record<string, unknown>) => {
          const record = { id: randomUUID(), ...doc };
          insertedEvents.push(record);
          return record;
        },
      } as unknown as IngressServiceDeps["integrationEvents"],
      users,
      identity: new SlackIdentityResolver(users, log),
      chatCtx: {} as ChatTurnContext,
      events: bus,
      log,
      makeClient: () => client,
    };
  });

  it("runs a chat turn for a mention, creates the thread mapping, and replies in-thread", async () => {
    await handleIngressJob(
      {
        slug: "slack",
        protocol: "slack",
        body: envelope({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "100.1",
          text: `<@${BOT}> summarize`,
        }),
      },
      deps
    );
    expect(mockTurn).toHaveBeenCalledTimes(1);
    const input = mockTurn.mock.calls[0][1];
    expect(input.user._id).toBe(admin._id);
    expect(input.body.message.content).toBe("summarize");
    expect(input.body.conversationId).toBeUndefined();
    expect(mappings.get("slack:T1/C1/100.1")?.conversationId).toBe("convo-1");
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "Here is your answer",
      threadTs: "100.1",
    });
  });

  it("reuses an existing mapping (turn continues the conversation)", async () => {
    mappings.set("slack:T1/C1/100.1", {
      integrationSlug: "slack",
      externalKey: "T1/C1/100.1",
      conversationId: "convo-1",
      userId: admin._id,
    });
    await handleIngressJob(
      {
        slug: "slack",
        protocol: "slack",
        body: envelope({
          type: "message",
          user: "U1",
          channel: "C1",
          ts: "200.2",
          thread_ts: "100.1",
          text: "follow-up",
        }),
      },
      deps
    );
    expect(mockTurn).toHaveBeenCalledTimes(1);
    expect(mockTurn.mock.calls[0][1].body.conversationId).toBe("convo-1");
    expect(mappings.size).toBe(1);
  });

  it("replies unthreaded for DMs", async () => {
    await handleIngressJob(
      {
        slug: "slack",
        protocol: "slack",
        body: envelope({
          type: "message",
          channel_type: "im",
          user: "U1",
          channel: "D1",
          ts: "1.1",
          text: "hello",
        }),
      },
      deps
    );
    expect(postMessage).toHaveBeenCalledWith({
      channel: "D1",
      text: "Here is your answer",
      threadTs: undefined,
    });
  });

  it("posts a generic reply on guardrail block and error", async () => {
    mockTurn.mockResolvedValueOnce({ conversationId: "c", text: "", status: "guardrail_block" });
    await handleIngressJob(
      {
        slug: "slack",
        protocol: "slack",
        body: envelope({ type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "bad" }),
      },
      deps
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "I can't help with that request." })
    );

    mockTurn.mockResolvedValueOnce({ conversationId: "c", text: "", status: "error" });
    await handleIngressJob(
      {
        slug: "slack",
        protocol: "slack",
        body: envelope({ type: "app_mention", user: "U1", channel: "C1", ts: "2.2", text: "hi" }),
      },
      deps
    );
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Something went wrong handling that — please try again." })
    );
  });

  it("persists non-message events and emits integration.event on the bus", async () => {
    const received: unknown[] = [];
    bus.on(DOMAIN_EVENTS.INTEGRATION_EVENT, (p) => received.push(p));
    await handleIngressJob(
      {
        slug: "slack",
        protocol: "slack",
        body: envelope({ type: "member_joined_channel", user: "U9", channel: "C7" }),
      },
      deps
    );
    expect(mockTurn).not.toHaveBeenCalled();
    expect(insertedEvents).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      integration: "slack",
      protocol: "slack",
      event: "member_joined_channel",
    });
  });

  it("attributes a different Slack sender and runs as the mapping owner", async () => {
    const owner = makeUser("owner@example.com", "member");
    mappings.set("slack:T1/C1/100.1", {
      integrationSlug: "slack",
      externalKey: "T1/C1/100.1",
      conversationId: "convo-1",
      userId: owner._id,
    });
    deps.users.findById = async (id) => (id === owner._id ? owner : null);
    await handleIngressJob(
      {
        slug: "slack",
        protocol: "slack",
        body: envelope({
          type: "message",
          user: "U2",
          channel: "C1",
          ts: "300.3",
          thread_ts: "100.1",
          text: "me too",
        }),
      },
      deps
    );
    const input = mockTurn.mock.calls[0][1];
    expect(input.user._id).toBe(owner._id);
    expect(input.body.message.content).toBe("[From Slack user <@U2>] me too");
  });

  it("drops jobs for missing or disconnected integrations without throwing", async () => {
    await expect(
      handleIngressJob(
        { slug: "ghost", protocol: "slack", body: envelope({ type: "app_mention" }) },
        deps
      )
    ).resolves.toBeUndefined();
    expect(mockTurn).not.toHaveBeenCalled();
  });

  it("ignores bot noise end-to-end (no turn, no reply)", async () => {
    await handleIngressJob(
      {
        slug: "slack",
        protocol: "slack",
        body: envelope({ type: "message", bot_id: "B1", channel: "C1", ts: "1.1", text: "beep" }),
      },
      deps
    );
    expect(mockTurn).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
