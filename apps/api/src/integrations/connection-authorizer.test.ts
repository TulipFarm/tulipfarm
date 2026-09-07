import type { AuthorityLayer } from "@tulipfarm/authz";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { connectionUseAuthorizer } from "./connection-authorizer";

const BUSINESS = "business-1";

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    businessId: BUSINESS,
    id: "connection-1",
    integration: { id: "acme", majorVersion: 1 },
    label: "Acme",
    owner: { scope: "organization" },
    status: "active",
    isDefault: true,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function layer(grants: AuthorityLayer["grants"]): AuthorityLayer {
  return { name: "user", grants };
}

const ALLOW_USE: AuthorityLayer["grants"] = [
  { action: "connection.use", resourceType: "connection", effect: "allow" },
];

describe("live Connection user status", () => {
  it.each<PersistedConnection["owner"]>([
    { scope: "personal", principalKind: "user", principalId: "user-1" },
    { scope: "organization" },
    { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" },
  ])("denies a disabled user even when ownership or grants still exist", async (owner) => {
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () => layer(ALLOW_USE),
      hasTeamMembership: async () => true,
      isUserActive: async () => false,
    });
    await expect(
      authorizer.canUse({ kind: "user", id: "user-1" }, connection({ owner }))
    ).resolves.toBe(false);
  });

  it("rechecks user status rather than retaining a grant from an earlier attempt", async () => {
    const isUserActive = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () => layer(ALLOW_USE),
      hasTeamMembership: async () => true,
      isUserActive,
    });
    const personal = connection({
      owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
    });
    await expect(authorizer.canUse({ kind: "user", id: "user-1" }, personal)).resolves.toBe(true);
    await expect(authorizer.canUse({ kind: "user", id: "user-1" }, personal)).resolves.toBe(false);
  });
});

describe("connectionUseAuthorizer for personal Connections", () => {
  const resolvePrincipalLayer = vi.fn(async () => layer(ALLOW_USE));
  const authorizer = connectionUseAuthorizer({
    businessId: BUSINESS,
    resolvePrincipalLayer,
    hasTeamMembership: async () => false,
  });
  const personal = connection({
    owner: { scope: "personal", principalKind: "user", principalId: "user-1" },
  });

  it("admits only the owning human", async () => {
    await expect(authorizer.canUse({ kind: "user", id: "user-1" }, personal)).resolves.toBe(true);
  });

  it("refuses another human even when they hold the use grant", async () => {
    // A personal Connection is undelegatable, so no grant may open one to somebody else.
    await expect(authorizer.canUse({ kind: "user", id: "user-2" }, personal)).resolves.toBe(false);
  });

  it("refuses a non-human principal that shares the owner's id", async () => {
    await expect(authorizer.canUse({ kind: "agent", id: "user-1" }, personal)).resolves.toBe(false);
  });
});

describe("connectionUseAuthorizer for organization Connections", () => {
  it("admits a principal holding the use grant", async () => {
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () => layer(ALLOW_USE),
      hasTeamMembership: async () => false,
    });
    await expect(authorizer.canUse({ kind: "user", id: "user-1" }, connection())).resolves.toBe(
      true
    );
  });

  describe("connectionUseAuthorizer for Team Connections", () => {
    const team = connection({
      owner: { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" },
    });

    it("admits a member with effective access to the owning Team", async () => {
      const authorizer = connectionUseAuthorizer({
        businessId: BUSINESS,
        resolvePrincipalLayer: async () => layer([]),
        hasTeamMembership: async (_principalId, teamId) =>
          teamId === "00000000-0000-4000-8000-000000000004",
      });
      await expect(authorizer.canUse({ kind: "user", id: "user-1" }, team)).resolves.toBe(true);
    });

    it("denies a person with no access to the owning Team", async () => {
      const authorizer = connectionUseAuthorizer({
        businessId: BUSINESS,
        resolvePrincipalLayer: async () =>
          layer([{ action: "team.read", resourceType: "team", effect: "allow" }]),
        hasTeamMembership: async () => false,
      });
      await expect(authorizer.canUse({ kind: "user", id: "user-1" }, team)).resolves.toBe(false);
    });
  });

  it("denies by default when no grant says otherwise", async () => {
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () => layer([]),
      hasTeamMembership: async () => false,
    });
    await expect(authorizer.canUse({ kind: "user", id: "user-1" }, connection())).resolves.toBe(
      false
    );
  });

  it("does not accept a management grant as permission to spend the credential", async () => {
    // Administering a Connection and acting through it are separate authorities; a wildcard over
    // the management actions must not become a key to every organization credential.
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () =>
        layer([
          { action: "connection.rotate", resourceType: "connection", effect: "allow" },
          { action: "connection.revoke", resourceType: "connection", effect: "allow" },
        ]),
      hasTeamMembership: async () => false,
    });
    await expect(authorizer.canUse({ kind: "user", id: "user-1" }, connection())).resolves.toBe(
      false
    );
  });

  it("denies when the authority layer cannot be read", async () => {
    // An unreadable layer is not an empty one: failing open here would turn a database blip into
    // deployment-wide use of every organization credential.
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () => {
        throw new Error("database unavailable");
      },
      hasTeamMembership: async () => false,
    });
    await expect(authorizer.canUse({ kind: "user", id: "user-1" }, connection())).resolves.toBe(
      false
    );
  });

  it("resolves the layer for the calling principal's own kind", async () => {
    const resolvePrincipalLayer = vi.fn(async () => layer(ALLOW_USE));
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer,
      hasTeamMembership: async () => false,
    });
    await authorizer.canUse({ kind: "agent", id: "agent-7" }, connection());
    expect(resolvePrincipalLayer).toHaveBeenCalledWith("agent", {
      id: "agent-7",
      businessId: BUSINESS,
      kind: "agent",
    });
  });
});

