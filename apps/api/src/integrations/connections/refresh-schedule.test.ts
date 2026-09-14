import { OIM_CONNECTION_REFRESH_CRON, OIM_CONNECTION_REFRESH_QUEUE } from "@tulipfarm/integrations";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  refreshExpiringOimConnections,
  registerOimConnectionRefreshSchedule,
} from "./refresh-schedule";

function fakeBoss() {
  const created: { name: string; options: unknown }[] = [];
  const scheduled: { name: string; cron: string }[] = [];
  return {
    created,
    scheduled,
    boss: {
      createQueue: async (name: string, options?: unknown) => {
        created.push({ name, options });
      },
      schedule: async (name: string, cron: string) => {
        scheduled.push({ name, cron });
      },
    },
  };
}

function connection(id: string): PersistedConnection {
  return {
    businessId: "business-1",
    id,
    integration: { id: "acme", majorVersion: 1 },
    label: id,
    owner: { scope: "personal", principalKind: "user", principalId: "principal-1" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: null },
    expiresAt: "2026-03-18T12:04:00.000Z",
    createdAt: new Date("2026-03-18T11:00:00.000Z"),
    updatedAt: new Date("2026-03-18T11:00:00.000Z"),
  };
}

describe("registerOimConnectionRefreshSchedule", () => {
  it("registers one exclusive durable refresh schedule", async () => {
    const { boss, created, scheduled } = fakeBoss();

    await registerOimConnectionRefreshSchedule(boss as never);

    expect(created).toEqual([
      { name: OIM_CONNECTION_REFRESH_QUEUE, options: { policy: "exclusive" } },
    ]);
    expect(scheduled).toEqual([
      { name: OIM_CONNECTION_REFRESH_QUEUE, cron: OIM_CONNECTION_REFRESH_CRON },
    ]);
  });

  it("refreshes Connections expiring within five minutes", async () => {
    const due = [connection("conn-1"), connection("conn-2")];
    const listExpiring = vi.fn(async () => due);
    const refresh = vi.fn(async () => {});
    const result = await refreshExpiringOimConnections({
      businessId: "business-1",
      connections: { listExpiring },
      refresh,
      now: () => new Date("2026-03-18T12:00:00.000Z"),
    });

    expect(listExpiring).toHaveBeenCalledWith("business-1", "2026-03-18T12:05:00.000Z");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, due[0]);
    expect(refresh).toHaveBeenNthCalledWith(2, due[1]);
    expect(result).toEqual({ examined: 2, refreshed: 2, failed: 0 });
  });

  it("continues after one Connection refresh fails", async () => {
    const first = connection("conn-1");
    const second = connection("conn-2");
    const error = new Error("provider unavailable");
    const refresh = vi.fn(async (candidate: PersistedConnection) => {
      if (candidate.id === first.id) throw error;
    });
    const log = { error: vi.fn() };
    const result = await refreshExpiringOimConnections({
      businessId: "business-1",
      connections: { listExpiring: async () => [first, second] },
      refresh,
      log,
    });

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ examined: 2, refreshed: 1, failed: 1 });
    expect(log.error).toHaveBeenCalledWith(
      { error, connectionId: first.id },
      "OIM Connection refresh failed"
    );
  });
});
