import {
  type AssetAccessProjection,
  AssetOwnershipService,
  type ResolvedTeamMember,
} from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  InMemoryApprovalRepo,
  InMemoryAssetOwnershipRepo,
  InMemoryTeamRepo,
} from "@tulipfarm/storage";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RequireAuthorization } from "../authz/route-gate";
import { type TeamAssetCatalogMetadata, teamAssetKey } from "./catalog";
import { registerTeamAssetRoutes } from "./routes";
import { TeamAssetService } from "./service";

const TEAM = "123e4567-e89b-42d3-a456-426614174000";
const PARENT = "123e4567-e89b-42d3-a456-426614174001";
const APPROVAL_ID = "123e4567-e89b-42d3-a456-426614174099";
const PARENT_APPROVAL_ID = "123e4567-e89b-42d3-a456-426614174098";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const EXPIRES = new Date("2099-09-05T12:00:00.000Z");

const metadata: TeamAssetCatalogMetadata[] = [
  {
    assetType: "agent",
    id: "agent-owned",
    label: "Owned agent",
    description: "Exact Team owner",
    href: "/agents/agent-owned",
    lifecycleStatus: "active",
  },
  {
    assetType: "agent",
    id: "agent-hidden",
    label: "Hidden agent",
    description: "No effective access",
    href: "/agents/agent-hidden",
    lifecycleStatus: "active",
  },
  {
    assetType: "skill",
    id: "skill-inherited",
    label: "Inherited skill",
    description: "Parent Team owner",
    href: "/skills/skill-inherited",
    lifecycleStatus: "active",
  },
  {
    assetType: "routine",
    id: "routine-shared",
    label: "Shared routine",
    description: "Shared by parent Team",
    href: "/routines/routine-shared",
    lifecycleStatus: "active",
  },
  {
    assetType: "file",
    id: "11111111-1111-4111-8111-111111111111",
    label: "Archived plan.pdf",
    description: null,
    href: "/files/11111111-1111-4111-8111-111111111111",
    lifecycleStatus: "archived",
  },
  {
    assetType: "file",
    id: "41111111-1111-4111-8111-111111111111",
    label: "Shared personal notes.txt",
    description: null,
    href: "/files/41111111-1111-4111-8111-111111111111",
    lifecycleStatus: "active",
  },
  {
    assetType: "file",
    id: "51111111-1111-4111-8111-111111111111",
    label: "Private notes.txt",
    description: null,
    href: "/files/51111111-1111-4111-8111-111111111111",
    lifecycleStatus: "active",
  },
  {
    assetType: "knowledge",
    id: "page:21111111-1111-4111-8111-111111111111",
    label: "Operations page",
    description: "operations/runbook",
    href: "/knowledge/pages/21111111-1111-4111-8111-111111111111",
    lifecycleStatus: "active",
  },
  {
    assetType: "knowledge",
    id: "space:31111111-1111-4111-8111-111111111111",
    label: "Operations",
    description: "Operations space",
    href: "/knowledge/spaces/31111111-1111-4111-8111-111111111111",
    lifecycleStatus: "active",
  },
  {
    assetType: "knowledge",
    id: "source:slack:T1:C1",
    label: "slack: C1",
    description: "Knowledge source from slack",
    href: null,
    lifecycleStatus: "active",
  },
];

function resolved(principalId: string, level: "member" | "admin" | undefined, teamId: string) {
  if (level === undefined) return [];
  const member = (
    membership: "direct" | "inherited",
    pathTeamIds: string[]
  ): ResolvedTeamMember => ({
    membership,
    sourceTeamId: TEAM,
    pathTeamIds,
    principalId,
    principalKind: "user",
    level,
    removable: membership === "direct",
    revision: 1,
  });
  if (teamId === TEAM) return [member("direct", [TEAM])];
  if (teamId === PARENT) return [member("inherited", [TEAM, PARENT])];
  return [];
}