describe("connectionUseAuthorizer for Integration-owned polling", () => {
  const authorizer = connectionUseAuthorizer({
    businessId: BUSINESS,
    resolvePrincipalLayer: async () => layer([]),
    hasTeamMembership: async () => false,
    isTeamActive: async () => true,
  });
  const sharedConnection = (owner: PersistedConnection["owner"]) =>
    connection({
      owner,
      integration: { id: "acme", majorVersion: 1 },
    });

  it.each<PersistedConnection["owner"]>([
    { scope: "organization" },
    { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" },
  ])("grants the exact Integration adapter its own $scope Connection", async (owner) => {
    await expect(
      authorizer.canUse(
        { kind: "integration_adapter", id: "integration:acme" },
        sharedConnection(owner)
      )
    ).resolves.toBe(true);
  });

  it("does not grant another Integration adapter the Connection", async () => {
    await expect(
      authorizer.canUse(
        { kind: "integration_adapter", id: "integration:other" },
        sharedConnection({ scope: "organization" })
      )
    ).resolves.toBe(false);
  });

  it("rechecks the Team before granting an adapter access", async () => {
    const isTeamActive = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const liveAuthorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () => layer(ALLOW_USE),
      hasTeamMembership: async () => true,
      isTeamActive,
    });
    const principal = { kind: "integration_adapter", id: "integration:acme" };
    const team = sharedConnection({ scope: "team", teamId: "team-1" });
    await expect(liveAuthorizer.canUse(principal, team)).resolves.toBe(true);
    await expect(liveAuthorizer.canUse(principal, team)).resolves.toBe(false);
    expect(isTeamActive).toHaveBeenNthCalledWith(2, "team-1");
  });

  it("refuses a Team adapter without a live Team reader", async () => {
    const unconfigured = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () => layer(ALLOW_USE),
      hasTeamMembership: async () => true,
    });
    await expect(
      unconfigured.canUse(
        { kind: "integration_adapter", id: "integration:acme" },
        sharedConnection({ scope: "team", teamId: "team-1" })
      )
    ).resolves.toBe(false);
  });
});

describe("Connection deployment boundary", () => {
  it.each([
    { kind: "user", id: "user-1" },
    { kind: "integration_adapter", id: "integration:acme" },
  ])("refuses a foreign deployment for $kind", async (principal) => {
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer: async () => layer(ALLOW_USE),
      hasTeamMembership: async () => true,
      isTeamActive: async () => true,
    });
    await expect(
      authorizer.canUse(principal, connection({ businessId: "another-business" }))
    ).resolves.toBe(false);
  });
});

describe("connectionUseAuthorizer for unknown principal kinds", () => {
  it("denies a kind the authority engine cannot resolve grants for", async () => {
    // A new principal kind must not reach organization credentials before anyone has decided what
    // it may hold, so an unresolvable kind is denied rather than passed through to the engine.
    const resolvePrincipalLayer = vi.fn(async () => layer(ALLOW_USE));
    const authorizer = connectionUseAuthorizer({
      businessId: BUSINESS,
      resolvePrincipalLayer,
      hasTeamMembership: async () => false,
    });
    await expect(authorizer.canUse({ kind: "webhook", id: "hook-1" }, connection())).resolves.toBe(
      false
    );
    expect(resolvePrincipalLayer).not.toHaveBeenCalled();
  });
});
