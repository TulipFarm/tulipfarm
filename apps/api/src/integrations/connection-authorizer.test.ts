import type { AuthorityLayer } from "@tulipfarm/authz";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { connectionUseAuthorizer } from "./connection-authorizer";

const BUSINESS = "business-1";

function connection(overrides: Partial<PersistedConnection> = {}): PersistedConnection {
  return {
    id: "connection-1",
    owner: { scope: "organization" },
    ...overrides,
  } as PersistedConnection;
}

function layer(grants: AuthorityLayer["grants"]): AuthorityLayer {
  return { name: "user", grants };
}

const ALLOW_USE: AuthorityLayer["grants"] = [
  { action: "connection.use", resourceType: "connection", effect: "allow" },
];

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