async function makeApp(
  principalId: string,
  level: "member" | "admin" | undefined,
  companyAdmin = false
) {
  const approvals = new InMemoryApprovalRepo();
  const ownershipRepo = new InMemoryAssetOwnershipRepo([], [], approvals);
  const teams = new InMemoryTeamRepo();
  const everyone = await teams.ensureEveryone(DEPLOYMENT_BUSINESS_ID);
  await teams.putTeam({
    id: PARENT,
    businessId: DEPLOYMENT_BUSINESS_ID,
    slug: "parent",
    displayName: "Parent",
    parentTeamId: everyone.id,
    status: "active",
    protected: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await teams.putTeam({
    id: TEAM,
    businessId: DEPLOYMENT_BUSINESS_ID,
    slug: "child",
    displayName: "Child",
    parentTeamId: PARENT,
    status: "active",
    protected: false,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (level !== undefined) {
    await teams.putMembership({
      teamId: TEAM,
      principalId,
      principalKind: "user",
      level,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const ownership = new AssetOwnershipService({
    ownership: ownershipRepo,
    approvals,
    memberships: {
      resolveMembers: async (_businessId, teamId) => resolved(principalId, level, teamId),
      resolvePrincipalForTeams: async (_businessId, teamIds) =>
        new Map(teamIds.map((teamId) => [teamId, resolved(principalId, level, teamId)])),
    },
    facts: { async emit() {} },
  });
  for (const item of metadata) {
    const personalFile = item.assetType === "file" && item.id.startsWith("4");
    const privateFile = item.assetType === "file" && item.id.startsWith("5");
    await ownership.create({
      businessId: DEPLOYMENT_BUSINESS_ID,
      assetType: item.assetType,
      assetId: item.id,
      owners:
        personalFile || privateFile
          ? [{ kind: "principal", principalId: "personal-owner", principalKind: "user" }]
          : item.assetType === "routine"
            ? [{ kind: "team", teamId: "123e4567-e89b-42d3-a456-426614174005" }]
            : [{ kind: "team", teamId: item.assetType === "skill" ? PARENT : TEAM }],
      shares:
        item.assetType === "routine"
          ? [{ teamId: PARENT, access: "edit" }]
          : personalFile
            ? [{ teamId: TEAM, access: "view" }]
            : [],
    });
  }
  const accessMany = ownership.accessMany.bind(ownership);
  ownership.accessMany = async (records, principal) => {
    const access = new Map<string, AssetAccessProjection>(await accessMany(records, principal));
    access.set(teamAssetKey("agent", "agent-hidden"), {
      levels: [],
      canManageOwnership: false,
      evidence: [],
    });
    return access;
  };
  await approvals.create({
    approvalId: APPROVAL_ID,
    businessId: DEPLOYMENT_BUSINESS_ID,
    binding: {
      intentDigest: "intent",
      evidenceDigest: "evidence",
      guardrailRevision: "asset-ownership-v1",
    },
    risk: "high",
    allowedApproverRoles: [`team:${TEAM}:admin`],
    requiredApproverRoles: [`team:${TEAM}:admin`],
    proposerPrincipalId: "proposer",
    preview: "archive agent-owned",
    riskSummary: "Changes shared asset ownership or lifecycle",
    expiresAt: EXPIRES,
    createdAt: NOW,
  });
  await ownershipRepo.createOperation({
    id: APPROVAL_ID,
    approvalId: APPROVAL_ID,
    businessId: DEPLOYMENT_BUSINESS_ID,
    assetType: "agent",
    assetId: "agent-owned",
    action: "archive",
    expectedOwnershipRevision: 1,
    status: "pending",
    revision: 1,
    createdAt: NOW,
  });
  await approvals.create({
    approvalId: PARENT_APPROVAL_ID,
    businessId: DEPLOYMENT_BUSINESS_ID,
    binding: {
      intentDigest: "parent-intent",
      evidenceDigest: "parent-evidence",
      guardrailRevision: "asset-ownership-v1",
    },
    risk: "high",
    allowedApproverRoles: [`team:${PARENT}:admin`],
    requiredApproverRoles: [`team:${PARENT}:admin`],
    proposerPrincipalId: "proposer",
    preview: "archive skill-inherited",
    riskSummary: "Changes shared asset ownership or lifecycle",
    expiresAt: EXPIRES,
    createdAt: NOW,
  });
  await ownershipRepo.createOperation({
    id: PARENT_APPROVAL_ID,
    approvalId: PARENT_APPROVAL_ID,
    businessId: DEPLOYMENT_BUSINESS_ID,
    assetType: "skill",
    assetId: "skill-inherited",
    action: "archive",
    expectedOwnershipRevision: 1,
    status: "pending",
    revision: 1,
    createdAt: NOW,
  });
  const service = new TeamAssetService({
    ownership,
    ownershipRepo,
    approvals,
    teams,
    catalogMemberships: {
      resolvePrincipalForTeams: async (_businessId, teamIds) =>
        new Map(teamIds.map((teamId) => [teamId, resolved(principalId, level, teamId)])),
    },
    catalogMetadata: {
      async load(records) {
        const requested = new Set(
          records.map((record) => teamAssetKey(record.assetType, record.assetId))
        );
        return new Map(
          metadata
            .filter((item) => requested.has(teamAssetKey(item.assetType, item.id)))
            .map((item) => [teamAssetKey(item.assetType, item.id), item])
        );
      },
    },
  });
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.principal = {
      id: principalId,
      kind: "user",
      ...(companyAdmin ? { role: "admin" as const } : {}),
      businessId: DEPLOYMENT_BUSINESS_ID,
      credential: "session",
      authMethods: [],
      authenticatedAt: NOW,
    };
  });
  registerTeamAssetRoutes(
    app,
    service,
    async () => undefined,
    (() => async () => undefined) as RequireAuthorization
  );
  await app.ready();
  return app;
}

describe("Team asset catalog route", () => {
  const apps: Awaited<ReturnType<typeof makeApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function appFor(
    principalId: string,
    level: "member" | "admin" | undefined,
    companyAdmin = false
  ) {
    const app = await makeApp(principalId, level, companyAdmin);
    apps.push(app);
    return app;
  }

  it("paginates canonical rows without disclosing governance details to a member", async () => {
    const app = await appFor("member-1", "member");
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?limit=2`,
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(2);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const owned = first.json().items.find((item: { id: string }) => item.id === "agent-owned");
    expect(owned).toMatchObject({
      id: "agent-owned",
      type: "agent",
      source: "owned",
      effectiveLevels: ["view", "use"],
      canManageOwnership: false,
      lifecycleStatus: "active",
      sourceTeamIds: [],
      ownership: null,
      pendingApprovals: [],
    });
    expect(first.json().items.map((item: { id: string }) => item.id)).not.toContain("agent-hidden");

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().items.map((item: { id: string }) => item.id)).not.toContain("agent-owned");
  });

  it("labels inherited and shared sources and applies server filters", async () => {
    const app = await appFor("member-1", "member");
    const inherited = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?source=inherited`,
    });
    expect(inherited.statusCode, inherited.body).toBe(200);
    expect(inherited.json().items).toEqual([
      expect.objectContaining({
        id: "skill-inherited",
        source: "inherited",
        sourceTeamIds: [],
        effectiveLevels: ["view", "use"],
      }),
    ]);

    const shared = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?source=shared&access=edit&type=routine`,
    });
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json().items).toEqual([
      expect.objectContaining({
        id: "routine-shared",
        source: "shared",
        sourceTeamIds: [],
        effectiveLevels: ["view", "use", "edit"],
      }),
    ]);
  });

  it("gives Edit only to an exact owning-Team admin", async () => {
    const app = await appFor("admin-1", "admin");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?type=agent`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const owned = response.json().items.find((item: { id: string }) => item.id === "agent-owned");
    expect(owned).toMatchObject({
      effectiveLevels: ["view", "use", "edit"],
      canManageOwnership: true,
      pendingApprovals: [
        expect.objectContaining({
          representedTeamId: TEAM,
          canDecide: true,
        }),
      ],
      ownership: {
        owners: [{ kind: "team", teamId: TEAM }],
      },
    });

    const inherited = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?type=skill`,
    });

    expect(inherited.json().items[0]).toMatchObject({
      effectiveLevels: ["view", "use"],
      canManageOwnership: false,
    });
  });

  it("lets explicit company governance enumerate zero-access rows and inspect governance", async () => {
    const app = await appFor("company-admin", undefined, true);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?type=agent`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent-hidden",
          effectiveLevels: [],
          ownership: expect.objectContaining({
            owners: [{ kind: "team", teamId: TEAM }],
          }),
        }),
        expect.objectContaining({
          id: "agent-owned",
          pendingApprovals: [expect.objectContaining({ operationId: APPROVAL_ID })],
        }),
      ])
    );
  });

  it("keeps a company admin's Team Overview Approvals scoped to the requested Team", async () => {
    const app = await appFor("company-admin", undefined, true);
    const scoped = await app.inject({
      method: "GET",
      url: `/api/v1/team-assets/approvals?teamId=${TEAM}`,
    });

    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(scoped.json().items.map((item: { approvalId: string }) => item.approvalId)).toEqual([
      APPROVAL_ID,
    ]);

    const companyWide = await app.inject({
      method: "GET",
      url: "/api/v1/team-assets/approvals",
    });
    expect(companyWide.statusCode, companyWide.body).toBe(200);
    expect(
      new Set(companyWide.json().items.map((item: { approvalId: string }) => item.approvalId))
    ).toEqual(new Set([APPROVAL_ID, PARENT_APPROVAL_ID]));
  });

  it("returns Pages, Spaces, and connected sources as distinct Knowledge assets", async () => {
    const app = await appFor("member-1", "member");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?type=knowledge`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([
      "page:21111111-1111-4111-8111-111111111111",
      "source:slack:T1:C1",
      "space:31111111-1111-4111-8111-111111111111",
    ]);
  });

  it("filters by owner Team and lifecycle status", async () => {
    const app = await appFor("member-1", "member");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?ownerTeamId=${TEAM}&lifecycleStatus=archived`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        type: "file",
        lifecycleStatus: "archived",
      }),
    ]);
  });

  it("includes a personal asset only when it is shared with the Team", async () => {
    const app = await appFor("member-1", "member");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets?type=file&source=shared`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({
        id: "41111111-1111-4111-8111-111111111111",
        source: "shared",
        effectiveLevels: ["view"],
      }),
    ]);
  });

  it("does not disclose the Team catalog to a company outsider", async () => {
    const app = await appFor("outsider", undefined);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${TEAM}/assets`,
    });

    expect(response.statusCode).toBe(403);
  });
});
