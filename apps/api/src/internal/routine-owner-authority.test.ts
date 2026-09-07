import { canonicalHash, definitions } from "@tulipfarm/schema";
import type { AssetOwnershipRecord } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  RoutineOwnerAuthorityHost,
  type RoutineOwnerAuthorityHostDeps,
} from "./routine-owner-authority";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const ROUTINE_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const TEAM_ID = "00000000-0000-4000-8000-000000000004";

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

function dependencies(
  owner: string,
  options: {
    readonly ownership?: AssetOwnershipRecord;
    readonly user?: { readonly status: string } | null;
    readonly documentOwnership?: { readonly owners: readonly [{ readonly teamId: string }] };
    readonly routineVersion?: string;
  } = {}
): RoutineOwnerAuthorityHostDeps {
  const document = routine(owner, options.documentOwnership);
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
    businessId: BUSINESS_ID,
    runs: {
      find: vi.fn(async () => ({
        businessId: BUSINESS_ID,
        source: "routine",
        bundle: {
          digest: "bundle-digest",
          routineId: ROUTINE_ID,
          routineVersion: options.routineVersion ?? "3",
        },
      })),
    },
    bundles: {
      load: vi.fn(async () => ({
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
      })),
    },
    ownership: {
      get: vi.fn(async () => options.ownership),
    },
    users: {
      findById: vi.fn(async () =>
        options.user === undefined ? { status: "active" } : options.user
      ),
    },
  };
}

function teamOwnership(): AssetOwnershipRecord {
  const at = new Date("2026-09-07T00:00:00.000Z");
  return {
    businessId: BUSINESS_ID,
    assetType: "routine",
    assetId: ROUTINE_ID,
    owners: [{ kind: "team", teamId: TEAM_ID }],
    shares: [],
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
}

describe("RoutineOwnerAuthorityHost", () => {
  it("re-checks a personal owner on every dispatch decision", async () => {
    const deps = dependencies(`user:${USER_ID}`);
    const findById = vi.mocked(deps.users.findById);
    const host = new RoutineOwnerAuthorityHost(deps);

    await expect(host.checkRoutineOwner({ runId: RUN_ID })).resolves.toEqual({
      status: "allowed",
      ownership: "personal",
    });
    findById.mockResolvedValue({ status: "disabled" });
    await expect(host.checkRoutineOwner({ runId: RUN_ID })).resolves.toEqual({
      status: "denied",
      reason: "personal_owner_disabled",
    });
    expect(findById).toHaveBeenCalledTimes(2);
  });

  it("denies a missing personal owner", async () => {
    const host = new RoutineOwnerAuthorityHost(dependencies(`user:${USER_ID}`, { user: null }));

    await expect(host.checkRoutineOwner({ runId: RUN_ID })).resolves.toEqual({
      status: "denied",
      reason: "personal_owner_missing",
    });
  });

  it("fails closed for a non-canonical personal owner reference", async () => {
    const deps = dependencies(`user:${USER_ID}:extra`);
    const host = new RoutineOwnerAuthorityHost(deps);

    await expect(host.checkRoutineOwner({ runId: RUN_ID })).resolves.toEqual({
      status: "unavailable",
    });
    expect(deps.users.findById).not.toHaveBeenCalled();
  });

  it("keeps Team and organization Routines independent of their creator", async () => {
    const teamDeps = dependencies(`user:${USER_ID}`, {
      ownership: teamOwnership(),
      user: { status: "disabled" },
    });
    const organizationDeps = dependencies("organization", {
      user: { status: "disabled" },
    });

    await expect(
      new RoutineOwnerAuthorityHost(teamDeps).checkRoutineOwner({ runId: RUN_ID })
    ).resolves.toEqual({ status: "allowed", ownership: "team" });
    await expect(
      new RoutineOwnerAuthorityHost(organizationDeps).checkRoutineOwner({ runId: RUN_ID })
    ).resolves.toEqual({ status: "allowed", ownership: "organization" });
    expect(teamDeps.users.findById).not.toHaveBeenCalled();
    expect(organizationDeps.users.findById).not.toHaveBeenCalled();
  });

  it("fails closed when Team metadata has no durable ownership projection", async () => {
    const host = new RoutineOwnerAuthorityHost(
      dependencies(`user:${USER_ID}`, {
        documentOwnership: { owners: [{ teamId: TEAM_ID }] },
      })
    );

    await expect(host.checkRoutineOwner({ runId: RUN_ID })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails closed when the persisted Run does not match its pinned Routine", async () => {
    const host = new RoutineOwnerAuthorityHost(
      dependencies(`user:${USER_ID}`, { routineVersion: "2" })
    );

    await expect(host.checkRoutineOwner({ runId: RUN_ID })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails closed when a live authority dependency is unavailable", async () => {
    const deps = dependencies(`user:${USER_ID}`);
    vi.mocked(deps.users.findById).mockRejectedValue(new Error("database unavailable"));

    await expect(
      new RoutineOwnerAuthorityHost(deps).checkRoutineOwner({ runId: RUN_ID })
    ).resolves.toEqual({ status: "unavailable" });
  });
});
