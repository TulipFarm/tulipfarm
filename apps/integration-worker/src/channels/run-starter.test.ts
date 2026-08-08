import type { IntegrationHttpPort } from "@tulipfarm/integrations";
import { describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "../internal/client";
import { httpChannelRunStarter } from "./run-starter";

function client(fetchImpl: typeof globalThis.fetch): InternalApiClient {
  return new InternalApiClient({
    baseUrl: "http://api.internal",
    credential: "tfc_client.secret",
    fetch: fetchImpl,
  });
}

describe("httpChannelRunStarter", () => {
  it("mints a Run through the internal route, closing over its provider", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ runId: "run-1", outcome: "started" }), { status: 200 })
      );

    const result = await httpChannelRunStarter(client(fetchImpl), "slack").start({
      businessId: "business-1",
      eventId: "E1",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "agent-1",
      principal: { kind: "user", id: "user-1" },
      message: { externalAppId: "A1", channelId: "C1", text: "hi", media: [] },
    });

    expect(result).toEqual({ runId: "run-1", outcome: "started" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.internal/api/v1/internal/channels/runs");
    expect(JSON.parse(init.body as string)).toEqual({
      eventId: "E1",
      provider: "slack",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "agent-1",
      principal: { kind: "user", id: "user-1" },
      message: { externalAppId: "A1", channelId: "C1", text: "hi" },
    });
  });

  it("omits threadId when the message has none, and includes it when present", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ runId: "run-1", outcome: "duplicate" }), { status: 200 })
      );

    await httpChannelRunStarter(client(fetchImpl), "slack").start({
      businessId: "business-1",
      eventId: "E1",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "agent-1",
      principal: { kind: "guest", id: "guest-1" },
      message: {
        externalAppId: "A1",
        channelId: "C1",
        threadId: "1720000000.000100",
        text: "hi",
        media: [],
      },
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).message.threadId).toBe("1720000000.000100");
  });

  it("sets the assistant status indicator after a fresh Run starts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ runId: "run-1", outcome: "started" }), { status: 200 })
      );
    const send = vi.fn().mockResolvedValue({ status: 200, headers: {}, body: { ok: true } });
    const http: IntegrationHttpPort = { send };

    await httpChannelRunStarter(client(fetchImpl), "slack", {
      assistantStatus: { http, credential: "xoxb-leased" },
    }).start({
      businessId: "business-1",
      eventId: "E1",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "agent-1",
      principal: { kind: "user", id: "user-1" },
      message: {
        externalAppId: "A1",
        channelId: "C1",
        threadId: "1785000000.0001",
        text: "hi",
        media: [],
      },
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/assistant.threads.setStatus",
        body: expect.objectContaining({ channel_id: "C1", thread_ts: "1785000000.0001" }),
      }),
      "xoxb-leased"
    );
  });

  it("does not set assistant status for a duplicate outcome", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ runId: "run-1", outcome: "duplicate" }), { status: 200 })
      );
    const send = vi.fn();
    const http: IntegrationHttpPort = { send };

    await httpChannelRunStarter(client(fetchImpl), "slack", {
      assistantStatus: { http, credential: "xoxb-leased" },
    }).start({
      businessId: "business-1",
      eventId: "E1",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "agent-1",
      principal: { kind: "user", id: "user-1" },
      message: {
        externalAppId: "A1",
        channelId: "C1",
        threadId: "1785000000.0001",
        text: "hi",
        media: [],
      },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("does not set assistant status when the message has no threadId", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ runId: "run-1", outcome: "started" }), { status: 200 })
      );
    const send = vi.fn();
    const http: IntegrationHttpPort = { send };

    await httpChannelRunStarter(client(fetchImpl), "slack", {
      assistantStatus: { http, credential: "xoxb-leased" },
    }).start({
      businessId: "business-1",
      eventId: "E1",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "agent-1",
      principal: { kind: "user", id: "user-1" },
      message: { externalAppId: "A1", channelId: "C1", text: "hi", media: [] },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("swallows an assistant status failure without failing the Run start", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ runId: "run-1", outcome: "started" }), { status: 200 })
      );
    const http: IntegrationHttpPort = { send: vi.fn().mockRejectedValue(new Error("boom")) };
    const warn = vi.fn();

    const result = await httpChannelRunStarter(client(fetchImpl), "slack", {
      assistantStatus: { http, credential: "xoxb-leased", log: { warn } },
    }).start({
      businessId: "business-1",
      eventId: "E1",
      integrationId: "integration-1",
      routeId: "route-1",
      agentId: "agent-1",
      principal: { kind: "user", id: "user-1" },
      message: {
        externalAppId: "A1",
        channelId: "C1",
        threadId: "1785000000.0001",
        text: "hi",
        media: [],
      },
    });

    expect(result).toEqual({ runId: "run-1", outcome: "started" });
    expect(warn).toHaveBeenCalled();
  });
});
