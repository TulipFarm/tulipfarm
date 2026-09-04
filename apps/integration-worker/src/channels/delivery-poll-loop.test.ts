import type { IntegrationHttpPort, SlackDeliveryAdapter } from "@tulipfarm/integrations";
import type {
  ChannelRunDeliveryStore,
  PersistedChannelRunDeliveryRecord,
  PersistedRun,
  RunStore,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { InternalApiClient } from "../internal/client";
import { THINKING_STATUS } from "../slack/thinking-status";
import { startDeliveryPollLoop } from "./delivery-poll-loop";

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

function persistedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    id: "run-1",
    businessId: "business-1",
    source: "chat",
    bundle: { routineId: "r1", version: 1 },
    identity: { kind: "user", id: "user-1" },
    bounds: {},
    status: "running",
    version: 1,
    createdAt: "2026-08-04T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    resultArtifactId: null,
    errorEvidenceRef: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...overrides,
  } as unknown as PersistedRun;
}

/** Runs the loop for exactly one tick by aborting from inside `wait`. */
async function runOneTick(deps: Parameters<typeof startDeliveryPollLoop>[1]): Promise<void> {
  const controller = new AbortController();
  const loop = startDeliveryPollLoop(controller.signal, {
    ...deps,
    wait: async () => {
      controller.abort();
    },
  });
  await loop.settled;
}

