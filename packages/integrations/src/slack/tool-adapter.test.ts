import {
  AdapterDispatchError,
  type ToolAdapterRequest,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationHttpRequest, IntegrationHttpResponse } from "../http";
import { SLACK_RECONCILIATION_OPERATIONS, SLACK_TOOL_IDS } from "./contracts";
import { type SlackFileUploadState, SlackToolAdapter } from "./tool-adapter";

const CREDENTIAL = "xoxb-token";

interface SlackApiUserFixture {
  readonly id: string;
  readonly name?: string;
  readonly real_name?: string;
  readonly profile?: { readonly display_name?: string; readonly real_name?: string };
}

function fakeHttp(members: readonly SlackApiUserFixture[]) {
  const calls: IntegrationHttpRequest[] = [];
  return {
    calls,
    async send(
      request: IntegrationHttpRequest,
      credential: string
    ): Promise<IntegrationHttpResponse> {
      calls.push(request);
      expect(credential).toBe(CREDENTIAL);
      if (request.path === "/users.list") {
        return { status: 200, headers: {}, body: { ok: true, members } };
      }
      if (request.path === "/conversations.info") {
        return {
          status: 200,
          headers: {},
          body: { ok: true, channel: { id: "C0123456789", is_member: true } },
        };
      }
      if (request.path === "/chat.postMessage") {
        return { status: 200, headers: {}, body: { ok: true, ts: "1700000000.000100" } };
      }
      throw new Error(`unexpected path: ${request.path}`);
    },
  };
}

function sendRequest(channel: string, text: string): ToolAdapterRequest {
  const intent: ToolIntent = {
    intentId: "11111111-1111-4111-8111-111111111111",
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-1",
    toolId: SLACK_TOOL_IDS.sendMessage,
    toolVersion: "1.0.0",
    action: SLACK_TOOL_IDS.sendMessage,
    targetRefs: [],
    arguments: { channel, text },
    credentialRef: "slack-bot-token",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
  };
  return { intent, idempotencyKey: intent.idempotencyKey, attempt: 1 };
}

function listRequest(): ToolAdapterRequest {
  const intent: ToolIntent = {
    intentId: "33333333-3333-4333-8333-333333333333",
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-list",
    toolId: SLACK_TOOL_IDS.listChannels,
    toolVersion: "1.0.0",
    action: SLACK_TOOL_IDS.listChannels,
    targetRefs: [],
    arguments: {},
    credentialRef: "slack-bot-token",
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
  };
  return { intent, idempotencyKey: intent.idempotencyKey, attempt: 1 };
}

function historyRequest(
  channel: string,
  overrides: Record<string, unknown> = {}
): ToolAdapterRequest {
  const intent: ToolIntent = {
    intentId: "55555555-5555-4555-8555-555555555555",
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-history",
    toolId: SLACK_TOOL_IDS.listMessages,
    toolVersion: "1.0.0",
    action: SLACK_TOOL_IDS.listMessages,
    targetRefs: [],
    arguments: { channel, ...overrides },
    credentialRef: "slack-bot-token",
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
  };
  return { intent, idempotencyKey: intent.idempotencyKey, attempt: 1 };
}

describe("SlackToolAdapter channel discovery", () => {
  it("paginates and returns stable ids only for channels the bot has joined", async () => {
    const calls: IntegrationHttpRequest[] = [];
    const http = {
      async send(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
        calls.push(request);
        if (request.query?.cursor === "page-2") {
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              channels: [
                { id: "G2222222222", name: "private-team", is_member: true },
                { id: "C3333333333", name: "visible-only", is_member: false },
              ],
              response_metadata: { next_cursor: "" },
            },
          };
        }
        return {
          status: 200,
          headers: {},
          body: {
            ok: true,
            channels: [
              { id: "C1111111111", name: "general", is_member: true },
              { id: "C0000000000", name: "not-joined", is_member: false },
            ],
            response_metadata: { next_cursor: "page-2" },
          },
        };
      },
    };
    const adapter = new SlackToolAdapter({ http });

    await expect(adapter.dispatch(listRequest(), CREDENTIAL)).resolves.toEqual({
      channels: [
        { id: "C1111111111", name: "general" },
        { id: "G2222222222", name: "private-team" },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toEqual({
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: "true",
      limit: "100",
    });
    expect(calls[1]?.query?.cursor).toBe("page-2");
  });

  describe("SlackToolAdapter message history", () => {
    it("returns one bounded public-channel page and its cursor without writing anywhere", async () => {
      const calls: IntegrationHttpRequest[] = [];
      const http = {
        async send(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
          calls.push(request);
          if (request.path === "/conversations.info") {
            return {
              status: 200,
              headers: {},
              body: {
                ok: true,
                channel: {
                  id: "C1234567890",
                  name: "general",
                  is_member: true,
                  is_private: false,
                },
              },
            };
          }
          if (request.path === "/conversations.history") {
            return {
              status: 200,
              headers: {},
              body: {
                ok: true,
                messages: [
                  {
                    ts: "1700000000.000100",
                    text: "Ship it",
                    user: "U123",
                    edited: { ts: "1700000001.000100" },
                  },
                  { ts: "1700000002.000100", subtype: "message_deleted" },
                ],
                response_metadata: { next_cursor: "next-page" },
              },
            };
          }
          throw new Error(`unexpected path: ${request.path}`);
        },
      };
      const adapter = new SlackToolAdapter({ http });

      await expect(
        adapter.dispatch(
          historyRequest("C1234567890", { oldest: "1699999999.000000", limit: 25 }),
          CREDENTIAL
        )
      ).resolves.toEqual({
        channelId: "C1234567890",
        messages: [
          {
            ts: "1700000000.000100",
            text: "Ship it",
            userId: "U123",
            editedTs: "1700000001.000100",
          },
        ],
        nextCursor: "next-page",
      });
      expect(calls.map(({ path }) => path)).toEqual([
        "/conversations.info",
        "/conversations.history",
      ]);
      expect(calls[1]?.query).toEqual({
        channel: "C1234567890",
        limit: "25",
        oldest: "1699999999.000000",
      });
    });

    it("refuses private channels before reading their messages", async () => {
      const calls: IntegrationHttpRequest[] = [];
      const http = {
        async send(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
          calls.push(request);
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              channel: {
                id: "G1234567890",
                name: "leadership",
                is_member: true,
                is_private: true,
              },
            },
          };
        },
      };
      const adapter = new SlackToolAdapter({ http });

      await expect(
        adapter.dispatch(historyRequest("G1234567890"), CREDENTIAL)
      ).rejects.toMatchObject({
        code: "restricted_channel",
      });
      expect(calls.map(({ path }) => path)).toEqual(["/conversations.info"]);
    });

    it("reads a selected thread instead of channel history", async () => {
      const calls: IntegrationHttpRequest[] = [];
      const http = {
        async send(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
          calls.push(request);
          if (request.path === "/conversations.info") {
            return {
              status: 200,
              headers: {},
              body: {
                ok: true,
                channel: {
                  id: "C1234567890",
                  name: "general",
                  is_member: true,
                  is_private: false,
                },
              },
            };
          }
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              messages: [
                { ts: "1700000001.000100", text: "Reply", thread_ts: "1700000000.000100" },
              ],
            },
          };
        },
      };
      const adapter = new SlackToolAdapter({ http });

      await adapter.dispatch(
        historyRequest("C1234567890", { threadTs: "1700000000.000100" }),
        CREDENTIAL
      );

      expect(calls[1]).toMatchObject({
        path: "/conversations.replies",
        query: {
          channel: "C1234567890",
          limit: "100",
          ts: "1700000000.000100",
        },
      });
    });
  });

  it("fails instead of silently returning a truncated channel directory", async () => {
    let calls = 0;
    const http = {
      async send(): Promise<IntegrationHttpResponse> {
        calls += 1;
        return {
          status: 200,
          headers: {},
          body: {
            ok: true,
            channels: [{ id: `C${String(calls).padStart(10, "0")}`, name: `channel-${calls}` }],
            response_metadata: { next_cursor: `page-${calls + 1}` },
          },
        };
      },
    };
    const adapter = new SlackToolAdapter({ http });

    await expect(adapter.dispatch(listRequest(), CREDENTIAL)).rejects.toMatchObject({
      code: "pagination_bound_exceeded",
    });
    expect(calls).toBe(20);
  });
});

