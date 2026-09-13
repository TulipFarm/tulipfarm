import type { ConnectionUseAuthorizer } from "@tulipfarm/integrations";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { oimCatalogStatus } from "./oim-catalog-status";

const principal = { id: "muskan", kind: "user" };
const now = Date.parse("2026-09-14T12:00:00.000Z");
const access: ConnectionUseAuthorizer = {
  async canUse(subject, connection) {
    return (
      connection.owner.scope === "organization" ||
      (connection.owner.scope === "personal" && connection.owner.principalId === subject.id)
    );
  },
};

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    id: "connection-1",
    businessId: "business-1",
    integration: { id: "acme", majorVersion: 1 },
    label: "Acme",
    owner: { scope: "personal", principalKind: "user", principalId: "muskan" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { token: "secret://acme/token" },
    health: { status: "healthy", checkedAt: "2026-09-14T11:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-09-14T10:00:00.000Z"),
    updatedAt: new Date("2026-09-14T11:00:00.000Z"),
    ...overrides,
  };
}

describe("OIM catalog Connection status", () => {
  it("does not equate an installed package with a connected account", async () => {
    await expect(oimCatalogStatus([], ["token"], principal, access, now)).resolves.toEqual({
      connected: false,
      personalConnected: false,
    });
  });

  it("shows an authorized healthy personal Connection as connected", async () => {
    await expect(
      oimCatalogStatus([connection()], ["token"], principal, access, now)
    ).resolves.toEqual({
      connected: true,
      personalConnected: true,
    });
  });

  it.each([
    connection({ status: "revoked" }),
    connection({ health: { status: "action_required", checkedAt: null } }),
    connection({ expiresAt: new Date(now - 1).toISOString() }),
    connection({ secretBindings: {} }),
    connection({ owner: { scope: "personal", principalKind: "user", principalId: "other" } }),
  ])("does not report an unusable or unauthorized Connection as connected", async (row) => {
    await expect(oimCatalogStatus([row], ["token"], principal, access, now)).resolves.toEqual({
      connected: false,
      personalConnected: false,
    });
  });
});
