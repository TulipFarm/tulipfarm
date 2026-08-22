import {
  AdapterDispatchError,
  type ToolAdapterRequest,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationHttpRequest, IntegrationHttpResponse } from "../http";
import { SLACK_TOOL_IDS } from "./contracts";
import { SlackToolAdapter } from "./tool-adapter";

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
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    expect(calls[1]?.query?.cursor).toBe("page-2");
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
      },
    });

    await adapter.dispatch(sendRequest("C0123456789", "here you go"), CREDENTIAL);

    expect(threadTs(http.calls)).toBeUndefined();
  });
});