describe("startDeliveryPollLoop", () => {
  it("sets the assistant status indicator for a still-running Run", async () => {
    const listPending = vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]);
    const runDeliveries = {
      listPending,
      markStatus: vi.fn(),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "running" })),
    } as unknown as RunStore;
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus, deliver: vi.fn() } as unknown as SlackDeliveryAdapter;
    const internalApi = { require: vi.fn() } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(setStatus).toHaveBeenCalledWith(
      { destination: "C1", threadId: "1785000000.0001", status: THINKING_STATUS },
      "xoxb-leased"
    );
  });

  it("delivers the reply and marks done when the Run succeeds", async () => {
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]),
      markStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "succeeded" })),
    } as unknown as RunStore;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus: vi.fn(), deliver } as unknown as SlackDeliveryAdapter;
    const internalApi = {
      require: vi.fn().mockResolvedValue({ status: "succeeded", text: "The answer is 42." }),
    } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "The answer is 42.",
        agentDisplayName: "agent-1",
        threadId: "1785000000.0001",
      }),
      "xoxb-leased"
    );
    expect(runDeliveries.markStatus).toHaveBeenCalledWith("business-1", "run-1", "done");
  });

  it("prefers reply.agentDisplayName over the raw agentId when the reply endpoint returns it", async () => {
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]),
      markStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "succeeded" })),
    } as unknown as RunStore;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus: vi.fn(), deliver } as unknown as SlackDeliveryAdapter;
    const internalApi = {
      require: vi.fn().mockResolvedValue({
        status: "succeeded",
        text: "The answer is 42.",
        agentDisplayName: "TulipFarm Assistant",
      }),
    } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ agentDisplayName: "TulipFarm Assistant" }),
      "xoxb-leased"
    );
  });

  it("passes reply.blocks through to delivery when the reply endpoint returns them", async () => {
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]),
      markStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "succeeded" })),
    } as unknown as RunStore;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus: vi.fn(), deliver } as unknown as SlackDeliveryAdapter;
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
    const internalApi = {
      require: vi
        .fn()
        .mockResolvedValue({ status: "succeeded", text: "The answer is 42.", blocks }),
    } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ blocks }), "xoxb-leased");
  });

  it("omits blocks from delivery when the reply endpoint doesn't return them", async () => {
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]),
      markStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "succeeded" })),
    } as unknown as RunStore;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus: vi.fn(), deliver } as unknown as SlackDeliveryAdapter;
    const internalApi = {
      require: vi.fn().mockResolvedValue({ status: "succeeded", text: "The answer is 42." }),
    } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.not.objectContaining({ blocks: expect.anything() }),
      "xoxb-leased"
    );
  });

  it("marks failed and posts a failure message when the Run fails", async () => {
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]),
      markStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "failed" })),
    } as unknown as RunStore;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus: vi.fn(), deliver } as unknown as SlackDeliveryAdapter;
    const internalApi = {
      require: vi.fn(),
      find: vi.fn().mockResolvedValue(undefined),
    } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: "C1",
        threadId: "1785000000.0001",
        text: "Something went wrong answering this — please try again.",
      }),
      "xoxb-leased"
    );
    expect(internalApi.find).toHaveBeenCalledWith(
      "GET",
      "/api/v1/internal/channels/runs/run-1/reply",
      [404]
    );
    expect(internalApi.require).not.toHaveBeenCalled();
    expect(runDeliveries.markStatus).toHaveBeenCalledWith("business-1", "run-1", "failed");
  });

  it("uses the reason-specific failure copy recovered from the reply route", async () => {
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]),
      markStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "failed" })),
    } as unknown as RunStore;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus: vi.fn(), deliver } as unknown as SlackDeliveryAdapter;
    const internalApi = {
      require: vi.fn(),
      find: vi.fn().mockResolvedValue({ status: "failed", reason: "model_rate_limited" }),
    } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "The model provider is rate-limiting us right now. I retried automatically but it's still throttled — please try again shortly.",
      }),
      "xoxb-leased"
    );
  });

  it("falls back to the generic failure message when recovering the reason errors", async () => {
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]),
      markStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "cancelled" })),
    } as unknown as RunStore;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus: vi.fn(), deliver } as unknown as SlackDeliveryAdapter;
    const internalApi = {
      require: vi.fn(),
      find: vi.fn().mockRejectedValue(new Error("internal api unreachable")),
    } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Something went wrong answering this — please try again.",
      }),
      "xoxb-leased"
    );
    expect(runDeliveries.markStatus).toHaveBeenCalledWith("business-1", "run-1", "failed");
  });

  it("swallows a single row's failure so other pending rows still get polled", async () => {
    const rows = [row({ runId: "run-1" }), row({ runId: "run-2", threadId: "ts-2" })];
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue(rows),
      markStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const find = vi.fn().mockImplementation((_businessId: string, runId: string) => {
      if (runId === "run-1") throw new Error("boom");
      return Promise.resolve(persistedRun({ status: "running" }));
    });
    const runs = { find } as unknown as RunStore;
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus, deliver: vi.fn() } as unknown as SlackDeliveryAdapter;
    const internalApi = { require: vi.fn() } as unknown as InternalApiClient;
    const warn = vi.fn();

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      credential: "xoxb-leased",
      log: { warn },
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("run-1"), expect.any(Error));
    expect(setStatus).toHaveBeenCalledWith(
      { destination: "C1", threadId: "ts-2", status: THINKING_STATUS },
      "xoxb-leased"
    );
  });

  it("posts the approval prompt for a still-running Run when an http port is supplied", async () => {
    const runDeliveries = {
      listPending: vi.fn().mockResolvedValue([row({ threadId: "1785000000.0001" })]),
      markStatus: vi.fn(),
      setApprovalPosted: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelRunDeliveryStore;
    const runs = {
      find: vi.fn().mockResolvedValue(persistedRun({ status: "running" })),
    } as unknown as RunStore;
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const delivery = { setStatus, deliver: vi.fn() } as unknown as SlackDeliveryAdapter;
    const send = vi.fn().mockResolvedValue({ body: { ok: true, ts: "1785000000.0003" } });
    const http = { send } as unknown as IntegrationHttpPort;
    const internalApi = {
      require: vi.fn().mockResolvedValue({
        pending: true,
        approvalId: "approval-1",
        toolName: "record_delete",
      }),
    } as unknown as InternalApiClient;

    await runOneTick({
      businessId: "business-1",
      runDeliveries,
      runs,
      internalApi,
      delivery,
      http,
      credential: "xoxb-leased",
      log: { warn: vi.fn() },
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/chat.postMessage" }),
      "xoxb-leased"
    );
    expect(runDeliveries.setApprovalPosted).toHaveBeenCalledWith(
      "business-1",
      "run-1",
      "approval-1",
      "1785000000.0003"
    );
  });
});
