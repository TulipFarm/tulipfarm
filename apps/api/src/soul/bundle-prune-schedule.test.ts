import { SOUL_BUNDLE_RETENTION_DAYS } from "@tulipfarm/soul";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import {
  bundleRetentionMs,
  registerSoulBundlePruneSchedule,
  SOUL_BUNDLE_PRUNE_CRON,
  SOUL_BUNDLE_PRUNE_QUEUE,
} from "./bundle-prune-schedule";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("registerSoulBundlePruneSchedule", () => {
  it("publishes the configured retention without registering a consumer", async () => {
    const createQueue = vi.fn(async () => {});
    const schedule = vi.fn(async () => {});
    const boss = { createQueue, schedule } as unknown as PgBoss;

    await registerSoulBundlePruneSchedule(boss, 42_000);

    expect(createQueue).toHaveBeenCalledWith(SOUL_BUNDLE_PRUNE_QUEUE);
    expect(schedule).toHaveBeenCalledWith(SOUL_BUNDLE_PRUNE_QUEUE, SOUL_BUNDLE_PRUNE_CRON, {
      retentionMs: 42_000,
    });
  });
});

describe("bundleRetentionMs", () => {
  it("defaults to the shipped window", () => {
    expect(bundleRetentionMs({})).toBe(SOUL_BUNDLE_RETENTION_DAYS * DAY_MS);
  });

  it("accepts an operator override", () => {
    expect(bundleRetentionMs({ SOUL_BUNDLE_RETENTION_DAYS: "90" })).toBe(90 * DAY_MS);
  });

  it("clamps below the floor and ignores nonsense", () => {
    expect(bundleRetentionMs({ SOUL_BUNDLE_RETENTION_DAYS: "1" })).toBe(7 * DAY_MS);
    expect(bundleRetentionMs({ SOUL_BUNDLE_RETENTION_DAYS: "0" })).toBe(
      SOUL_BUNDLE_RETENTION_DAYS * DAY_MS
    );
    expect(bundleRetentionMs({ SOUL_BUNDLE_RETENTION_DAYS: "soon" })).toBe(
      SOUL_BUNDLE_RETENTION_DAYS * DAY_MS
    );
  });
});
