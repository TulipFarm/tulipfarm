import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequireAuthorization } from "../authz/route-gate";
import { registerTeamAssetRoutes } from "./routes";
import type { TeamAssetService } from "./service";

const TEAM_ID = "123e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

describe("Team asset routes", () => {
  const service = {
    projection: vi.fn(async () => ({
      ownership: {
        businessId: "business-1",
        assetType: "routine",
        assetId: ASSET_ID,
        owners: [{ kind: "team", teamId: TEAM_ID }],
        shares: [],
        revision: 1,
      },
      access: {
        levels: ["view", "use"],
        canManageOwnership: false,
        evidence: [{ source: "team_owner", teamId: TEAM_ID, access: "use", inherited: true }],
      },
    })),
    updateShares: vi.fn(async () => ({
      businessId: "business-1",
      assetType: "routine",
      assetId: ASSET_ID,
      owners: [{ kind: "team", teamId: TEAM_ID }],
      shares: [{ teamId: TEAM_ID, access: "use" }],
      revision: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    propose: vi.fn(async () => ({ id: OPERATION_ID, status: "pending" })),
    decide: vi.fn(async () => ({ approvalId: OPERATION_ID, decisions: [] })),
    emergencyOverride: vi.fn(async () => ({
      businessId: "business-1",
      assetType: "routine",
      assetId: ASSET_ID,
      owners: [{ kind: "team", teamId: TEAM_ID }],
      shares: [],
      revision: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    listApprovalsPage: vi.fn(async () => ({
      items: [
        {
          approvalId: OPERATION_ID,
          operationId: OPERATION_ID,
          assetType: "agent",
          assetId: ASSET_ID,
          action: "delete",
          risk: "high",
          preview: "delete agent",
          riskSummary: "Changes shared asset ownership or lifecycle",
          status: "pending",
          requiredTeamIds: [TEAM_ID],
          decisions: 0,
          requiredDecisions: 1,
          representedTeamId: TEAM_ID,
          canDecide: true,
          expiresAt: "2026-09-06T12:00:00.000Z",
          createdAt: "2026-09-05T12:00:00.000Z",
        },
      ],
      nextCursor: "next-page",
    })),
    complete: vi.fn(async () => ({
      businessId: "business-1",
      assetType: "routine",
      assetId: ASSET_ID,
      owners: [{ kind: "team", teamId: TEAM_ID }],
      shares: [],
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  };
  let app = Fastify();
  let deniedAction: string | undefined;
  const requireAuthorization = vi.fn<RequireAuthorization>(
    (authorization) => async (_req, reply) => {
      if (authorization.action === deniedAction) {
        await reply.code(403).send({ error: "forbidden" });
      }
    }
  );

  beforeEach(async () => {
    deniedAction = undefined;
    app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.principal = {
        id: "user-1",
        kind: "user",
        businessId: "business-1",
        credential: "session",
        authMethods: [],
        authenticatedAt: new Date(),
      };
    });
    registerTeamAssetRoutes(
      app,
      service as unknown as TeamAssetService,
      async () => undefined,
      requireAuthorization
    );
    await app.ready();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it("projects descendant owner access without ownership management", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/team-assets/routine/${ASSET_ID}/access`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ownership: { owners: [{ kind: "team", teamId: TEAM_ID }] },
      access: { levels: ["view", "use"], canManageOwnership: false },
    });
  });

  it("routes destructive changes through owner Approval", async () => {
    const proposed = await app.inject({
      method: "POST",
      url: `/api/v1/team-assets/agent/${ASSET_ID}/operations`,
      payload: {
        action: "delete",
        revision: 1,
        expiresAt: "2026-09-06T12:00:00.000Z",
      },
    });
    expect(proposed.statusCode).toBe(200);
    expect(service.propose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", assetType: "agent", assetId: ASSET_ID }),
      expect.objectContaining({ id: "user-1" })
    );

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/team-assets/agent/${ASSET_ID}/operations/${OPERATION_ID}/complete`,
    });
    expect(completed.statusCode).toBe(200);
    expect(service.complete).toHaveBeenCalledWith(
      "agent",
      ASSET_ID,
      OPERATION_ID,
      expect.objectContaining({ id: "user-1" })
    );
  });

  it("lists Team-scoped ownership Approvals for Team Overview", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/team-assets/approvals?teamId=${TEAM_ID}&assetType=agent&assetId=${ASSET_ID}&limit=10&cursor=current-page`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({
        approvalId: OPERATION_ID,
        representedTeamId: TEAM_ID,
        canDecide: true,
      }),
    ]);
    expect(response.json().nextCursor).toBe("next-page");
    expect(service.listApprovalsPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      {
        teamId: TEAM_ID,
        assetType: "agent",
        assetId: ASSET_ID,
        cursor: "current-page",
        limit: 10,
      }
    );
  });

  it("lets the live authorization gate narrow Team asset mutations", async () => {
    deniedAction = "team_asset.share.manage";

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/team-assets/routine/${ASSET_ID}/shares`,
      payload: { shares: [], revision: 1 },
    });

    expect(response.statusCode).toBe(403);
    expect(service.updateShares).not.toHaveBeenCalled();
  });

  it("binds emergency override to one ownership operation and requires a reason", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/team-assets/routine/${ASSET_ID}/operations/${OPERATION_ID}/emergency-override`,
      payload: { reason: "Both owning Team admins are unavailable" },
    });

    expect(response.statusCode).toBe(200);
    expect(service.emergencyOverride).toHaveBeenCalledWith(
      "routine",
      ASSET_ID,
      OPERATION_ID,
      "Both owning Team admins are unavailable",
      expect.objectContaining({ id: "user-1" })
    );
  });

  it("rejects a blank emergency override reason", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/team-assets/routine/${ASSET_ID}/operations/${OPERATION_ID}/emergency-override`,
      payload: { reason: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(service.emergencyOverride).not.toHaveBeenCalled();
  });
});
