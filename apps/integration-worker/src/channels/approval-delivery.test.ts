import type { IntegrationHttpPort } from "@tulipfarm/integrations";
import type {
  ChannelRunDeliveryStore,
  PersistedChannelRunDeliveryRecord,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { InternalApiClient } from "../internal/client";
import { deliverPendingApproval } from "./approval-delivery";

function row(
  overrides: Partial<PersistedChannelRunDeliveryRecord> = {}
): PersistedChannelRunDeliveryRecord {
  return {
    businessId: "business-1",
    runId: "run-1",
    integrationId: "integration-1",
    routeId: "route-1",
    provider: "slack",
    destination: "C1",
    agentId: "agent-1",
    principalId: "user-1",
    idempotencyKey: "E1",
    status: "pending",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("deliverPendingApproval", () => {
  it("posts the Approve/Deny prompt and records it when a new approval is pending", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({
        pending: true,
        approvalId: "approval-1",
        toolName: "record_delete",
        args: { id: "record-1" },
      }),
    } as unknown as InternalApiClient;
    const send = vi.fn().mockResolvedValue({ body: { ok: true, ts: "1785000000.0002" } });
    const http = { send } as unknown as IntegrationHttpPort;
    const setApprovalPosted = vi.fn().mockResolvedValue(undefined);
    const runDeliveries = { setApprovalPosted } as unknown as ChannelRunDeliveryStore;

    await deliverPendingApproval(row(), {
      businessId: "business-1",
      internalApi,
      http,
      credential: "xoxb-leased",
      runDeliveries,
      log: { warn: vi.fn() },
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/chat.postMessage",
        body: expect.objectContaining({ channel: "C1" }),
      }),
      "xoxb-leased"
    );
    expect(setApprovalPosted).toHaveBeenCalledWith(
      "business-1",
      "run-1",
      "approval-1",
      "1785000000.0002"
    );
  });

  it("does not repost when the same approval was already posted", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({ pending: true, approvalId: "approval-1" }),
    } as unknown as InternalApiClient;
    const send = vi.fn();
    const http = { send } as unknown as IntegrationHttpPort;
    const runDeliveries = {
      setApprovalPosted: vi.fn(),
    } as unknown as ChannelRunDeliveryStore;

    await deliverPendingApproval(row({ approvalPostedId: "approval-1" }), {
      businessId: "business-1",
      internalApi,
      http,
      credential: "xoxb-leased",
      runDeliveries,
      log: { warn: vi.fn() },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing when no approval is pending", async () => {
    const internalApi = {
      require: vi.fn().mockResolvedValue({ pending: false }),
    } as unknown as InternalApiClient;
    const send = vi.fn();
    const http = { send } as unknown as IntegrationHttpPort;
    const runDeliveries = {
      setApprovalPosted: vi.fn(),
    } as unknown as ChannelRunDeliveryStore;

    await deliverPendingApproval(row(), {
      businessId: "business-1",
      internalApi,
      http,
      credential: "xoxb-leased",
      runDeliveries,
      log: { warn: vi.fn() },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a pending-approval check failure", async () => {
    const internalApi = {
      require: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as InternalApiClient;
    const http = { send: vi.fn() } as unknown as IntegrationHttpPort;
    const runDeliveries = {
      setApprovalPosted: vi.fn(),
    } as unknown as ChannelRunDeliveryStore;
    const warn = vi.fn();

    await expect(
      deliverPendingApproval(row(), {
        businessId: "business-1",
        internalApi,
        http,
        credential: "xoxb-leased",
        runDeliveries,
        log: { warn },
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
