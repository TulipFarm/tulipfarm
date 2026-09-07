import type { OimConnection } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import {
  type ConnectionResolutionRequest,
  ConnectionResolver,
  type ConnectionUseAuthorizer,
} from "./resolver";

const BUSINESS_ID = "business-1";
const USER_ID = "user-1";
const INTEGRATION = { id: "linear", majorVersion: 1 } as const;

function connection(
  id: string,
  owner: OimConnection["owner"],
  options: Partial<PersistedConnection> = {}
): PersistedConnection {
  return {
    businessId: BUSINESS_ID,
    id,
    integration: INTEGRATION,
    label: id,
    owner,
    status: "active",
    isDefault: false,
    configuration: { workspace: "visible", tenant: "sealed-metadata" },
    agentVisibleConfiguration: ["workspace"],
    secretBindings: { api_key: `secret://${id}` },
    health: { status: "healthy", checkedAt: "2026-04-13T00:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-04-13T00:00:00.000Z"),
    updatedAt: new Date("2026-04-13T00:00:00.000Z"),
    ...options,
  };
}

class MemoryConnectionReader {
  constructor(private readonly connections: readonly PersistedConnection[]) {}

  async findById(businessId: string, id: string): Promise<PersistedConnection | null> {
    return (
      this.connections.find(
        (connection) => connection.businessId === businessId && connection.id === id
      ) ?? null
    );
  }

  async listForOwner(
    businessId: string,
    integration: OimConnection["integration"],
    owner: OimConnection["owner"]
  ): Promise<PersistedConnection[]> {
    return this.connections.filter(
      (connection) =>
        connection.businessId === businessId &&
        connection.integration.id === integration.id &&
        connection.integration.majorVersion === integration.majorVersion &&
        connection.owner.scope === owner.scope &&
        (owner.scope === "organization" ||
          (owner.scope === "personal" &&
            connection.owner.scope === "personal" &&
            connection.owner.principalId === owner.principalId) ||
          (owner.scope === "team" &&
            connection.owner.scope === "team" &&
            connection.owner.teamId === owner.teamId))
    );
  }

  async listForIntegration(
    businessId: string,
    integration: OimConnection["integration"]
  ): Promise<PersistedConnection[]> {
    return this.connections.filter(
      (connection) =>
        connection.businessId === businessId &&
        connection.integration.id === integration.id &&
        connection.integration.majorVersion === integration.majorVersion
    );
  }
}

function resolver(
  connections: readonly PersistedConnection[],
  canUse: ConnectionUseAuthorizer["canUse"] = async () => true
) {
  return new ConnectionResolver(new MemoryConnectionReader(connections), { canUse });
}

function request(
  overrides: Partial<ConnectionResolutionRequest> = {}
): ConnectionResolutionRequest {
  return {
    businessId: BUSINESS_ID,
    integration: INTEGRATION,
    identityMode: "shared_or_personal",
    principal: { kind: "user", id: USER_ID },
    personalOwnerId: USER_ID,
    ...overrides,
  };
}

