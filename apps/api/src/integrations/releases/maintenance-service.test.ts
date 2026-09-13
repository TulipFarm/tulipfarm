import type { EgressHttpPort } from "@tulipfarm/integrations";
import { describe, expect, it, vi } from "vitest";
import { createOimReleaseMaintenanceService } from "./maintenance-service";

function httpResponse(status: number, body: unknown): EgressHttpPort {
  return {
    async send() {
      return { status, headers: {}, body };
    },
  };
}

describe("createOimReleaseMaintenanceService", () => {
  it("does no network work when the maintenance feed is disabled", async () => {
    const send = vi.fn();
    const run = vi.fn();
    const service = createOimReleaseMaintenanceService({
      http: { send },
      store: { getRevocationFeed: async () => null },
      run,
    });

    await expect(service.runOnce("business-1")).resolves.toEqual({
      feed: "disabled",
      patches: [],
    });
    expect(send).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("fetches a bounded governed feed and delegates one maintenance cycle", async () => {
    const feed = { feedVersion: 1, revocations: {}, releases: [] };
    const run = vi.fn(async () => ({ revocations: "updated" as const, patches: [] }));
    const send = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify(feed),
    }));
    const service = createOimReleaseMaintenanceService({
      http: { send },
      store: {
        getRevocationFeed: async () => ({
          url: "https://updates.example/oim-feed.json",
          updatedAt: "2026-09-13T09:00:00.000Z",
          updatedBy: "operator-1",
        }),
      },
      run,
    });

    await expect(service.runOnce("business-1")).resolves.toEqual({
      feed: "updated",
      patches: [],
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        maxResponseBytes: 1024 * 1024,
        url: "https://updates.example/oim-feed.json",
      })
    );
    expect(run).toHaveBeenCalledWith(feed, "business-1");
  });

  it("rejects oversized and unsuccessful feed responses before maintenance", async () => {
    const run = vi.fn();
    const configured = {
      getRevocationFeed: async () => ({
        url: "https://updates.example/oim-feed.json",
        updatedAt: "2026-09-13T09:00:00.000Z",
        updatedBy: "operator-1",
      }),
    };

    await expect(
      createOimReleaseMaintenanceService({
        http: httpResponse(200, "x".repeat(1024 * 1024 + 1)),
        store: configured,
        run,
      }).runOnce("business-1")
    ).rejects.toThrow("oim_release_feed_too_large");
    await expect(
      createOimReleaseMaintenanceService({
        http: httpResponse(503, "{}"),
        store: configured,
        run,
      }).runOnce("business-1")
    ).rejects.toThrow("oim_release_feed_http_503");
    expect(run).not.toHaveBeenCalled();
  });
});
