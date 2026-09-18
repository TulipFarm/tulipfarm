import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChannelDeliveryLedger, ChannelDeliveryRecord } from "../channels/ports";
import type { IntegrationHttpPort } from "../http";
import { GitHubReplyDelivery, type GitHubReplyRequest } from "./channel-delivery";

const request: GitHubReplyRequest = {
  businessId: "business",
  integrationId: "installation",
  routeId: "route",
  idempotencyKey: "event",
  provider: "github",
  destination: "TulipFarm/tulipfarm",
  agentId: "agent",
  principalId: "linked-user",
  threadId: "42",
  text: "The answer",
};

const credential = { token: "test-installation-token", botUserId: "123" };

function setup(status: ChannelDeliveryRecord["status"] = "pending", duplicate = false) {
  const record: ChannelDeliveryRecord = { ...request, status, attempts: 1 };
  const ledger: ChannelDeliveryLedger = {
    begin: vi.fn<ChannelDeliveryLedger["begin"]>(async () => ({
      outcome: duplicate ? "duplicate" : "started",
      record,
    })),
    complete: vi.fn<ChannelDeliveryLedger["complete"]>(async (_attempt, providerMessageId) => ({
      ...record,
      status: "confirmed",
      providerMessageId,
    })),
    fail: vi.fn<ChannelDeliveryLedger["fail"]>(async (_attempt, outcome) => ({
      ...record,
      status: outcome.status,
    })),
  };
  const send = vi.fn<IntegrationHttpPort["send"]>();
  const authorize = vi.fn(async () => "allowed" as const);
  const delivery = new GitHubReplyDelivery({
    ledger,
    authorization: { authorize },
    http: { send },
  });
  return { delivery, ledger, send, authorize };
}

describe("GitHub native replies", () => {
  it("posts only the bound repository thread and records the authenticated bot receipt", async () => {
    const { delivery, send, ledger } = setup();
    send.mockResolvedValue({
      status: 201,
      headers: {},
      body: { id: 7, user: { id: 123, type: "Bot" } },
    });
    expect((await delivery.deliver(request, credential)).providerMessageId).toBe("7");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/repos/TulipFarm/tulipfarm/issues/42/comments",
        body: { body: expect.stringContaining("The answer\n\n<!-- tulipfarm-reply:") },
      }),
      credential.token
    );
    expect(ledger.complete).toHaveBeenCalledWith(request, "7");
  });

  it("never blindly replays an uncertain write", async () => {
    const { delivery, send, ledger } = setup("ambiguous", true);
    send.mockResolvedValue({ status: 200, headers: {}, body: [] });
    await expect(delivery.deliver(request, credential)).rejects.toThrow(
      "uncertain_reply_requires_reconciliation"
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].method).toBe("GET");
    expect(ledger.complete).not.toHaveBeenCalled();
  });

  it("ignores forged markers and reconciles only the authenticated installation bot", async () => {
    const { delivery, send } = setup("ambiguous", true);
    const marker = createHash("sha256")
      .update(JSON.stringify([request.businessId, request.integrationId, request.idempotencyKey]))
      .digest("hex");
    const body = `The answer\n\n<!-- tulipfarm-reply:${marker} -->`;
    send.mockResolvedValue({
      status: 200,
      headers: {},
      body: [
        { id: 6, user: { id: 999, type: "Bot" }, body },
        { id: 7, user: { id: 123, type: "Bot" }, body },
      ],
    });
    expect((await delivery.deliver(request, credential)).providerMessageId).toBe("7");
    expect(send.mock.calls.every(([call]) => call.method === "GET")).toBe(true);
  });

  it("does not send a different provider's delivery", async () => {
    const { delivery, send, ledger } = setup();
    await expect(delivery.deliver({ ...request, provider: "slack" }, credential)).rejects.toThrow(
      "provider_mismatch"
    );
    expect(send).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
  });

  it("keeps a rate limit deadline and marks a lost response ambiguous", async () => {
    const limited = setup();
    limited.send.mockResolvedValue({ status: 429, headers: { "retry-after": "90" }, body: {} });
    await expect(limited.delivery.deliver(request, credential)).rejects.toMatchObject({
      retryAfterMs: 90_000,
    });
    expect(limited.ledger.fail).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ status: "retry_wait", retryAfterMs: 90_000 })
    );
    const lost = setup();
    lost.send.mockRejectedValue(new Error("connection lost"));
    await expect(lost.delivery.deliver(request, credential)).rejects.toThrow(
      "provider_unavailable"
    );
    expect(lost.ledger.fail).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ status: "ambiguous" })
    );
  });
});