function postedText(calls: readonly IntegrationHttpRequest[]): string {
  const call = calls.find((c) => c.path === "/chat.postMessage");
  const body = call?.body as { text?: string } | undefined;
  if (body?.text === undefined) throw new Error("no chat.postMessage call recorded");
  return body.text;
}

describe("SlackToolAdapter mention encoding", () => {
  it("encodes an @name that exactly matches a member's username", async () => {
    const http = fakeHttp([{ id: "U0AMFGRAKLY", name: "mohit" }]);
    const adapter = new SlackToolAdapter({ http });

    await adapter.dispatch(sendRequest("C0123456789", "hi @mohit!"), CREDENTIAL);

    expect(postedText(http.calls)).toBe("hi <@U0AMFGRAKLY>!");
  });

  it("falls back to a first-name match against a member's full display name", async () => {
    const http = fakeHttp([{ id: "U0SHIV", profile: { display_name: "Shiv Soni" } }]);
    const adapter = new SlackToolAdapter({ http });

    await adapter.dispatch(sendRequest("C0123456789", "hi @shiv!"), CREDENTIAL);

    expect(postedText(http.calls)).toBe("hi <@U0SHIV>!");
  });

  it("does not guess when two members share the same first name", async () => {
    const http = fakeHttp([
      { id: "U0SHIVA", profile: { display_name: "Shiv Soni" } },
      { id: "U0SHIVB", profile: { display_name: "Shiv Kumar" } },
    ]);
    const adapter = new SlackToolAdapter({ http });

    await adapter.dispatch(sendRequest("C0123456789", "hi @shiv!"), CREDENTIAL);

    expect(postedText(http.calls)).toBe("hi @shiv!");
  });

  it("still sends when the directory scan fails, leaving text unencoded", async () => {
    const http = {
      async send(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
        if (request.path === "/conversations.info") {
          return {
            status: 200,
            headers: {},
            body: { ok: true, channel: { id: "C0123456789", is_member: true } },
          };
        }
        if (request.path === "/users.list")
          return { status: 200, headers: {}, body: { ok: false } };
        return { status: 200, headers: {}, body: { ok: true, ts: "1700000000.000100" } };
      },
    };
    const adapter = new SlackToolAdapter({ http });

    const output = await adapter.dispatch(sendRequest("C0123456789", "hi @mohit!"), CREDENTIAL);

    expect(output).toEqual({
      channelId: "C0123456789",
      ts: "1700000000.000100",
      threadId: "1700000000.000100",
    });
  });

  it("rejects dispatch with no credential", async () => {
    const http = fakeHttp([]);
    const adapter = new SlackToolAdapter({ http });

    await expect(adapter.dispatch(sendRequest("C0123456789", "hi"))).rejects.toBeInstanceOf(
      AdapterDispatchError
    );
  });
});

function threadTs(calls: readonly IntegrationHttpRequest[]): string | undefined {
  const call = calls.find((c) => c.path === "/chat.postMessage");
  const body = call?.body as { thread_ts?: string } | undefined;
  return body?.thread_ts;
}

describe("SlackToolAdapter thread replies", () => {
  it("threads a reply when the Run started from a Slack thread in the same channel", async () => {
    const http = fakeHttp([]);
    const adapter = new SlackToolAdapter({
      http,
      channelRunDelivery: {
        async find() {
          return {
            businessId: "biz-1",
            runId: "run-1",
            integrationId: "int-1",
            routeId: "route-1",
            provider: "slack",
            destination: "C0123456789",
            threadId: "1700000000.000001",
            agentId: "agent-1",
            principalId: "principal-1",
            idempotencyKey: "idem-1",
            status: "pending",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          };
        },
        async markAcknowledged() {},
      },
    });

    await adapter.dispatch(sendRequest("C0123456789", "here you go"), CREDENTIAL);

    expect(threadTs(http.calls)).toBe("1700000000.000001");
  });

  it("does not thread when the Run's origin channel differs from the target channel", async () => {
    const http = fakeHttp([]);
    const adapter = new SlackToolAdapter({
      http,
      channelRunDelivery: {
        async find() {
          return {
            businessId: "biz-1",
            runId: "run-1",
            integrationId: "int-1",
            routeId: "route-1",
            provider: "slack",
            destination: "C0999999999",
            threadId: "1700000000.000001",
            agentId: "agent-1",
            principalId: "principal-1",
            idempotencyKey: "idem-1",
            status: "pending",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          };
        },
        async markAcknowledged() {},
      },
    });

    await adapter.dispatch(sendRequest("C0123456789", "here you go"), CREDENTIAL);

    expect(threadTs(http.calls)).toBeUndefined();
  });

  it("does not thread when the Run has no recorded delivery", async () => {
    const http = fakeHttp([]);
    const adapter = new SlackToolAdapter({
      http,
      channelRunDelivery: {
        async find() {
          return null;
        },
        async markAcknowledged() {},
      },
    });

    await adapter.dispatch(sendRequest("C0123456789", "here you go"), CREDENTIAL);

    expect(threadTs(http.calls)).toBeUndefined();
  });
});

function acknowledgeRequest(emoji: string): ToolAdapterRequest {
  const intent: ToolIntent = {
    intentId: "55555555-5555-4555-8555-555555555555",
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-ack",
    toolId: SLACK_TOOL_IDS.acknowledge,
    toolVersion: "1.0.0",
    action: SLACK_TOOL_IDS.acknowledge,
    targetRefs: [],
    arguments: { emoji },
    credentialRef: "slack-bot-token",
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
  };
  return { intent, idempotencyKey: intent.idempotencyKey, attempt: 1 };
}

