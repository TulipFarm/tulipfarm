import { GitHubReplyError } from "@tulipfarm/integrations";
import type { PersistedChannelRunDeliveryRecord } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { type GitHubReplyLoopDeps, pollGitHubReplies } from "./reply-loop";

const row: PersistedChannelRunDeliveryRecord = {
  businessId: "business",
  runId: "run",
  integrationId: "installation",
  routeId: "route",
  provider: "github",
  destination: "TulipFarm/tulipfarm",
  threadId: "42",
  agentId: "agent",
  principalId: "linked-user",
  idempotencyKey: "event",
  status: "pending",
  leaseGeneration: 2,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};

function setup() {
  const runDeliveries: GitHubReplyLoopDeps["runDeliveries"] = {
    listPending: vi.fn(async () => [row]),
    claim: vi.fn<GitHubReplyLoopDeps["runDeliveries"]["claim"]>(async () => ({
      ...row,
      status: "delivering",
    })),
    markStatus: vi.fn(async () => row),
    retry: vi.fn(async () => false),
  };
  const runs: GitHubReplyLoopDeps["runs"] = {
    find: vi.fn().mockResolvedValue({ status: "succeeded" }),
  };
  const require = vi
    .fn()
    .mockImplementation(async (method: string) =>
      method === "GET"
        ? { status: "succeeded", text: "Answer" }
        : { token: "test-installation-token", botUserId: "123" }
    );
  const deliver = vi.fn().mockResolvedValue({ status: "confirmed" });
  const deps: GitHubReplyLoopDeps = {
    businessId: "business",
    runDeliveries,
    runs,
    internalApi: { require },
    delivery: { deliver },
    log: { warn: vi.fn() },
  };
  return { deps, require, deliver, runDeliveries };
}

describe("GitHub reply loop", () => {
  it("leases the exact claimed installation and completes with its generation fence", async () => {
    const { deps, require, deliver, runDeliveries } = setup();
    await pollGitHubReplies(new AbortController().signal, deps);
    expect(require).toHaveBeenCalledWith("POST", "/api/v1/internal/channels/github/credential", {
      integrationId: "installation",
      routeId: "route",
      runId: "run",
      destination: "TulipFarm/tulipfarm",
      leaseGeneration: 2,
    });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github", threadId: "42", principalId: "linked-user" }),
      { token: "test-installation-token", botUserId: "123" }
    );
    expect(runDeliveries.markStatus).toHaveBeenCalledWith("business", "run", "done", 2);
  });

  it("preserves durable retry deadlines and fences", async () => {
    const { deps, deliver, runDeliveries } = setup();
    deliver.mockRejectedValue(new GitHubReplyError("provider_rate_limited", true, 90_000));
    await pollGitHubReplies(new AbortController().signal, deps);
    expect(runDeliveries.retry).toHaveBeenCalledWith("business", "run", 2, 90_000);
    expect(runDeliveries.markStatus).not.toHaveBeenCalled();
  });

  it("never claims Slack deliveries", async () => {
    const { deps, runDeliveries, require } = setup();
    vi.mocked(runDeliveries.listPending).mockResolvedValue([{ ...row, provider: "slack" }]);
    await pollGitHubReplies(new AbortController().signal, deps);
    expect(runDeliveries.claim).not.toHaveBeenCalled();
    expect(require).not.toHaveBeenCalled();
  });
});
