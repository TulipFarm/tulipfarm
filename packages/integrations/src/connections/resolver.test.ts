import type { OimConnection } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { ConnectionResolver, type ConnectionUseAuthorizer } from "./resolver";

const BUSINESS_ID = "business-1";
const USER_ID = "user-1";
const INTEGRATION = { id: "acme", majorVersion: 2 } as const;

function connection(
  id: string,
  owner: OimConnection["owner"],
  overrides: Partial<PersistedConnection> = {}
): PersistedConnection {
  return {
    businessId: BUSINESS_ID,
    id,
    integration: INTEGRATION,
    label: id,
    owner,
    status: "active",
    isDefault: false,
    configuration: { workspace: "visible", tenant: "hidden" },
    agentVisibleConfiguration: ["workspace"],
    secretBindings: { access: `secret://${id}` },
    health: { status: "healthy", checkedAt: "2026-09-12T00:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-09-12T00:00:00.000Z"),
    updatedAt: new Date("2026-09-12T00:00:00.000Z"),
    ...overrides,
  };
}

class MemoryConnections {
  constructor(private readonly rows: readonly PersistedConnection[]) {}

  async findById(businessId: string, id: string) {
    return this.rows.find((row) => row.businessId === businessId && row.id === id) ?? null;
  }

  async listForOwner(
    businessId: string,
    integration: OimConnection["integration"],
    owner: OimConnection["owner"]
  ) {
    return this.rows.filter(
      (row) =>
        row.businessId === businessId &&
        row.integration.id === integration.id &&
        row.integration.majorVersion === integration.majorVersion &&
        row.owner.scope === owner.scope &&
        (owner.scope === "organization" ||
          (owner.scope === "personal" &&
            row.owner.scope === "personal" &&
            row.owner.principalId === owner.principalId) ||
          (owner.scope === "team" &&
            row.owner.scope === "team" &&
            row.owner.teamId === owner.teamId))
    );
  }

  async listForIntegration(businessId: string, integration: OimConnection["integration"]) {
    return this.rows.filter(
      (row) =>
        row.businessId === businessId &&
        row.integration.id === integration.id &&
        row.integration.majorVersion === integration.majorVersion
    );
  }
}

function resolver(
  rows: readonly PersistedConnection[],
  canUse: ConnectionUseAuthorizer["canUse"] = async () => true
) {
  return new ConnectionResolver(new MemoryConnections(rows), { canUse });
}

describe("ConnectionResolver", () => {
  it("selects the caller's exact-major personal default before a shared default", async () => {
    const personal = connection(
      "personal",
      { scope: "personal", principalKind: "user", principalId: USER_ID },
      { isDefault: true }
    );
    const shared = connection("shared", { scope: "organization" }, { isDefault: true });
    const wrongMajor = connection(
      "old",
      { scope: "organization" },
      {
        integration: { id: "acme", majorVersion: 1 },
        isDefault: true,
      }
    );

    await expect(
      resolver([wrongMajor, shared, personal]).resolve({
        businessId: BUSINESS_ID,
        integration: INTEGRATION,
        identityMode: "shared_or_personal",
        principal: { kind: "user", id: USER_ID },
        personalOwnerId: USER_ID,
      })
    ).resolves.toEqual({ kind: "selected", connection: personal });
  });

  it("never crosses business, owner, major, or an exact recorded Connection", async () => {
    const otherOwner = connection("other", {
      scope: "personal",
      principalKind: "user",
      principalId: "user-2",
    });
    const wrongBusiness = connection(
      "cross-business",
      { scope: "organization" },
      {
        businessId: "business-2",
      }
    );
    const wrongMajor = connection(
      "old",
      { scope: "organization" },
      {
        integration: { id: "acme", majorVersion: 1 },
      }
    );

    for (const row of [otherOwner, wrongBusiness, wrongMajor]) {
      await expect(
        resolver([row]).resolve({
          businessId: BUSINESS_ID,
          integration: INTEGRATION,
          identityMode: "shared_or_personal",
          principal: { kind: "user", id: USER_ID },
          personalOwnerId: USER_ID,
          connectionId: row.id,
        })
      ).resolves.toMatchObject({ kind: "denied" });
    }
  });

  it("returns only authorized safe metadata when selection is required", async () => {
    const allowed = connection("allowed", { scope: "organization" });
    const denied = connection("denied", { scope: "organization" });
    const result = await resolver(
      [allowed, denied],
      async (_principal, row) => row.id === "allowed"
    ).resolve({
      businessId: BUSINESS_ID,
      integration: INTEGRATION,
      identityMode: "shared_only",
      principal: { kind: "routine", id: "routine-1" },
      requireExplicitConnection: true,
    });

    expect(result).toMatchObject({
      kind: "selection_required",
      candidates: [{ id: "allowed", configuration: { workspace: "visible" } }],
    });
    expect(JSON.stringify(result)).not.toContain("secret://");
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it("does not replace a revoked recorded Connection with a live default", async () => {
    const bound = connection("bound", { scope: "organization" }, { status: "revoked" });
    const fallback = connection("default", { scope: "organization" }, { isDefault: true });

    await expect(
      resolver([bound, fallback]).resolve({
        businessId: BUSINESS_ID,
        integration: INTEGRATION,
        identityMode: "shared_only",
        principal: { kind: "routine", id: "routine-1" },
        connectionId: "bound",
      })
    ).resolves.toEqual({ kind: "denied", reason: "inactive" });
  });

  it("does not select an arbitrary shared default or another principal's personal owner", async () => {
    const teamDefault = connection(
      "team",
      { scope: "team", teamId: "team-1" },
      { isDefault: true }
    );
    const organizationDefault = connection(
      "organization",
      { scope: "organization" },
      { isDefault: true }
    );

    await expect(
      resolver([teamDefault, organizationDefault]).resolve({
        businessId: BUSINESS_ID,
        integration: INTEGRATION,
        identityMode: "shared_only",
        principal: { kind: "routine", id: "routine-1" },
      })
    ).resolves.toMatchObject({ kind: "selection_required", reason: "ambiguous" });

    await expect(
      resolver([]).resolve({
        businessId: BUSINESS_ID,
        integration: INTEGRATION,
        identityMode: "personal_required",
        principal: { kind: "routine", id: "routine-1" },
        personalOwnerId: USER_ID,
      })
    ).resolves.toEqual({ kind: "denied", reason: "not_authorized" });
  });
});