describe("ConnectionResolver", () => {
  it("prefers the caller's personal default over an organization default", async () => {
    const personal = connection(
      "personal-default",
      { scope: "personal", principalKind: "user", principalId: USER_ID },
      { isDefault: true }
    );
    const organization = connection("org-default", { scope: "organization" }, { isDefault: true });

    await expect(resolver([organization, personal]).resolve(request())).resolves.toEqual({
      kind: "selected",
      connection: personal,
    });
  });

  it("uses only organization Connections for shared-only operations", async () => {
    const personal = connection(
      "personal-default",
      { scope: "personal", principalKind: "user", principalId: USER_ID },
      { isDefault: true }
    );
    const organization = connection("org-default", { scope: "organization" }, { isDefault: true });

    await expect(
      resolver([personal, organization]).resolve(request({ identityMode: "shared_only" }))
    ).resolves.toEqual({ kind: "selected", connection: organization });
  });

  it("uses a Team default for a member before an organization default", async () => {
    const team = connection(
      "team-default",
      { scope: "team", teamId: "00000000-0000-4000-8000-000000000004" },
      { isDefault: true }
    );
    const organization = connection("org-default", { scope: "organization" }, { isDefault: true });

    await expect(
      resolver([organization, team]).resolve(request({ identityMode: "shared_only" }))
    ).resolves.toEqual({ kind: "selected", connection: team });
  });

  it("does not fall back to organization credentials for personal-required operations", async () => {
    const organization = connection("org-default", { scope: "organization" }, { isDefault: true });

    await expect(
      resolver([organization]).resolve(request({ identityMode: "personal_required" }))
    ).resolves.toEqual({ kind: "selection_required", reason: "missing", candidates: [] });
  });

  it("returns only authorized, safe metadata when a live choice is required", async () => {
    const allowed = connection("allowed", { scope: "organization" });
    const denied = connection("denied", { scope: "organization" });

    const result = await resolver(
      [allowed, denied],
      async (_principal, candidate) => candidate.id === allowed.id
    ).resolve(request({ personalOwnerId: undefined }));

    expect(result).toEqual({
      kind: "selection_required",
      reason: "no_default",
      candidates: [
        {
          id: "allowed",
          integration: INTEGRATION,
          label: "allowed",
          ownerScope: "organization",
          isDefault: false,
          configuration: { workspace: "visible" },
          health: allowed.health,
          expiresAt: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret://");
    expect(JSON.stringify(result)).not.toContain("sealed-metadata");
  });

  it("requires an explicit choice when more than one authorized Connection has no default", async () => {
    const first = connection("first", { scope: "organization" });
    const second = connection("second", { scope: "organization" });

    await expect(
      resolver([second, first]).resolve(request({ personalOwnerId: undefined }))
    ).resolves.toMatchObject({
      kind: "selection_required",
      reason: "ambiguous",
      candidates: [{ id: "second" }, { id: "first" }],
    });
  });

  it("does not use a default when a persistent caller requires an exact Connection", async () => {
    const organization = connection("org-default", { scope: "organization" }, { isDefault: true });

    await expect(
      resolver([organization]).resolve(
        request({ personalOwnerId: undefined, requireExplicitConnection: true })
      )
    ).resolves.toMatchObject({
      kind: "selection_required",
      reason: "no_default",
      candidates: [{ id: "org-default" }],
    });
  });

  it("never resolves another user's personal Connection by exact ID", async () => {
    const other = connection("other-personal", {
      scope: "personal",
      principalKind: "user",
      principalId: "user-2",
    });
    let authorizationChecks = 0;

    await expect(
      resolver([other], async () => {
        authorizationChecks += 1;
        return true;
      }).resolve(request({ connectionId: other.id }))
    ).resolves.toEqual({ kind: "denied", reason: "not_authorized" });
    expect(authorizationChecks).toBe(0);
  });

  it("does not let a user claim another personal owner identity", async () => {
    const other = connection(
      "other-personal",
      { scope: "personal", principalKind: "user", principalId: "user-2" },
      { isDefault: true }
    );

    await expect(
      resolver([other]).resolve(request({ personalOwnerId: "user-2" }))
    ).resolves.toEqual({ kind: "denied", reason: "not_authorized" });
  });

  it("rechecks personal ownership even when the repository returns an over-broad list", async () => {
    const other = connection(
      "other-personal",
      { scope: "personal", principalKind: "user", principalId: "user-2" },
      { isDefault: true }
    );
    const broadReader = {
      findById: async () => null,
      listForOwner: async () => [other],
      listForIntegration: async () => [other],
    };

    await expect(
      new ConnectionResolver(broadReader, { canUse: async () => true }).resolve(
        request({ identityMode: "personal_required" })
      )
    ).resolves.toEqual({ kind: "selection_required", reason: "missing", candidates: [] });
  });

  it("reauthorizes an exact Routine binding and never substitutes a default", async () => {
    const bound = connection("bound", { scope: "organization" }, { status: "revoked" });
    const fallback = connection("default", { scope: "organization" }, { isDefault: true });

    await expect(
      resolver([bound, fallback]).resolve(
        request({
          principal: { kind: "routine", id: "routine-1" },
          personalOwnerId: undefined,
          connectionId: bound.id,
        })
      )
    ).resolves.toEqual({ kind: "denied", reason: "inactive" });
  });

  it("enforces identity mode on an exact binding", async () => {
    const organization = connection("org", { scope: "organization" });

    await expect(
      resolver([organization]).resolve(
        request({ identityMode: "personal_required", connectionId: organization.id })
      )
    ).resolves.toEqual({ kind: "denied", reason: "identity_mode" });
  });
});
