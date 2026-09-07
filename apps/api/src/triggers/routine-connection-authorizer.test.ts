import { canonicalHash, definitions } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import type { AssetOwnershipRecord, PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { ActiveRoutineConnectionUseAuthorizer } from "./routine-connection-authorizer";

const BUSINESS_ID = "business-1";
const ROUTINE_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const TEAM_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_TEAM_ID = "00000000-0000-4000-8000-000000000005";

function routine(
  owner: string,
  ownership?: { readonly owners: readonly [{ readonly teamId: string }] }
) {
  return definitions.routine.validateRoutineDefinition({
    apiVersion: "tulipfarm.ai/v1",
    kind: "Routine",
    metadata: {
      id: ROUTINE_ID,
      slug: "daily-digest",
      schemaVersion: 1,
      authoredVersion: 3,
      lifecycle: "published",
    },
    spec: {
      owner,
      ...(ownership === undefined ? {} : { ownership }),
      start: "Start",
      states: [{ type: "compute", name: "Start", input: { value: 1 }, end: true }],
    },
  }).document;
}

function runtimeBundle(
  owner: string,
  ownership?: { readonly owners: readonly [{ readonly teamId: string }] }
): RuntimeBundle {
  const document = routine(owner, ownership);
  const definition = {
    kind: "Routine",
    id: ROUTINE_ID,
    slug: "daily-digest",
    authoredVersion: 3,
    hash: canonicalHash(document),
    document,
    references: [],
  };
  return {
    digest: "bundle-digest",
    businessId: BUSINESS_ID,
    changesetId: "changeset-1",
    commitSha: "commit-1",
    definitions: [definition],
    assets: [],
    get: (kind: string, slug: string) =>
      definition.kind === kind && definition.slug === slug ? definition : undefined,
    getById: (id: string) => (id === ROUTINE_ID ? definition : undefined),
    asset: () => undefined,
  };
}

function connection(
  owner: PersistedConnection["owner"],
  overrides: Partial<PersistedConnection> = {}
): PersistedConnection {
  return {
    businessId: BUSINESS_ID,
    id: "connection-1",
    integration: { id: "gitlab", majorVersion: 1 },
    label: "GitLab",
    owner,
    status: "active",
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: null },
    expiresAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function teamOwnership(shares: AssetOwnershipRecord["shares"] = []): AssetOwnershipRecord {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    businessId: BUSINESS_ID,
    assetType: "routine",
    assetId: ROUTINE_ID,
    owners: [{ kind: "team", teamId: TEAM_ID }],
    shares,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function authorizer(input: {
  readonly bundle?: RuntimeBundle;
  readonly ownership?: AssetOwnershipRecord;
  readonly user?: { readonly status: string } | null;
  readonly team?: { readonly status: string } | null;
  readonly organizationAllowed?: boolean;
}) {
  const organizationCanUse = vi.fn(async () => input.organizationAllowed ?? false);
  const users = {
    findById: vi.fn(async () => (input.user === undefined ? { status: "active" } : input.user)),
  };
  return {
    authorize: new ActiveRoutineConnectionUseAuthorizer({
      publications: {
        activeBundle: async () => input.bundle,
      } as never,
      verifier: {} as never,
      ownership: { get: async () => input.ownership },
      users,
      teams: {
        getTeam: async () =>
          input.team === undefined ? { status: "active" } : (input.team ?? undefined),
      },
      organizationConnectionAccess: { canUse: organizationCanUse },
    }),
    organizationCanUse,
    users,
  };
}

const routineRef = { name: "daily-digest", version: "3" };

describe("ActiveRoutineConnectionUseAuthorizer", () => {
  it("allows only the active exact owner of a personal Connection", async () => {
    const active = authorizer({ bundle: runtimeBundle(`user:${USER_ID}`) });

    await expect(
      active.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({
          scope: "personal",
          principalKind: "user",
          principalId: USER_ID,
        }),
      })
    ).resolves.toBe(true);
    await expect(
      active.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({
          scope: "personal",
          principalKind: "user",
          principalId: "another-user",
        }),
      })
    ).resolves.toBe(false);

    const disabled = authorizer({
      bundle: runtimeBundle(`user:${USER_ID}`),
      user: { status: "disabled" },
    });
    await expect(
      disabled.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({
          scope: "personal",
          principalKind: "user",
          principalId: USER_ID,
        }),
      })
    ).resolves.toBe(false);

    const missing = authorizer({ bundle: runtimeBundle(`user:${USER_ID}`), user: null });
    await expect(
      missing.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({
          scope: "personal",
          principalKind: "user",
          principalId: USER_ID,
        }),
      })
    ).resolves.toBe(false);
  });

  it("uses durable Team ownership, independent of the original creator", async () => {
    const test = authorizer({
      bundle: runtimeBundle(`user:${USER_ID}`, { owners: [{ teamId: TEAM_ID }] }),
      ownership: teamOwnership([{ teamId: OTHER_TEAM_ID, access: "use" }]),
      user: { status: "disabled" },
    });

    for (const teamId of [TEAM_ID, OTHER_TEAM_ID]) {
      await expect(
        test.authorize.canUse({
          businessId: BUSINESS_ID,
          routineRef,
          connection: connection({ scope: "team", teamId }),
        })
      ).resolves.toBe(true);
    }
    await expect(
      test.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({
          scope: "team",
          teamId: "00000000-0000-4000-8000-000000000006",
        }),
      })
    ).resolves.toBe(false);
    await expect(
      test.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({
          scope: "personal",
          principalKind: "user",
          principalId: USER_ID,
        }),
      })
    ).resolves.toBe(false);
    expect(test.users.findById).not.toHaveBeenCalled();

    for (const team of [{ status: "archived" }, null]) {
      const unavailable = authorizer({
        bundle: runtimeBundle(`user:${USER_ID}`, { owners: [{ teamId: TEAM_ID }] }),
        ownership: teamOwnership(),
        team,
      });
      await expect(
        unavailable.authorize.canUse({
          businessId: BUSINESS_ID,
          routineRef,
          connection: connection({ scope: "team", teamId: TEAM_ID }),
        })
      ).resolves.toBe(false);
    }
  });

  it("checks organization Connection grants as the pinned Routine, not its creator", async () => {
    const test = authorizer({
      bundle: runtimeBundle("organization"),
      organizationAllowed: true,
    });
    const organization = connection({ scope: "organization" });

    await expect(
      test.authorize.canUse({ businessId: BUSINESS_ID, routineRef, connection: organization })
    ).resolves.toBe(true);
    await expect(
      test.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({
          scope: "personal",
          principalKind: "user",
          principalId: USER_ID,
        }),
      })
    ).resolves.toBe(false);
    expect(test.organizationCanUse).toHaveBeenCalledWith(
      { kind: "routine", id: ROUTINE_ID },
      organization
    );
  });

  it("fails closed for an absent, stale, or unprojected Routine", async () => {
    const absent = authorizer({});
    await expect(
      absent.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({ scope: "organization" }),
      })
    ).resolves.toBe(false);

    const stale = authorizer({ bundle: runtimeBundle("organization") });
    await expect(
      stale.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef: { ...routineRef, version: "2" },
        connection: connection({ scope: "organization" }),
      })
    ).resolves.toBe(false);

    const unprojected = authorizer({
      bundle: runtimeBundle(`user:${USER_ID}`, { owners: [{ teamId: TEAM_ID }] }),
    });
    await expect(
      unprojected.authorize.canUse({
        businessId: BUSINESS_ID,
        routineRef,
        connection: connection({ scope: "team", teamId: TEAM_ID }),
      })
    ).resolves.toBe(false);
  });
});