function acknowledgeDeps(options: {
  readonly sourceMessageTs?: string;
  readonly delivery?: "missing";
  readonly reactionBody?: Record<string, unknown>;
  readonly emojiOk?: boolean;
}) {
  const calls: IntegrationHttpRequest[] = [];
  const acknowledged: { businessId: string; runId: string; emoji: string }[] = [];
  const http = {
    calls,
    async send(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
      calls.push(request);
      if (request.path === "/emoji.list") {
        return options.emojiOk === false
          ? { status: 200, headers: {}, body: { ok: false, error: "missing_scope" } }
          : {
              status: 200,
              headers: {},
              body: { ok: true, emoji: { thumbsup: "a.png", "party-parrot": "b.gif" } },
            };
      }
      if (request.path === "/reactions.add") {
        return {
          status: 200,
          headers: {},
          body: options.reactionBody ?? { ok: true },
        };
      }
      throw new Error(`unexpected path: ${request.path}`);
    },
  };
  const adapter = new SlackToolAdapter({
    http,
    channelRunDelivery: {
      async find() {
        if (options.delivery === "missing") return null;
        return {
          businessId: "biz-1",
          runId: "run-1",
          integrationId: "int-1",
          routeId: "route-1",
          provider: "slack",
          destination: "C0123456789",
          threadId: "1700000000.000001",
          ...(options.sourceMessageTs === undefined
            ? {}
            : { sourceMessageTs: options.sourceMessageTs }),
          agentId: "agent-1",
          principalId: "principal-1",
          idempotencyKey: "idem-1",
          status: "pending" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      },
      async markAcknowledged(businessId: string, runId: string, emoji: string) {
        acknowledged.push({ businessId, runId, emoji });
      },
    },
  });
  return { adapter, calls, acknowledged };
}

describe("SlackToolAdapter acknowledge", () => {
  it("reacts to the message the Run started from, not the thread root", async () => {
    const { adapter, calls, acknowledged } = acknowledgeDeps({
      sourceMessageTs: "1700000000.000009",
    });

    const output = await adapter.dispatch(acknowledgeRequest("thumbsup"), CREDENTIAL);

    const reaction = calls.find((call) => call.path === "/reactions.add");
    expect(reaction?.body).toEqual({
      channel: "C0123456789",
      timestamp: "1700000000.000009",
      name: "thumbsup",
    });
    expect(output).toEqual({ ok: true, emoji: "thumbsup" });
    expect(acknowledged).toEqual([{ businessId: "biz-1", runId: "run-1", emoji: "thumbsup" }]);
  });

  it("corrects an approximate name against the workspace directory", async () => {
    const { adapter, calls } = acknowledgeDeps({ sourceMessageTs: "1700000000.000009" });

    await adapter.dispatch(acknowledgeRequest("thumbs_up"), CREDENTIAL);

    const reaction = calls.find((call) => call.path === "/reactions.add");
    expect((reaction?.body as Record<string, unknown> | undefined)?.name).toBe("thumbsup");
  });

  it("treats already_reacted as success so a retry converges", async () => {
    const { adapter, acknowledged } = acknowledgeDeps({
      sourceMessageTs: "1700000000.000009",
      reactionBody: { ok: false, error: "already_reacted" },
    });

    await expect(adapter.dispatch(acknowledgeRequest("thumbsup"), CREDENTIAL)).resolves.toEqual({
      ok: true,
      emoji: "thumbsup",
    });
    expect(acknowledged).toHaveLength(1);
  });

  it("reports invalid_name as a non-retryable emoji_not_found", async () => {
    const { adapter } = acknowledgeDeps({
      sourceMessageTs: "1700000000.000009",
      reactionBody: { ok: false, error: "invalid_name" },
    });

    await expect(adapter.dispatch(acknowledgeRequest("parrrot"), CREDENTIAL)).rejects.toMatchObject(
      { name: "AdapterDispatchError", retryable: false }
    );
  });

  it("still sends the raw name when the emoji directory is unreadable", async () => {
    const { adapter, calls } = acknowledgeDeps({
      sourceMessageTs: "1700000000.000009",
      emojiOk: false,
    });

    await adapter.dispatch(acknowledgeRequest(":Tada:"), CREDENTIAL);

    const reaction = calls.find((call) => call.path === "/reactions.add");
    expect((reaction?.body as Record<string, unknown> | undefined)?.name).toBe("tada");
  });

  it("fails rather than guessing when the Run has no recorded delivery", async () => {
    const { adapter } = acknowledgeDeps({ delivery: "missing" });

    await expect(adapter.dispatch(acknowledgeRequest("thumbsup"), CREDENTIAL)).rejects.toThrow(
      AdapterDispatchError
    );
  });

  it("fails when the delivery predates source message capture", async () => {
    const { adapter } = acknowledgeDeps({});

    await expect(adapter.dispatch(acknowledgeRequest("thumbsup"), CREDENTIAL)).rejects.toThrow(
      AdapterDispatchError
    );
  });
});

function request(toolId: string, arguments_: Record<string, unknown>, runId = "run-1") {
  const intent: ToolIntent = {
    intentId: "77777777-7777-4777-8777-777777777777",
    businessId: "biz-1",
    runId,
    stateId: `state-${toolId}`,
    toolId,
    toolVersion: "1.0.0",
    action: toolId,
    targetRefs: [],
    arguments: arguments_,
    credentialRef: "slack-bot-token",
    idempotencyKey: "88888888-8888-4888-8888-888888888888",
  };
  return { intent, idempotencyKey: intent.idempotencyKey, attempt: 1 };
}

function reconciliation(toolId: string, arguments_: Record<string, unknown>, operation: string) {
  const dispatched = request(toolId, arguments_);
  return {
    intent: dispatched.intent,
    idempotencyKey: dispatched.idempotencyKey,
    operation,
  };
}

function joinedHttp(
  handler: (request: IntegrationHttpRequest) => IntegrationHttpResponse | undefined
) {
  return {
    async send(request: IntegrationHttpRequest): Promise<IntegrationHttpResponse> {
      if (request.path === "/conversations.info") {
        return {
          status: 200,
          headers: {},
          body: {
            ok: true,
            channel: {
              id: "C0123456789",
              name: "general",
              is_member: true,
              topic: { value: "News" },
              purpose: { value: "Updates" },
            },
          },
        };
      }
      const response = handler(request);
      if (response !== undefined) return response;
      throw new Error(`unexpected path: ${request.path}`);
    },
  };
}

function ownedDelivery(slackMessageTs = "1700000000.000100") {
  return {
    businessId: "biz-1",
    runId: "owner-run",
    integrationId: "int-1",
    routeId: "route-1",
    provider: "slack",
    destination: "C0123456789",
    threadId: "1700000000.000001",
    sourceMessageTs: "1700000000.000009",
    slackMessageTs,
    acknowledgedEmoji: "eyes",
    agentId: "agent-1",
    principalId: "principal-1",
    idempotencyKey: "idem-1",
    status: "done" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function governedOwnership(owned = true, onRecord: (providerObjectId: string) => void = () => {}) {
  let uploadState:
    | {
        businessId: string;
        integrationId: string;
        creationIntentId: string;
        creationRunId: string;
        channelId: string;
        sourceFileId: string;
        sourceSha256: string;
        filename: string;
        mediaType: string;
        sizeBytes: number;
        providerFileId: string;
        phase: "url_requested" | "bytes_uploaded" | "completed";
      }
    | undefined;
  return {
    integrationIdentity: {
      async resolve() {
        return "integration-1";
      },
    },
    ownedObjects: {
      async owns() {
        return owned;
      },
      async record(input: { providerObjectId: string }) {
        onRecord(input.providerObjectId);
      },
      async remove() {},
      async findByCreationIntent() {
        return undefined;
      },
    },
    fileUploads: {
      async find() {
        return uploadState;
      },
      async urlRequested(input: Omit<NonNullable<typeof uploadState>, "phase">) {
        uploadState = { ...input, phase: "url_requested" };
      },
      async advance(input: { providerFileId: string; to: "bytes_uploaded" | "completed" }) {
        if (uploadState?.providerFileId !== input.providerFileId) throw new Error("wrong File");
        uploadState = { ...uploadState, phase: input.to };
      },
    },
  };
}

function uploadState(
  phase: SlackFileUploadState["phase"],
  providerFileId = "F1"
): SlackFileUploadState {
  return {
    businessId: "biz-1",
    integrationId: "integration-1",
    creationIntentId: "77777777-7777-4777-8777-777777777777",
    creationRunId: "run-1",
    channelId: "C0123456789",
    sourceFileId: "file-1",
    sourceSha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    filename: "report.pdf",
    mediaType: "application/pdf",
    sizeBytes: 3,
    providerFileId,
    phase,
  };
}

const uploadSource = {
  async load() {
    return {
      filename: "report.pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
    };
  },
};

describe("SlackToolAdapter governed V1 operations", () => {
  it("reads a bounded page only after confirming joined-conversation membership", async () => {
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      http: joinedHttp((call) =>
        call.path === "/conversations.history"
          ? {
              status: 200,
              headers: {},
              body: {
                ok: true,
                messages: [{ ts: "1.1", text: "hello", user: "U1" }],
                response_metadata: { next_cursor: "next" },
              },
            }
          : undefined
      ),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.getConversation, { channel: "C0123456789", limit: 200 }),
        CREDENTIAL
      )
    ).resolves.toEqual({
      conversation: {
        id: "C0123456789",
        name: "general",
        topic: "News",
        purpose: "Updates",
      },
      messages: [{ ts: "1.1", text: "hello", userId: "U1" }],
      nextCursor: "next",
    });
  });

  describe("SlackToolAdapter reconciliation", () => {
    it("finds a sent message by its provider idempotency key and restores ownership", async () => {
      const recorded: string[] = [];
      const adapter = new SlackToolAdapter({
        ...governedOwnership(false, (id) => recorded.push(id)),
        http: joinedHttp((call) =>
          call.path === "/conversations.history"
            ? {
                status: 200,
                headers: {},
                body: {
                  ok: true,
                  messages: [
                    {
                      ts: "1700000000.000100",
                      text: "hello",
                      client_msg_id: "88888888-8888-4888-8888-888888888888",
                    },
                  ],
                },
              }
            : undefined
        ),
      });

      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.sendMessage,
            { channel: "C0123456789", text: "hello" },
            SLACK_RECONCILIATION_OPERATIONS.sendMessage
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
      expect(recorded).toEqual(["1700000000.000100"]);
    });

    it("reconciles message update and delete only after exact Integration ownership", async () => {
      const ownedInputs: unknown[] = [];
      const removed: unknown[] = [];
      let messages = [{ ts: "1700000000.000100", text: "updated" }];
      const adapter = new SlackToolAdapter({
        integrationIdentity: {
          async resolve() {
            return "integration-1";
          },
        },
        ownedObjects: {
          async owns(input) {
            ownedInputs.push(input);
            return true;
          },
          async record() {},
          async remove(input) {
            removed.push(input);
          },
          async findByCreationIntent() {
            return undefined;
          },
        },
        http: joinedHttp((call) =>
          call.path === "/conversations.history"
            ? { status: 200, headers: {}, body: { ok: true, messages } }
            : undefined
        ),
      });

      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.updateMessage,
            { channel: "C0123456789", ts: "1700000000.000100", text: "updated" },
            SLACK_RECONCILIATION_OPERATIONS.updateMessage
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
      messages = [];
      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.deleteMessage,
            { channel: "C0123456789", ts: "1700000000.000100" },
            SLACK_RECONCILIATION_OPERATIONS.deleteMessage
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
      expect(ownedInputs).toEqual([
        expect.objectContaining({ integrationId: "integration-1", objectType: "message" }),
        expect.objectContaining({ integrationId: "integration-1", objectType: "message" }),
      ]);
      expect(removed).toHaveLength(1);
    });

    it("confirms a completed File upload from durable phase state and exact Slack File", async () => {
      const adapter = new SlackToolAdapter({
        ...governedOwnership(),
        fileUploads: {
          async find(input) {
            expect(input).toEqual({
              businessId: "biz-1",
              integrationId: "integration-1",
              creationIntentId: "77777777-7777-4777-8777-777777777777",
            });
            return uploadState("completed");
          },
          async urlRequested() {},
          async advance() {},
        },
        files: uploadSource,
        externalUpload: { async upload() {} },
        http: joinedHttp((call) =>
          call.path === "/files.info"
            ? {
                status: 200,
                headers: {},
                body: {
                  ok: true,
                  file: {
                    id: "F1",
                    name: "report.pdf",
                    mimetype: "application/pdf",
                    size: 3,
                    channels: ["C0123456789"],
                  },
                },
              }
            : undefined
        ),
      });

      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.uploadFile,
            { channel: "C0123456789", fileId: "file-1" },
            SLACK_RECONCILIATION_OPERATIONS.uploadFile
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({
        outcome: "confirmed",
        evidenceRef: expect.stringContaining("F1"),
      });
    });

    it("resumes bytes_uploaded by completing the exact staged Slack File ID", async () => {
      const phases: string[] = [];
      const adapter = new SlackToolAdapter({
        ...governedOwnership(),
        fileUploads: {
          async find() {
            return uploadState("bytes_uploaded", "F-staged");
          },
          async urlRequested() {},
          async advance(input) {
            phases.push(`${input.from}->${input.to}:${input.providerFileId}`);
          },
        },
        files: uploadSource,
        externalUpload: { async upload() {} },
        http: joinedHttp((call) => {
          if (call.path === "/files.completeUploadExternal") {
            expect(call.body).toMatchObject({ files: [{ id: "F-staged" }] });
            return { status: 200, headers: {}, body: { ok: true, files: [{ id: "F-staged" }] } };
          }
          return call.path === "/files.info"
            ? {
                status: 200,
                headers: {},
                body: {
                  ok: true,
                  file: {
                    id: "F-staged",
                    name: "report.pdf",
                    mimetype: "application/pdf",
                    size: 3,
                    channels: ["C0123456789"],
                  },
                },
              }
            : undefined;
        }),
      });

      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.uploadFile,
            { channel: "C0123456789", fileId: "file-1" },
            SLACK_RECONCILIATION_OPERATIONS.uploadFile
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
      expect(phases).toEqual(["bytes_uploaded->completed:F-staged"]);
    });

    it("keeps a completed File upload ambiguous when ownership persistence is missing", async () => {
      const adapter = new SlackToolAdapter({
        ...governedOwnership(),
        http: joinedHttp(() => undefined),
      });

      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.uploadFile,
            { channel: "C0123456789", fileId: "file-1" },
            SLACK_RECONCILIATION_OPERATIONS.uploadFile
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({
        outcome: "ambiguous",
        evidenceRef: expect.stringContaining("state_missing"),
      });
    });

    it("does not claim an existing matching bookmark after an ambiguous add", async () => {
      const recorded: string[] = [];
      let listCalls = 0;
      const adapter = new SlackToolAdapter({
        ...governedOwnership(false, (id) => recorded.push(id)),
        http: joinedHttp((call) => {
          if (call.path === "/bookmarks.list") listCalls += 1;
          return undefined;
        }),
      });

      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.manageBookmark,
            {
              operation: "add",
              channel: "C0123456789",
              title: "Docs",
              link: "https://docs",
            },
            SLACK_RECONCILIATION_OPERATIONS.manageBookmark
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({
        outcome: "ambiguous",
        evidenceRef: expect.stringContaining("ownership_missing"),
      });
      expect(listCalls).toBe(0);
      expect(recorded).toEqual([]);
    });

    it("confirms an ambiguous bookmark add only from durable creation ownership", async () => {
      const adapter = new SlackToolAdapter({
        integrationIdentity: {
          async resolve() {
            return "integration-1";
          },
        },
        ownedObjects: {
          async owns() {
            return true;
          },
          async record() {},
          async remove() {},
          async findByCreationIntent() {
            return {
              businessId: "biz-1",
              integrationId: "integration-1",
              objectType: "bookmark" as const,
              providerObjectId: "Bk1",
              channelId: "C0123456789",
              creationRunId: "run-1",
              creationIntentId: "77777777-7777-4777-8777-777777777777",
            };
          },
        },
        http: joinedHttp(() => undefined),
      });

      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.manageBookmark,
            {
              operation: "add",
              channel: "C0123456789",
              title: "Docs",
              link: "https://docs",
            },
            SLACK_RECONCILIATION_OPERATIONS.manageBookmark
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({
        outcome: "confirmed",
        evidenceRef: expect.stringContaining("Bk1"),
      });
    });

    it("reconciles Integration-owned bookmark edits and removals by provider ID", async () => {
      let bookmarks = [{ id: "Bk1", title: "New", link: "https://new" }];
      const removed: unknown[] = [];
      const adapter = new SlackToolAdapter({
        integrationIdentity: {
          async resolve() {
            return "integration-1";
          },
        },
        ownedObjects: {
          async owns() {
            return true;
          },
          async record() {},
          async remove(input) {
            removed.push(input);
          },
          async findByCreationIntent() {
            return undefined;
          },
        },
        http: joinedHttp((call) =>
          call.path === "/bookmarks.list"
            ? { status: 200, headers: {}, body: { ok: true, bookmarks } }
            : undefined
        ),
      });

      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.manageBookmark,
            {
              operation: "edit",
              channel: "C0123456789",
              bookmarkId: "Bk1",
              title: "New",
              link: "https://new",
            },
            SLACK_RECONCILIATION_OPERATIONS.manageBookmark
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
      bookmarks = [];
      await expect(
        adapter.reconcile(
          reconciliation(
            SLACK_TOOL_IDS.manageBookmark,
            { operation: "remove", channel: "C0123456789", bookmarkId: "Bk1" },
            SLACK_RECONCILIATION_OPERATIONS.manageBookmark
          ),
          CREDENTIAL
        )
      ).resolves.toMatchObject({ outcome: "confirmed" });
      expect(removed).toHaveLength(1);
    });
  });

  it("rejects reads when the bot is not a conversation member", async () => {
    const adapter = new SlackToolAdapter({
      http: {
        async send() {
          return {
            status: 200,
            headers: {},
            body: { ok: true, channel: { id: "C0123456789", is_member: false } },
          };
        },
      },
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.getConversation, { channel: "C0123456789" }),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "channel_not_joined" });
  });

  it("updates only an Integration-owned message", async () => {
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      http: joinedHttp((call) =>
        call.path === "/chat.update"
          ? {
              status: 200,
              headers: {},
              body: { ok: true, ts: "1700000000.000100", message: {} },
            }
          : undefined
      ),
      channelRunDelivery: {
        async find() {
          return ownedDelivery();
        },
        async markAcknowledged() {},
      },
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.updateMessage, {
          channel: "C0123456789",
          ts: "1700000000.000100",
          text: "updated",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({
      channelId: "C0123456789",
      ts: "1700000000.000100",
      threadId: "1700000000.000100",
    });
  });

  it("refuses update when the stored message timestamp does not match", async () => {
    const adapter = new SlackToolAdapter({
      ...governedOwnership(false),
      http: joinedHttp(() => undefined),
      channelRunDelivery: {
        async find() {
          return ownedDelivery("different");
        },
        async markAcknowledged() {},
      },
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.updateMessage, {
          channel: "C0123456789",
          ts: "1700000000.000100",
          text: "updated",
        }),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "message_not_integration_owned" });
  });

  it("reconciles delete when Slack says the owned message is already absent", async () => {
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      http: joinedHttp((call) =>
        call.path === "/chat.delete"
          ? {
              status: 200,
              headers: {},
              body: { ok: false, error: "message_not_found" },
            }
          : undefined
      ),
      channelRunDelivery: {
        async find() {
          return ownedDelivery();
        },
        async markAcknowledged() {},
      },
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.deleteMessage, {
          channel: "C0123456789",
          ts: "1700000000.000100",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({ ok: true });
  });

  it("removes only the recorded Integration reaction and converges on no_reaction", async () => {
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      http: joinedHttp((call) =>
        call.path === "/reactions.remove"
          ? { status: 200, headers: {}, body: { ok: false, error: "no_reaction" } }
          : undefined
      ),
      channelRunDelivery: {
        async find() {
          return ownedDelivery();
        },
        async markAcknowledged() {},
      },
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.removeReaction, {
          channel: "C0123456789",
          timestamp: "1700000000.000009",
          emoji: "eyes",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({ ok: true, emoji: "eyes" });
  });

  it("runs the complete external File upload sequence through explicit byte seams", async () => {
    const calls: string[] = [];
    let uploadState: SlackFileUploadState | undefined;
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      fileUploads: {
        async find() {
          return uploadState;
        },
        async urlRequested(input) {
          expect(input.providerFileId).toBe("F1");
          uploadState = { ...input, phase: "url_requested" };
          calls.push("url_requested");
        },
        async advance(input) {
          if (uploadState === undefined) throw new Error("missing upload state");
          uploadState = { ...uploadState, phase: input.to };
          calls.push(input.to);
        },
      },
      http: joinedHttp((call) => {
        calls.push(call.path);
        if (call.path === "/files.getUploadURLExternal") {
          return {
            status: 200,
            headers: {},
            body: { ok: true, upload_url: "https://upload.slack.test/1", file_id: "F1" },
          };
        }
        if (call.path === "/files.completeUploadExternal") {
          return {
            status: 200,
            headers: {},
            body: { ok: true, files: [{ id: "F1", title: "report.pdf" }] },
          };
        }
        if (call.path === "/files.info") {
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              file: {
                id: "F1",
                name: "report.pdf",
                mimetype: "application/pdf",
                size: 3,
                channels: ["C0123456789"],
              },
            },
          };
        }
        return undefined;
      }),
      files: {
        async load() {
          return {
            filename: "report.pdf",
            mediaType: "application/pdf",
            bytes: new Uint8Array([1, 2, 3]),
          };
        },
      },
      externalUpload: {
        async upload(url, bytes, mediaType) {
          expect({ url, bytes: [...bytes], mediaType }).toEqual({
            url: "https://upload.slack.test/1",
            bytes: [1, 2, 3],
            mediaType: "application/pdf",
          });
          calls.push("bytes");
        },
      },
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.uploadFile, {
          channel: "C0123456789",
          fileId: "file-1",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({
      id: "F1",
      name: "report.pdf",
      mimetype: "application/pdf",
      size: 3,
    });
    expect(calls).toEqual([
      "/files.getUploadURLExternal",
      "url_requested",
      "bytes",
      "bytes_uploaded",
      "/files.completeUploadExternal",
      "completed",
      "/files.info",
    ]);
  });

  it("fails closed when the File byte upload seams are not configured", async () => {
    const adapter = new SlackToolAdapter({ http: joinedHttp(() => undefined) });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.uploadFile, {
          channel: "C0123456789",
          fileId: "file-1",
        }),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "file_upload_unavailable" });
  });

  it("renews url_requested after byte upload failure and completes only the new Slack File", async () => {
    let state: SlackFileUploadState | undefined;
    let urlRequests = 0;
    let byteUploads = 0;
    const completedIds: string[] = [];
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      fileUploads: {
        async find() {
          return state;
        },
        async urlRequested(input) {
          state = { ...input, phase: "url_requested" };
        },
        async advance(input) {
          if (state === undefined) throw new Error("missing upload state");
          state = { ...state, phase: input.to };
        },
      },
      files: uploadSource,
      externalUpload: {
        async upload() {
          byteUploads += 1;
          if (byteUploads === 1) throw new Error("PUT failed");
        },
      },
      http: joinedHttp((call) => {
        if (call.path === "/files.getUploadURLExternal") {
          urlRequests += 1;
          const id = `F${urlRequests}`;
          return {
            status: 200,
            headers: {},
            body: { ok: true, upload_url: `https://upload.slack.test/${id}`, file_id: id },
          };
        }
        if (call.path === "/files.completeUploadExternal") {
          const files =
            call.body !== null && typeof call.body === "object"
              ? Reflect.get(call.body, "files")
              : undefined;
          const first = Array.isArray(files) ? files[0] : undefined;
          const id =
            first !== null && typeof first === "object" ? Reflect.get(first, "id") : undefined;
          if (typeof id !== "string") throw new Error("missing File ID");
          completedIds.push(id);
          return { status: 200, headers: {}, body: { ok: true, files: [{ id }] } };
        }
        if (call.path === "/files.info") {
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              file: {
                id: "F2",
                name: "report.pdf",
                mimetype: "application/pdf",
                size: 3,
                channels: ["C0123456789"],
              },
            },
          };
        }
        return undefined;
      }),
    });
    const uploadRequest = request(SLACK_TOOL_IDS.uploadFile, {
      channel: "C0123456789",
      fileId: "file-1",
    });

    await expect(adapter.dispatch(uploadRequest, CREDENTIAL)).rejects.toMatchObject({
      code: "file_byte_upload_failed",
      retryable: false,
    });
    await expect(
      adapter.reconcile(
        {
          intent: uploadRequest.intent,
          idempotencyKey: uploadRequest.idempotencyKey,
          operation: SLACK_RECONCILIATION_OPERATIONS.uploadFile,
        },
        CREDENTIAL
      )
    ).resolves.toMatchObject({ outcome: "confirmed" });
    expect(urlRequests).toBe(2);
    expect(completedIds).toEqual(["F2"]);
  });

  it("confirms an ambiguous completion from the exact staged File without requesting a new upload", async () => {
    let state: SlackFileUploadState | undefined;
    let urlRequests = 0;
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      fileUploads: {
        async find() {
          return state;
        },
        async urlRequested(input) {
          state = { ...input, phase: "url_requested" };
        },
        async advance(input) {
          if (state === undefined) throw new Error("missing upload state");
          state = { ...state, phase: input.to };
        },
      },
      files: uploadSource,
      externalUpload: { async upload() {} },
      http: joinedHttp((call) => {
        if (call.path === "/files.getUploadURLExternal") {
          urlRequests += 1;
          return {
            status: 200,
            headers: {},
            body: { ok: true, upload_url: "https://upload.slack.test/F1", file_id: "F1" },
          };
        }
        if (call.path === "/files.completeUploadExternal") {
          return { status: 503, headers: {}, body: { ok: false, error: "internal_error" } };
        }
        if (call.path === "/files.info") {
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              file: {
                id: "F1",
                name: "report.pdf",
                mimetype: "application/pdf",
                size: 3,
                channels: ["C0123456789"],
              },
            },
          };
        }
        return undefined;
      }),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.uploadFile, {
          channel: "C0123456789",
          fileId: "file-1",
        }),
        CREDENTIAL
      )
    ).resolves.toMatchObject({ id: "F1" });
    expect(state?.phase).toBe("completed");
    expect(urlRequests).toBe(1);
  });

  it("does not retry a completed File upload when ownership persistence fails", async () => {
    let uploadState: SlackFileUploadState | undefined;
    let recordAttempts = 0;
    let uploadUrlCalls = 0;
    const adapter = new SlackToolAdapter({
      integrationIdentity: {
        async resolve() {
          return "integration-1";
        },
      },
      ownedObjects: {
        async owns() {
          return false;
        },
        async record() {
          recordAttempts += 1;
          if (recordAttempts === 1) throw new Error("database unavailable");
        },
        async remove() {},
        async findByCreationIntent() {
          return undefined;
        },
      },
      fileUploads: {
        async find() {
          return uploadState;
        },
        async urlRequested(input) {
          uploadState = { ...input, phase: "url_requested" };
        },
        async advance(input) {
          if (uploadState === undefined) throw new Error("missing upload state");
          uploadState = { ...uploadState, phase: input.to };
        },
      },
      http: joinedHttp((call) => {
        if (call.path === "/files.getUploadURLExternal") {
          uploadUrlCalls += 1;
          return {
            status: 200,
            headers: {},
            body: { ok: true, upload_url: "https://upload.slack.test/1", file_id: "F1" },
          };
        }
        if (call.path === "/files.completeUploadExternal") {
          return { status: 200, headers: {}, body: { ok: true, files: [{ id: "F1" }] } };
        }
        if (call.path === "/files.info") {
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              file: {
                id: "F1",
                name: "report.pdf",
                mimetype: "application/pdf",
                size: 3,
                channels: ["C0123456789"],
              },
            },
          };
        }
        return undefined;
      }),
      files: {
        async load() {
          return {
            filename: "report.pdf",
            mediaType: "application/pdf",
            bytes: new Uint8Array([1, 2, 3]),
          };
        },
      },
      externalUpload: { async upload() {} },
    });

    const uploadRequest = request(SLACK_TOOL_IDS.uploadFile, {
      channel: "C0123456789",
      fileId: "file-1",
    });
    await expect(adapter.dispatch(uploadRequest, CREDENTIAL)).rejects.toMatchObject({
      phase: "after_dispatch",
      code: "ownership_record_failed",
      retryable: false,
    });
    await expect(
      adapter.reconcile(
        {
          intent: uploadRequest.intent,
          idempotencyKey: uploadRequest.idempotencyKey,
          operation: SLACK_RECONCILIATION_OPERATIONS.uploadFile,
        },
        CREDENTIAL
      )
    ).resolves.toMatchObject({ outcome: "confirmed" });
    expect(uploadUrlCalls).toBe(1);
  });

  it("reconciles the staged File ID instead of starting a second upload after files.info fails", async () => {
    let uploadState: SlackFileUploadState | undefined;
    let uploadUrlCalls = 0;
    let fileInfoCalls = 0;
    const adapter = new SlackToolAdapter({
      integrationIdentity: {
        async resolve() {
          return "integration-1";
        },
      },
      ownedObjects: {
        async owns() {
          return false;
        },
        async record() {},
        async remove() {},
        async findByCreationIntent() {
          return undefined;
        },
      },
      fileUploads: {
        async find() {
          return uploadState;
        },
        async urlRequested(input) {
          uploadState = { ...input, phase: "url_requested" };
        },
        async advance(input) {
          if (uploadState === undefined) throw new Error("missing upload state");
          uploadState = { ...uploadState, phase: input.to };
        },
      },
      http: joinedHttp((call) => {
        if (call.path === "/files.getUploadURLExternal") {
          uploadUrlCalls += 1;
          return {
            status: 200,
            headers: {},
            body: { ok: true, upload_url: "https://upload.slack.test/1", file_id: "F1" },
          };
        }
        if (call.path === "/files.completeUploadExternal") {
          return { status: 200, headers: {}, body: { ok: true, files: [{ id: "F1" }] } };
        }
        if (call.path === "/files.info") {
          fileInfoCalls += 1;
          return fileInfoCalls === 1
            ? { status: 503, headers: {}, body: { ok: false, error: "internal_error" } }
            : {
                status: 200,
                headers: {},
                body: {
                  ok: true,
                  file: {
                    id: "F1",
                    name: "report.pdf",
                    mimetype: "application/pdf",
                    size: 3,
                    channels: ["C0123456789"],
                  },
                },
              };
        }
        return undefined;
      }),
      files: {
        async load() {
          return {
            filename: "report.pdf",
            mediaType: "application/pdf",
            bytes: new Uint8Array([1, 2, 3]),
          };
        },
      },
      externalUpload: { async upload() {} },
    });
    const uploadRequest = request(SLACK_TOOL_IDS.uploadFile, {
      channel: "C0123456789",
      fileId: "file-1",
    });

    await expect(adapter.dispatch(uploadRequest, CREDENTIAL)).rejects.toMatchObject({
      phase: "after_dispatch",
      code: "file_info_unavailable",
      retryable: false,
    });
    await expect(
      adapter.reconcile(
        {
          intent: uploadRequest.intent,
          idempotencyKey: uploadRequest.idempotencyKey,
          operation: SLACK_RECONCILIATION_OPERATIONS.uploadFile,
        },
        CREDENTIAL
      )
    ).resolves.toMatchObject({ outcome: "confirmed" });
    expect(uploadUrlCalls).toBe(1);
  });

  it("returns only allowlisted File metadata", async () => {
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      http: joinedHttp((call) =>
        call.path === "/files.info"
          ? {
              status: 200,
              headers: {},
              body: {
                ok: true,
                file: {
                  id: "F1",
                  name: "report.pdf",
                  mimetype: "application/pdf",
                  size: 3,
                  created: 7,
                  url_private: "secret",
                },
              },
            }
          : undefined
      ),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.getFileInfo, { channel: "C0123456789", fileId: "F1" }),
        CREDENTIAL
      )
    ).resolves.toEqual({
      id: "F1",
      name: "report.pdf",
      mimetype: "application/pdf",
      size: 3,
      created: 7,
    });
  });

  it("records added bookmarks and refuses removal without ownership", async () => {
    const recorded: string[] = [];
    const adapter = new SlackToolAdapter({
      ...governedOwnership(false, (id) => recorded.push(id)),
      http: joinedHttp((call) => {
        if (call.path === "/bookmarks.add") {
          expect(call.body).toEqual({
            channel_id: "C0123456789",
            type: "link",
            title: "Docs",
            link: "https://docs",
          });
          return {
            status: 200,
            headers: {},
            body: { ok: true, bookmark: { id: "Bk1" } },
          };
        }
        if (call.path === "/bookmarks.list") {
          return {
            status: 200,
            headers: {},
            body: { ok: true, bookmarks: [{ id: "Bk1", title: "Docs", link: "https://docs" }] },
          };
        }
        return undefined;
      }),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.manageBookmark, {
          operation: "add",
          channel: "C0123456789",
          title: "Docs",
          link: "https://docs",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({
      bookmarks: [{ id: "Bk1", title: "Docs", link: "https://docs" }],
    });
    expect(recorded).toEqual(["Bk1"]);
    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.manageBookmark, {
          operation: "remove",
          channel: "C0123456789",
          bookmarkId: "Bk1",
        }),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "bookmark_not_integration_owned" });
  });

  it("does not infer bookmark ownership from content after an ambiguous add", async () => {
    const recorded: string[] = [];
    let listCalls = 0;
    const adapter = new SlackToolAdapter({
      ...governedOwnership(false, (id) => recorded.push(id)),
      http: joinedHttp((call) => {
        if (call.path === "/bookmarks.add") {
          return { status: 503, headers: {}, body: { ok: false, error: "internal_error" } };
        }
        if (call.path === "/bookmarks.list") {
          listCalls += 1;
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              bookmarks: [{ id: "Bk-existing", title: "Docs", link: "https://docs" }],
            },
          };
        }
        return undefined;
      }),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.manageBookmark, {
          operation: "add",
          channel: "C0123456789",
          title: "Docs",
          link: "https://docs",
        }),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ phase: "after_dispatch" });
    expect(listCalls).toBe(0);
    expect(recorded).toEqual([]);
  });

  it.each([
    { operation: "list", channel: "C0123456789", bookmarkId: "Bk1" },
    { operation: "add", channel: "C0123456789", link: "https://docs" },
    { operation: "add", channel: "C0123456789", title: "Docs" },
    {
      operation: "add",
      channel: "C0123456789",
      bookmarkId: "Bk1",
      title: "Docs",
      link: "https://docs",
    },
    { operation: "edit", channel: "C0123456789", title: "Docs" },
    { operation: "edit", channel: "C0123456789", bookmarkId: "Bk1" },
    { operation: "remove", channel: "C0123456789" },
    {
      operation: "remove",
      channel: "C0123456789",
      bookmarkId: "Bk1",
      title: "not-allowed",
    },
  ])(
    "rejects operation-specific bookmark arguments before Slack calls: $operation",
    async (args) => {
      let calls = 0;
      const adapter = new SlackToolAdapter({
        ...governedOwnership(),
        http: {
          async send() {
            calls += 1;
            throw new Error("Slack must not be called");
          },
        },
      });

      await expect(
        adapter.dispatch(request(SLACK_TOOL_IDS.manageBookmark, args), CREDENTIAL)
      ).rejects.toMatchObject({ code: "invalid_arguments", phase: "before_dispatch" });
      expect(calls).toBe(0);
    }
  );

  it("lists, edits, and removes Integration-owned bookmarks", async () => {
    let bookmarks = [{ id: "Bk1", title: "Old", link: "https://old" }];
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      http: joinedHttp((call) => {
        if (call.path === "/bookmarks.list") {
          return { status: 200, headers: {}, body: { ok: true, bookmarks } };
        }
        if (call.path === "/bookmarks.edit") {
          bookmarks = [{ id: "Bk1", title: "New", link: "https://new" }];
          return { status: 200, headers: {}, body: { ok: true } };
        }
        if (call.path === "/bookmarks.remove") {
          bookmarks = [];
          return { status: 200, headers: {}, body: { ok: true } };
        }
        return undefined;
      }),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.manageBookmark, {
          operation: "list",
          channel: "C0123456789",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({
      bookmarks: [{ id: "Bk1", title: "Old", link: "https://old" }],
    });
    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.manageBookmark, {
          operation: "edit",
          channel: "C0123456789",
          bookmarkId: "Bk1",
          title: "New",
          link: "https://new",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({
      bookmarks: [{ id: "Bk1", title: "New", link: "https://new" }],
    });
    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.manageBookmark, {
          operation: "remove",
          channel: "C0123456789",
          bookmarkId: "Bk1",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({ bookmarks: [] });
  });

  it("records added pins and refuses removal without ownership", async () => {
    const recorded: string[] = [];
    let pinned = false;
    const adapter = new SlackToolAdapter({
      ...governedOwnership(false, (id) => recorded.push(id)),
      http: joinedHttp((call) => {
        if (call.path === "/pins.add") {
          pinned = true;
          return { status: 200, headers: {}, body: { ok: true } };
        }
        if (call.path === "/pins.list") {
          return {
            status: 200,
            headers: {},
            body: {
              ok: true,
              items: pinned ? [{ message: { ts: "1.1", text: "Pinned" } }] : [],
            },
          };
        }
        return undefined;
      }),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.managePin, {
          operation: "add",
          channel: "C0123456789",
          timestamp: "1.1",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({ pins: [{ timestamp: "1.1", text: "Pinned" }] });
    expect(recorded).toEqual(["1.1"]);
    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.managePin, {
          operation: "remove",
          channel: "C0123456789",
          timestamp: "1.1",
        }),
        CREDENTIAL
      )
    ).rejects.toMatchObject({ code: "pin_not_integration_owned" });
  });

  it("does not claim ownership of a pin that already existed before add", async () => {
    const recorded: string[] = [];
    let addCalls = 0;
    const adapter = new SlackToolAdapter({
      ...governedOwnership(false, (id) => recorded.push(id)),
      http: joinedHttp((call) => {
        if (call.path === "/pins.list") {
          return {
            status: 200,
            headers: {},
            body: { ok: true, items: [{ message: { ts: "1.1", text: "Pinned" } }] },
          };
        }
        if (call.path === "/pins.add") addCalls += 1;
        return undefined;
      }),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.managePin, {
          operation: "add",
          channel: "C0123456789",
          timestamp: "1.1",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({ pins: [{ timestamp: "1.1", text: "Pinned" }] });
    expect(addCalls).toBe(0);
    expect(recorded).toEqual([]);
  });

  it("recovers pin ownership on a provider retry after the first add became ambiguous", async () => {
    const recorded: string[] = [];
    let addCalls = 0;
    const adapter = new SlackToolAdapter({
      ...governedOwnership(false, (id) => recorded.push(id)),
      http: joinedHttp((call) => {
        if (call.path === "/pins.list") {
          return {
            status: 200,
            headers: {},
            body: { ok: true, items: [{ message: { ts: "1.1", text: "Pinned" } }] },
          };
        }
        if (call.path === "/pins.add") addCalls += 1;
        return undefined;
      }),
    });
    const retry = request(SLACK_TOOL_IDS.managePin, {
      operation: "add",
      channel: "C0123456789",
      timestamp: "1.1",
    });

    await expect(adapter.dispatch({ ...retry, attempt: 2 }, CREDENTIAL)).resolves.toEqual({
      pins: [{ timestamp: "1.1", text: "Pinned" }],
    });
    expect(addCalls).toBe(0);
    expect(recorded).toEqual(["1.1"]);
  });

  it("lists and removes Integration-owned pins", async () => {
    let pins = [{ message: { ts: "1.1", text: "Pinned" } }];
    const adapter = new SlackToolAdapter({
      ...governedOwnership(),
      http: joinedHttp((call) => {
        if (call.path === "/pins.list") {
          return { status: 200, headers: {}, body: { ok: true, items: pins } };
        }
        if (call.path === "/pins.remove") {
          pins = [];
          return { status: 200, headers: {}, body: { ok: true } };
        }
        return undefined;
      }),
    });

    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.managePin, {
          operation: "list",
          channel: "C0123456789",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({ pins: [{ timestamp: "1.1", text: "Pinned" }] });
    await expect(
      adapter.dispatch(
        request(SLACK_TOOL_IDS.managePin, {
          operation: "remove",
          channel: "C0123456789",
          timestamp: "1.1",
        }),
        CREDENTIAL
      )
    ).resolves.toEqual({ pins: [] });
  });

  it("returns only allowlisted user directory fields for exact and prefix lookup", async () => {
    const user = {
      id: "U1",
      name: "muskan",
      real_name: "Hidden",
      deleted: false,
      is_bot: false,
      profile: { display_name: "Muskan", email: "hidden@example.com", title: "Hidden" },
    };
    const adapter = new SlackToolAdapter({
      http: joinedHttp((call) => {
        if (call.path === "/users.info") {
          return { status: 200, headers: {}, body: { ok: true, user } };
        }
        if (call.path === "/users.list") {
          return { status: 200, headers: {}, body: { ok: true, members: [user] } };
        }
        return undefined;
      }),
    });

    const expected = {
      users: [{ id: "U1", displayName: "Muskan", isBotOrApp: false, deleted: false }],
    };
    await expect(
      adapter.dispatch(request(SLACK_TOOL_IDS.lookupUser, { userId: "U1" }), CREDENTIAL)
    ).resolves.toEqual(expected);
    await expect(
      adapter.dispatch(request(SLACK_TOOL_IDS.lookupUser, { query: "mus" }), CREDENTIAL)
    ).resolves.toEqual(expected);
  });
});
