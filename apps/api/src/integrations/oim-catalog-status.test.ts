import type { ConnectionUseAuthorizer } from "@tulipfarm/integrations";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { oimCatalogStatus } from "./oim-catalog-status";

const principal = { id: "muskan", kind: "user" };
const now = Date.parse("2026-08-01T12:00:00Z");
const access: ConnectionUseAuthorizer = {
  canUse: async (caller, connection) =>
    connection.owner.scope === "personal" && connection.owner.principalId === caller.id,
};

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    id: "connection-1",
    businessId: "business",
    integration: { id: "acme", majorVersion: 1 },
    label: "Personal account",
    owner: { scope: "personal", principalKind: "user", principalId: principal.id },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: { token: "secret://token" },
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  };
}

describe("OIM catalog Connection status", () => {
  it("does not equate an installed manifest with a connected account", async () => {
    expect(await oimCatalogStatus([], ["token"], principal, access, now)).toEqual({
      connected: false,
      personalConnected: false,
    });
  });

  it("shows an authorized active personal account as connected", async () => {
    expect(await oimCatalogStatus([connection()], ["token"], principal, access, now)).toEqual({
      connected: true,
      personalConnected: true,
    });
  });

  it.each([
    connection({ status: "revoked", isDefault: false }),
    connection({ health: { status: "action_required", checkedAt: null } }),
    connection({ secretBindings: {} }),
    connection({ expiresAt: new Date(now - 1).toISOString() }),
    connection({ owner: { scope: "personal", principalKind: "user", principalId: "other" } }),
    connection({ owner: { scope: "team", teamId: "other-team" } }),
  ])("does not report unusable or unauthorized accounts as connected", async (row) => {
    expect(await oimCatalogStatus([row], ["token"], principal, access, now)).toEqual({
      connected: false,
      personalConnected: false,
    });
  });
});
