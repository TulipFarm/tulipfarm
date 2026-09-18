import type {
  OimKnowledgeCheckpoint,
  OimKnowledgeSubscription,
  OimKnowledgeSubscriptionStore,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { runSubscribedKnowledgeSync } from "./subscribed-sync";

function subscription(): OimKnowledgeSubscription {
  return {
    businessId: "business",
    integrationSlug: "wiki",
    integrationId: "wiki",
    integrationMajorVersion: 1,
    connectionId: "connection",
    sourceKindId: "space",
    scopes: ["selected"],
    classification: ["confidential"],
    aclMaximumAgeSeconds: 60,
    liveMaximumAgeSeconds: 30,
    enabled: true,
    revision: 1,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorCodes: [],
  };
}

function checkpoint(): OimKnowledgeCheckpoint {
  return {
    businessId: "business",
    integrationId: "wiki",
    integrationMajorVersion: 1,
    connectionId: "connection",
    sourceKind: "space",
    scope: "selected",
    baselineItemIds: [],
    scanId: null,
    continuation: null,
    accumulatedSeenItemIds: [],
    pendingDeletionItemIds: [],
    cursorWatermark: null,
    pendingCursorWatermark: null,
    requiresFullRebuild: false,
    revision: 1,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date().toISOString(),
  };
}

describe("runSubscribedKnowledgeSync production wrapper", () => {
  it("records success only when every selected checkpoint completed", async () => {
    const selected = subscription();
    const recordAttempt = vi.fn<OimKnowledgeSubscriptionStore["recordAttempt"]>(async () => {});
    const load = vi.fn(async () => checkpoint());
    const now = () => new Date("2026-09-17T12:00:00Z");
    const dependencies = {
      subscriptions: { list: async () => [selected], recordAttempt },
      checkpoints: { load },
      now,
      sync: async (assertSelected: () => Promise<void>) => {
        await assertSelected();
        return { failures: [] };
      },
    };
    await runSubscribedKnowledgeSync(selected, dependencies);
    expect(recordAttempt).toHaveBeenLastCalledWith(selected, [], true, now());
    load.mockResolvedValue({ ...checkpoint(), scanId: "unfinished" });
    await runSubscribedKnowledgeSync(selected, dependencies);
    expect(recordAttempt).toHaveBeenLastCalledWith(selected, [], false, now());
  });

  it("does not run disabled or outdated selections and detects a mid-request disable", async () => {
    let selected = subscription();
    const recordAttempt = vi.fn<OimKnowledgeSubscriptionStore["recordAttempt"]>(async () => {});
    const sync = vi.fn(async (assertSelected: () => Promise<void>) => {
      selected = { ...selected, enabled: false, revision: 2 };
      await assertSelected();
      return { failures: [] };
    });
    const dependencies = {
      subscriptions: { list: async () => [selected], recordAttempt },
      checkpoints: { load: async () => checkpoint() },
      now: () => new Date(),
      sync,
    };
    await expect(runSubscribedKnowledgeSync(selected, dependencies)).rejects.toThrow(
      "knowledge_subscription_changed"
    );
    expect(recordAttempt.mock.calls[0]?.[1]).toEqual(["sync_failed"]);
    sync.mockClear();
    await runSubscribedKnowledgeSync(selected, dependencies);
    expect(sync).not.toHaveBeenCalled();
    selected = { ...selected, enabled: true };
    await runSubscribedKnowledgeSync({ ...selected, scopes: ["previous"] }, dependencies);
    expect(sync).not.toHaveBeenCalled();
  });
});
