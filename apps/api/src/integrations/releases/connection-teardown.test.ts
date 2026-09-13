import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { createOimReleaseConnectionTeardown } from "./connection-teardown";

const NOW = new Date("2026-09-13T00:00:00.000Z");

function connection(id: string, majorVersion = 2): PersistedConnection {
  return {
    businessId: "business-1",
    id,
    integration: { id: "acme", majorVersion },
    label: id,
    owner: { scope: "organization" },
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { token: `secret://${id}` },
    health: { status: "healthy", checkedAt: NOW.toISOString() },
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("OIM release Connection teardown", () => {
  it("lists and revokes only Connections in the exact Integration major", async () => {
    const target = connection("connection-1");
    const otherMajor = connection("connection-2", 3);
    const fenceRevocation = vi.fn(async (_businessId: string, connectionId: string) =>
      connectionId === target.id ? { ...target, status: "revoked" as const } : null
    );
    const revokeConnection = vi.fn(
      async (
        _connectionId: string,
        _bindings: Readonly<Record<string, string>>,
        persist: () => Promise<void>
      ) => persist()
    );
    const teardown = createOimReleaseConnectionTeardown({
      connections: {
        fenceRevocation,
        listForIntegration: async (_businessId, integration) =>
          [target, otherMajor].filter(
            (row) =>
              row.integration.id === integration.id &&
              row.integration.majorVersion === integration.majorVersion
          ),
      },
      credentials: { revokeConnection },
    });
    const scope = {
      businessId: "business-1",
      integrationId: "acme",
      majorVersion: 2,
      installationId: "installed-2026-09-13T09:00:00.000Z",
      slug: "weather-v1",
      packageDigest: "a".repeat(64),
      soulRevision: "soul-a1b2c3",
    };

    await expect(teardown.listConnections(scope)).resolves.toEqual([
      { ...scope, connectionId: "connection-1" },
    ]);
    await teardown.revokeConnection({ ...scope, connectionId: "connection-1" });

    expect(fenceRevocation).toHaveBeenCalledWith("business-1", "connection-1");
    expect(revokeConnection).toHaveBeenCalledWith(
      "connection-1",
      { token: "secret://connection-1" },
      expect.any(Function)
    );
  });
});
