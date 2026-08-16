import { describe, expect, it, vi } from "vitest";
import {
  bundleRetentionMessage,
  pruneUnreferencedBundles,
  SOUL_BUNDLE_PRUNE_BATCH,
  SOUL_BUNDLE_PRUNE_MAX_BATCHES,
  SOUL_BUNDLE_RETENTION_MS,
} from "./bundle-retention";

const NOW = new Date("2026-08-16T00:00:00.000Z");

describe("pruneUnreferencedBundles", () => {
  it("stops on the first short batch and never deletes by age alone", async () => {
    const deleteUnreferencedBundles = vi.fn(async () => 3);
    const result = await pruneUnreferencedBundles({
      store: { deleteUnreferencedBundles },
      businessId: "business-1",
      now: NOW,
      batchSize: 10,
    });

    expect(result).toEqual({ deleted: 3, batches: 1, backlog: false });
    // The store's exclusion query is the only deletion decision; the cutoff is an extra filter.
    expect(deleteUnreferencedBundles).toHaveBeenCalledWith({
      businessId: "business-1",
      olderThan: new Date(NOW.getTime() - SOUL_BUNDLE_RETENTION_MS).toISOString(),
      limit: 10,
    });
  });

  it("keeps batching while every batch comes back full", async () => {
    const deleteUnreferencedBundles = vi
      .fn<(input: { limit: number }) => Promise<number>>()
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2);

    const result = await pruneUnreferencedBundles({
      store: { deleteUnreferencedBundles },
      businessId: "business-1",
      now: NOW,
      batchSize: 5,
    });

    expect(result).toEqual({ deleted: 12, batches: 3, backlog: false });
  });

  it("reports a backlog instead of running unbounded when the ceiling is hit", async () => {
    const deleteUnreferencedBundles = vi.fn(async () => 2);
    const result = await pruneUnreferencedBundles({
      store: { deleteUnreferencedBundles },
      businessId: "business-1",
      now: NOW,
      batchSize: 2,
      maxBatches: 4,
    });

    expect(result).toEqual({ deleted: 8, batches: 4, backlog: true });
    expect(deleteUnreferencedBundles).toHaveBeenCalledTimes(4);
  });

  it("falls back to the shipped bounds when the caller supplies none", async () => {
    const deleteUnreferencedBundles = vi.fn(async () => 0);
    await pruneUnreferencedBundles({
      store: { deleteUnreferencedBundles },
      businessId: "business-1",
      now: NOW,
      batchSize: 0,
      maxBatches: -1,
      retentionMs: 0,
    });

    expect(deleteUnreferencedBundles).toHaveBeenCalledWith({
      businessId: "business-1",
      olderThan: new Date(NOW.getTime() - SOUL_BUNDLE_RETENTION_MS).toISOString(),
      limit: SOUL_BUNDLE_PRUNE_BATCH,
    });
    expect(SOUL_BUNDLE_PRUNE_MAX_BATCHES).toBeGreaterThan(0);
  });

  it("names the backlog in the operator line", () => {
    expect(bundleRetentionMessage("business-1", { deleted: 4, batches: 1, backlog: false })).toBe(
      "[soul] bundle retention: deleted 4 unreferenced bundle(s) for business-1 in 1 batch(es)"
    );
    expect(
      bundleRetentionMessage("business-1", { deleted: 9, batches: 3, backlog: true })
    ).toContain("backlog remains");
  });
});
