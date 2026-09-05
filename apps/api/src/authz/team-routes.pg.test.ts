import type { PGlite } from "@electric-sql/pglite";
import { AssetOwnershipService, decideEffectivePermission, TeamService } from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  InMemoryTeamNotificationRepo,
  PgApprovalGrantRepo,
  PgAssetOwnershipRepo,
  PgGroupRepo,
  PgPrincipalRepo,
  PgRoleRepo,
  PgTeamRepo,
} from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgActivityRepo } from "../activity/repo";
import { ActivityService } from "../activity/service";
import { buildApp } from "../app";
import { PgTokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, PgUserRepo } from "../auth/users";
import { transactionPort } from "../db";
import { buildApiAuthorityLayerResolver } from "../identity/authority-layers";
import { syncDeploymentRoles } from "../identity/roles";
import { runPgMigrations } from "../pg-migrate";
import { TeamAssetService } from "../team-assets/service";
import { TeamAssetLifecycle } from "../team-assets/team-lifecycle";
import { makeMigratedPglite } from "../test/pglite";
import { LiveRouteAuthorizer } from "./route-gate";
import { AuthzAdminService } from "./service";
import { TeamNotificationService } from "./team-notifications";
import { TeamApiService } from "./team-service";

const PASSWORD = "correct-horse-battery";

interface Session {
  readonly sid: string;
  readonly csrf: string;
}

class PausingAssetOwnershipRepo extends PgAssetOwnershipRepo {
  private beforePut?: () => Promise<void>;

  pauseNextPut(): { readonly entered: Promise<void>; release(): void } {
    let markEntered: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.beforePut = async () => {
      this.beforePut = undefined;
      markEntered();
      await released;
    };
    return { entered, release };
  }

  override async put(...args: Parameters<PgAssetOwnershipRepo["put"]>): Promise<void> {
    await this.beforePut?.();
    return super.put(...args);
  }
}

describe("Team API", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let teams: PgTeamRepo;
  let roles: PgRoleRepo;
  let principals: PgPrincipalRepo;
  let adminId: string;
  let teamAdminId: string;
  let memberId: string;
  let admin: Session;
  let teamAdmin: Session;
  let member: Session;
  let everyoneId: string;
  let teamAssets: TeamAssetService;
  let ownershipRepo: PausingAssetOwnershipRepo;
  let moveNotifications: { teamId: string; affectedPrincipalIds: readonly string[] }[];
  let audits: { action: string; target: string }[];
  let currentTime: Date;

  async function login(email: string): Promise<Session> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const sid = response.cookies.find((cookie) => cookie.name === "tf_sid")?.value;
    const csrf = response.cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value;
    if (!sid || !csrf) throw new Error("login did not issue session and CSRF cookies");
    return { sid, csrf };
  }

  function auth(session: Session) {
    return {
      cookies: { tf_sid: session.sid, [CSRF_COOKIE]: session.csrf },
      headers: { [CSRF_HEADER]: session.csrf },
    };
  }

  async function createTeam(
    slug: string,
    initialAdminUserIds: string[] = [teamAdminId],
    parentTeamId = everyoneId
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/teams",
      ...auth(admin),
      payload: {
        slug,
        displayName: slug.replaceAll("-", " "),
        parentTeamId,
        initialAdminUserIds,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; revision: number };
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const transactions = transactionPort(db);
    teams = new PgTeamRepo(transactions);
    roles = new PgRoleRepo(transactions);
    principals = new PgPrincipalRepo(transactions);
    currentTime = new Date("2026-09-05T12:00:00.000Z");
    moveNotifications = [];
    audits = [];
    await syncDeploymentRoles(roles);

    const users = new PgUserRepo(db);
    adminId = (await createUser(users, "admin@example.com", PASSWORD, "admin"))._id;
    teamAdminId = (await createUser(users, "lead@example.com", PASSWORD, "member"))._id;
    memberId = (await createUser(users, "member@example.com", PASSWORD, "member"))._id;
    await principals.put({
      id: "agent-one",
      businessId: DEPLOYMENT_BUSINESS_ID,
      kind: "agent",
      status: "active",
    });
    await principals.put({
      id: "service-one",
      businessId: DEPLOYMENT_BUSINESS_ID,
      kind: "service",
      status: "active",
    });
    await roles.putRole({
      id: "team-reader",
      businessId: DEPLOYMENT_BUSINESS_ID,
      assignableTo: ["team"],
      parentRoleIds: [],
      grants: [{ action: "record.read", resourceType: "ticket", effect: "allow" }],
    });

    everyoneId = (await teams.ensureEveryone(DEPLOYMENT_BUSINESS_ID)).id;
    const resolver = buildApiAuthorityLayerResolver(db);
    const explanations = new AuthzAdminService({
      roles,
      groups: new PgGroupRepo(transactions),
      principals,
      resolver,
      businessId: DEPLOYMENT_BUSINESS_ID,
    });
    const activity = new ActivityService(new PgActivityRepo(db));
    ownershipRepo = new PausingAssetOwnershipRepo(transactions);
    const ownershipApprovals = new PgApprovalGrantRepo(transactions);
    const teamLifecycle = new TeamAssetLifecycle({
      ownership: ownershipRepo,
    });
    const teamDomain = new TeamService({
      teams,
      principals,
      facts: { async emit() {} },
    });
    teamAssets = new TeamAssetService({
      ownershipRepo,
      teams,
      approvals: ownershipApprovals,
      ownership: new AssetOwnershipService({
        ownership: ownershipRepo,
        approvals: ownershipApprovals,
        memberships: {
          resolveMembers: (businessId, teamId) => teamDomain.resolveMembers(businessId, teamId),
        },
        facts: { async emit() {} },
      }),
      businessId: DEPLOYMENT_BUSINESS_ID,
    });
    app = await buildApp({
      sessionStore: new MemorySessionStore(),
      userRepo: users,
      tokenRepo: new PgTokenRepo(db),
      routeAuthorizer: new LiveRouteAuthorizer(resolver),
      authorizationGate: { mode: "enforcing" },
      authzAdmin: explanations,
      teamApi: new TeamApiService({
        teams,
        principals,
        roles,
        explanations,
        activity,
        audit: {
          recordOrWarn: async (input) => {
            audits.push({ action: input.action, target: input.target });
          },
        },
        notifications: new TeamNotificationService(new InMemoryTeamNotificationRepo(), teams),
        users,
        moveAssets: teamLifecycle,
        moveNotifications: {
          async emitHierarchyChange(input) {
            moveNotifications.push({
              teamId: input.teamId,
              affectedPrincipalIds: input.affectedPrincipalIds,
            });
          },
        },
        businessId: DEPLOYMENT_BUSINESS_ID,
        now: () => currentTime,
      }),
      teamAssets,
    });
    admin = await login("admin@example.com");
    teamAdmin = await login("lead@example.com");
    member = await login("member@example.com");
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("documents and protects the first-class Team surface", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/teams" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/teams",
          cookies: { tf_sid: member.sid },
        })
      ).statusCode
    ).toBe(200);
    const directory = await app.inject({
      method: "GET",
      url: "/api/v1/teams",
      cookies: { tf_sid: member.sid },
    });
    expect(
      directory
        .json()
        .teams.find((team: { id: string }) => team.id === everyoneId)
        .members.find((entry: { principalId: string }) => entry.principalId === memberId)
    ).toEqual({
      principalId: memberId,
      name: "member@example.com",
      level: "member",
    });

    const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
      paths: Record<string, Record<string, { security?: unknown; responses?: unknown }>>;
    };
    for (const path of [
      "/api/v1/team-notifications",
      "/api/v1/teams",
      "/api/v1/teams/hierarchy",
      "/api/v1/teams/{teamId}",
      "/api/v1/teams/{teamId}/members",
      "/api/v1/teams/{teamId}/members/bulk",
      "/api/v1/teams/{teamId}/members/{principalId}",
      "/api/v1/teams/{teamId}/members/bulk-remove",
      "/api/v1/teams/{teamId}/leave-requests",
      "/api/v1/teams/{teamId}/leave-requests/{requestId}/decision",
      "/api/v1/teams/{teamId}/authority",
      "/api/v1/teams/{teamId}/roles",
      "/api/v1/teams/{teamId}/roles/{roleId}",
      "/api/v1/teams/{teamId}/grants",
      "/api/v1/teams/{teamId}/grants/{grantId}",
      "/api/v1/teams/{teamId}/delegation-policy",
      "/api/v1/teams/{teamId}/move-preview",
      "/api/v1/teams/{teamId}/move",
      "/api/v1/teams/{teamId}/archive",
      "/api/v1/teams/{teamId}/admin-recovery",
      "/api/v1/teams/{teamId}/activity",
      "/api/v1/teams/{teamId}/access-explanations",
    ]) {
      expect(spec.paths[path]).toBeDefined();
      for (const operation of Object.values(spec.paths[path] ?? {})) {
        expect(operation.security).toBeDefined();
        expect(operation.responses).toBeDefined();
      }
    }
    const directoryOperation = spec.paths["/api/v1/teams"]?.get;
    expect(directoryOperation).toBeDefined();
    if (!directoryOperation) throw new Error("Team directory operation is absent");
    const directorySchema = (
      directoryOperation.responses as {
        "200": {
          content: {
            "application/json": {
              schema: {
                properties: {
                  teams: {
                    items: {
                      properties: {
                        members: {
                          items: { required: string[]; properties: Record<string, unknown> };
                        };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      }
    )["200"].content["application/json"].schema.properties.teams.items.properties.members.items;
    expect(directorySchema.required).toEqual(["principalId", "name", "level"]);
    expect(Object.keys(directorySchema.properties).sort()).toEqual([
      "level",
      "name",
      "principalId",
    ]);
  });

  it("creates, lists, and updates normalized Team labels", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/teams",
      ...auth(admin),
      payload: {
        slug: "platform",
        displayName: "Platform",
        parentTeamId: everyoneId,
        initialAdminUserIds: [teamAdminId],
        labels: [" Engineering ", "engineering", "On-call"],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().labels).toEqual(["engineering", "on-call"]);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/teams",
      cookies: { tf_sid: member.sid },
    });
    expect(
      listed.json().teams.find((team: { slug: string }) => team.slug === "platform").labels
    ).toEqual(["engineering", "on-call"]);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/teams/${created.json().id}`,
      ...auth(teamAdmin),
      payload: {
        labels: ["Infrastructure", " infrastructure "],
        revision: created.json().revision,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().labels).toEqual(["infrastructure"]);
  });

  it("enforces company scope and exact-Team admin scope through the route gate", async () => {
    const parent = await createTeam("support");
    const child = await createTeam("support-emea", [adminId], parent.id);

    const ownUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/teams/${parent.id}`,
      ...auth(teamAdmin),
      payload: { displayName: "Support team", revision: parent.revision },
    });
    expect(ownUpdate.statusCode).toBe(200);

    const childUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/teams/${child.id}`,
      ...auth(teamAdmin),
      payload: { displayName: "Wrong scope", revision: child.revision },
    });
    expect(childUpdate.statusCode).toBe(403);

    const createAsTeamAdmin = await app.inject({
      method: "POST",
      url: "/api/v1/teams",
      ...auth(teamAdmin),
      payload: {
        slug: "not-allowed",
        displayName: "Not allowed",
        parentTeamId: everyoneId,
        initialAdminUserIds: [teamAdminId],
      },
    });
    expect(createAsTeamAdmin.statusCode).toBe(403);
  });

  it("lets a company admin recover an orphaned Team admin with Activity and notification", async () => {
    const team = await createTeam("recovery");
    await teams.putMembership({
      teamId: team.id,
      principalId: memberId,
      principalKind: "user",
      level: "member",
      revision: 1,
      createdAt: currentTime,
      updatedAt: currentTime,
    });
    await principals.put({
      id: teamAdminId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      kind: "user",
      status: "disabled",
    });

    const recovered = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/admin-recovery`,
      ...auth(admin),
      payload: { principalId: memberId, revision: team.revision },
    });

    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      teamId: team.id,
      principalId: memberId,
      principalKind: "user",
      level: "admin",
      expiresAt: null,
      revision: 2,
    });
    expect(await teams.getMembership(team.id, adminId)).toBeUndefined();

    const activity = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.id}/activity?action=team.admin_recovered`,
      cookies: { tf_sid: admin.sid },
    });
    expect(activity.statusCode, activity.body).toBe(200);
    expect(activity.json().items).toContainEqual(
      expect.objectContaining({
        action: "team.admin_recovered",
        target: `principal:${memberId}`,
      })
    );

    const notifications = await app.inject({
      method: "GET",
      url: "/api/v1/team-notifications",
      cookies: { tf_sid: member.sid },
    });
    expect(notifications.statusCode, notifications.body).toBe(200);
    expect(notifications.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "admin_promoted" })])
    );
  });

  it("rejects recovery for an active person without a direct Team membership", async () => {
    const team = await createTeam("recovery-outsider");
    await principals.put({
      id: teamAdminId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      kind: "user",
      status: "disabled",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/admin-recovery`,
      ...auth(admin),
      payload: { principalId: memberId, revision: team.revision },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/direct Team membership/i);
  });

  it("allows only one concurrent Team admin recovery", async () => {
    const team = await createTeam("recovery-concurrent");
    for (const principalId of [memberId, adminId]) {
      await teams.putMembership({
        teamId: team.id,
        principalId,
        principalKind: "user",
        level: "member",
        revision: 1,
        createdAt: currentTime,
        updatedAt: currentTime,
      });
    }
    await principals.put({
      id: teamAdminId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      kind: "user",
      status: "disabled",
    });

    const responses = await Promise.all(
      [memberId, adminId].map((principalId) =>
        app.inject({
          method: "POST",
          url: `/api/v1/teams/${team.id}/admin-recovery`,
          ...auth(admin),
          payload: { principalId, revision: team.revision },
        })
      )
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it("forbids Team admins from using company recovery", async () => {
    const team = await createTeam("recovery-forbidden");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/admin-recovery`,
      ...auth(teamAdmin),
      payload: { principalId: memberId, revision: team.revision },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects recovery while an active human Team admin remains", async () => {
    const team = await createTeam("recovery-active-admin");
    await teams.putMembership({
      teamId: team.id,
      principalId: memberId,
      principalKind: "user",
      level: "member",
      revision: 1,
      createdAt: currentTime,
      updatedAt: currentTime,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/admin-recovery`,
      ...auth(admin),
      payload: { principalId: memberId, revision: team.revision },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/no active human admins/i);
  });

  it("rejects a non-human Team admin recovery target", async () => {
    const team = await createTeam("recovery-agent");
    await teams.putMembership({
      teamId: team.id,
      principalId: "agent-one",
      principalKind: "agent",
      level: "member",
      revision: 1,
      createdAt: currentTime,
      updatedAt: currentTime,
    });
    await principals.put({
      id: teamAdminId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      kind: "user",
      status: "disabled",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/admin-recovery`,
      ...auth(admin),
      payload: { principalId: "agent-one", revision: team.revision },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/active direct human member/i);
  });

  it("rejects Team admin recovery at a stale Team revision", async () => {
    const team = await createTeam("recovery-stale");
    await principals.put({
      id: teamAdminId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      kind: "user",
      status: "disabled",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/admin-recovery`,
      ...auth(admin),
      payload: { principalId: memberId, revision: team.revision + 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/revision conflict/i);
  });

  it("keeps Everyone protected from Team admin recovery", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${everyoneId}/admin-recovery`,
      ...auth(admin),
      payload: { principalId: memberId, revision: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Everyone is protected/i);
  });

  it("returns direct and inherited members and authority with source evidence", async () => {
    const parent = await createTeam("operations");
    const child = await createTeam("incident-response", [adminId], parent.id);
    const added = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${child.id}/members`,
      ...auth(admin),
      payload: { principalId: memberId, level: "member" },
    });
    expect(added.statusCode, added.body).toBe(201);
    const notifications = await app.inject({
      method: "GET",
      url: "/api/v1/team-notifications",
      cookies: { tf_sid: member.sid },
    });
    expect(notifications.statusCode, notifications.body).toBe(200);
    expect(notifications.json().items).toContainEqual(
      expect.objectContaining({
        kind: "membership_added",
        title: "You were added to a Team",
      })
    );
    expect(notifications.body).not.toContain(child.id);

    await teams.assignRole({
      teamId: parent.id,
      roleId: "team-reader",
      assignedAt: new Date(),
    });
    const grantId = "11111111-1111-4111-8111-111111111111";
    await teams.putGrant({
      id: grantId,
      teamId: parent.id,
      action: "record.update",
      resourceType: "ticket",
      effect: "allow",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const members = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${parent.id}/members`,
      cookies: { tf_sid: teamAdmin.sid },
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().inherited).toContainEqual(
      expect.objectContaining({
        principalId: memberId,
        sourceTeamId: child.id,
        pathTeamIds: [child.id, parent.id],
        revision: 1,
      })
    );

    const authority = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${child.id}/authority`,
      cookies: { tf_sid: admin.sid },
    });
    expect(authority.json().inheritedRoles).toContainEqual(
      expect.objectContaining({ roleId: "team-reader", sourceTeamId: parent.id })
    );
    expect(authority.json().inheritedGrants).toContainEqual(
      expect.objectContaining({ id: grantId, sourceTeamId: parent.id })
    );
  });

  it("enforces delegation, non-human admin constraints, expiry, and final-admin protection", async () => {
    const team = await createTeam("engineering");
    const policy = await app.inject({
      method: "PUT",
      url: `/api/v1/teams/${team.id}/delegation-policy`,
      ...auth(admin),
      payload: {
        allowedRoleIds: ["team-reader"],
        allowedGrantScopes: [{ actions: ["record.read"], resourceTypes: ["ticket"] }],
        revision: 0,
      },
    });

    expect(policy.statusCode).toBe(200);

    const delegated = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/roles`,
      ...auth(teamAdmin),
      payload: { roleId: "team-reader" },
    });
    expect(delegated.statusCode).toBe(200);

    const outsidePolicy = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/grants`,
      ...auth(teamAdmin),
      payload: { action: "record.delete", resourceType: "ticket", effect: "allow" },
    });
    expect(outsidePolicy.statusCode).toBe(403);

    for (const principalId of ["agent-one", "service-one"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/teams/${team.id}/members`,
        ...auth(teamAdmin),
        payload: { principalId, level: "admin" },
      });
      expect(response.statusCode).toBe(400);
    }

    const expired = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/members`,
      ...auth(teamAdmin),
      payload: {
        principalId: memberId,
        level: "member",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    });
    expect(expired.statusCode).toBe(400);

    const finalAdmin = await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${team.id}/members/${teamAdminId}`,
      ...auth(admin),
      payload: { revision: 1 },
    });
    expect(finalAdmin.statusCode, finalAdmin.body).toBe(409);
    expect(finalAdmin.json().error).toMatch(/final Team admin/i);
  });

  it("returns a conflict when concurrent delegation-policy writes use the same revision", async () => {
    const team = await createTeam("concurrent-policy");
    const responses = await Promise.all([
      app.inject({
        method: "PUT",
        url: `/api/v1/teams/${team.id}/delegation-policy`,
        ...auth(admin),
        payload: {
          allowedRoleIds: ["team-reader"],
          allowedGrantScopes: [],
          revision: 0,
        },
      }),
      app.inject({
        method: "PUT",
        url: `/api/v1/teams/${team.id}/delegation-policy`,
        ...auth(admin),
        payload: {
          allowedRoleIds: [],
          allowedGrantScopes: [{ actions: ["record.read"], resourceTypes: ["ticket"] }],
          revision: 0,
        },
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const policy = await teams.getDelegationPolicy(team.id);
    expect(policy?.revision).toBe(1);
  });

  it("supports bulk membership, leave decisions, Activity, and access explanations", async () => {
    const team = await createTeam("customer-success");
    const bulk = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/members/bulk`,
      ...auth(teamAdmin),
      payload: {
        members: [
          { principalId: memberId, level: "member" },
          { principalId: "agent-one", level: "member" },
          { principalId: "service-one", level: "member" },
        ],
      },
    });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(bulk.json().results).toHaveLength(3);
    expect(bulk.json().results.every((result: { ok: boolean }) => result.ok)).toBe(true);

    await teams.assignRole({
      teamId: team.id,
      roleId: "team-reader",
      assignedAt: new Date(),
    });
    const explanation = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/access-explanations`,
      ...auth(admin),
      payload: { principalId: memberId, action: "record.read", resourceType: "ticket" },
    });
    expect(explanation.statusCode, explanation.body).toBe(200);
    expect(explanation.json()).toMatchObject({
      allowed: true,
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: "direct_membership", sourceTeamId: team.id }),
        expect.objectContaining({ kind: "role", roleId: "team-reader" }),
      ]),
    });
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/access-explanations`,
      ...auth(admin),
      payload: { principalId: memberId, action: "secret.read", resourceType: "secret" },
    });
    expect(denied.statusCode, denied.body).toBe(200);
    expect(denied.json()).toMatchObject({
      allowed: false,
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: "direct_membership", sourceTeamId: team.id }),
        expect.objectContaining({ kind: "authority_layer", effect: "deny" }),
      ]),
    });
    const unauthorizedExplanation = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/access-explanations`,
      ...auth(teamAdmin),
      payload: { principalId: adminId, action: "authz.role.read", resourceType: "authz" },
    });
    expect(unauthorizedExplanation.statusCode).toBe(403);

    const requested = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/leave-requests`,
      ...auth(member),
    });

    expect(requested.statusCode, requested.body).toBe(201);
    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/leave-requests/${requested.json().id}/decision`,
      ...auth(teamAdmin),
      payload: { decision: "rejected", revision: requested.json().revision },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().status).toBe("rejected");

    const activity = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${team.id}/activity?action=team.leave_rejected`,
      cookies: { tf_sid: teamAdmin.sid },
    });
    expect(activity.statusCode, activity.body).toBe(200);
    expect(activity.json().items).toContainEqual(
      expect.objectContaining({
        action: "team.leave_rejected",
        targetId: team.id,
        target: expect.any(String),
        outcome: "succeeded",
        emergency: false,
      })
    );
    expect(audits).toContainEqual({
      action: "team.leave_rejected",
      target: `team:${team.id}`,
    });
  });

  it("preserves membership expiry unless PATCH explicitly clears it", async () => {
    const team = await createTeam("temporary-access");
    const expiresAt = "2027-09-05T12:00:00.000Z";
    const added = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${team.id}/members`,
      ...auth(teamAdmin),
      payload: { principalId: memberId, level: "member", expiresAt },
    });
    expect(added.statusCode, added.body).toBe(201);

    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/v1/teams/${team.id}/members/${memberId}`,
      ...auth(teamAdmin),
      payload: { level: "admin", revision: added.json().revision },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json().expiresAt).toBe(expiresAt);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/v1/teams/${team.id}/members/${memberId}`,
      ...auth(teamAdmin),
      payload: { level: "admin", expiresAt: null, revision: promoted.json().revision },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().expiresAt).toBeNull();
  });

  it("covers asset creation, joint ownership Approval, and Team-derived asset access", async () => {
    const owner = await createTeam("asset-owner", [teamAdminId, adminId]);
    const coOwner = await createTeam("asset-co-owner", [memberId]);
    const memberAdd = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${owner.id}/members`,
      ...auth(teamAdmin),
      payload: { principalId: memberId, level: "member" },
    });
    expect(memberAdd.statusCode, memberAdd.body).toBe(201);

    const ownership = await teamAssets.ensure("agent", "acceptance-agent", {
      owners: [{ teamId: owner.id }],
      shares: [{ teamId: coOwner.id, access: "view" }],
    });
    expect(ownership.owners).toEqual([{ kind: "team", teamId: owner.id }]);

    const memberAccess = await app.inject({
      method: "GET",
      url: "/api/v1/team-assets/agent/acceptance-agent/access",
      cookies: { tf_sid: member.sid },
    });
    expect(memberAccess.statusCode, memberAccess.body).toBe(200);
    expect(memberAccess.json()).toMatchObject({
      access: {
        levels: ["view", "use"],
        canManageOwnership: false,
        evidence: expect.arrayContaining([
          expect.objectContaining({ source: "team_owner", teamId: owner.id }),
        ]),
      },
    });

    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/team-assets/agent/acceptance-agent/operations",
      ...auth(teamAdmin),
      payload: {
        action: "add_owner",
        teamId: coOwner.id,
        revision: ownership.revision,
        expiresAt: "2026-09-06T00:00:00.000Z",
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const operationId = proposed.json().id as string;

    const decisions = [];
    for (const [session, teamId] of [
      [admin, owner.id],
      [member, coOwner.id],
    ] as const) {
      const decided = await app.inject({
        method: "POST",
        url: `/api/v1/team-assets/agent/acceptance-agent/operations/${operationId}/decisions`,
        ...auth(session),
        payload: { teamId, outcome: "approved" },
      });
      expect(decided.statusCode, decided.body).toBe(200);
      decisions.push(decided.json());
    }
    expect(decisions[0]).toMatchObject({
      completion: { status: "pending", readyToComplete: false },
    });
    expect(decisions[1]).toMatchObject({
      completion: { status: "completed", readyToComplete: false },
      ownership: {
        owners: [
          { kind: "team", teamId: owner.id },
          { kind: "team", teamId: coOwner.id },
        ],
      },
    });

    const approvals = await app.inject({
      method: "GET",
      url: `/api/v1/team-assets/approvals?teamId=${coOwner.id}`,
      cookies: { tf_sid: admin.sid },
    });
    expect(approvals.statusCode, approvals.body).toBe(200);
    expect(approvals.json().items).toEqual([]);
  });

  it("lets only a company admin emergency-complete one exact owner-change operation", async () => {
    const owner = await createTeam("override-owner", [teamAdminId]);
    const coOwner = await createTeam("override-co-owner", [memberId]);
    const ownership = await teamAssets.ensure("agent", "override-agent", {
      owners: [{ teamId: owner.id }],
    });
    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/team-assets/agent/override-agent/operations",
      ...auth(teamAdmin),
      payload: {
        action: "add_owner",
        teamId: coOwner.id,
        revision: ownership.revision,
        expiresAt: "2099-09-06T00:00:00.000Z",
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const operationId = proposed.json().id as string;

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/team-assets/agent/override-agent/operations/${operationId}/emergency-override`,
      ...auth(teamAdmin),
      payload: { reason: "Company recovery" },
    });
    expect(denied.statusCode, denied.body).toBe(403);

    const wrongAsset = await app.inject({
      method: "POST",
      url: `/api/v1/team-assets/agent/another-agent/operations/${operationId}/emergency-override`,
      ...auth(admin),
      payload: { reason: "Company recovery" },
    });
    expect(wrongAsset.statusCode, wrongAsset.body).toBe(404);

    const overridden = await app.inject({
      method: "POST",
      url: `/api/v1/team-assets/agent/override-agent/operations/${operationId}/emergency-override`,
      ...auth(admin),
      payload: { reason: "Both owning Team admins are unavailable" },
    });
    expect(overridden.statusCode, overridden.body).toBe(200);
    expect(overridden.json()).toMatchObject({
      revision: 2,
      owners: [
        { kind: "team", teamId: owner.id },
        { kind: "team", teamId: coOwner.id },
      ],
    });
  });

  it("validates hierarchy, then archives and deletes only after references are cleared", async () => {
    const parent = await createTeam("finance");
    const child = await createTeam("payroll", [adminId], parent.id);
    const cycle = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${parent.id}/move-preview`,
      ...auth(admin),
      payload: { parentTeamId: child.id, revision: parent.revision },
    });
    expect(cycle.statusCode).toBe(400);

    const blockedArchive = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${parent.id}/archive`,
      ...auth(admin),
      payload: { revision: parent.revision },
    });
    expect(blockedArchive.statusCode).toBe(409);

    const assetOwner = await createTeam("asset-bound");
    await teamAssets.ensure("agent", "sole-owned-agent", {
      owners: [{ teamId: assetOwner.id }],
    });
    const assetBlockedArchive = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${assetOwner.id}/archive`,
      ...auth(admin),
      payload: { revision: assetOwner.revision },
    });
    expect(assetBlockedArchive.statusCode).toBe(409);
    expect(assetBlockedArchive.json().error).toMatch(/asset ownership and shares/i);

    const leaf = await createTeam("temporary", [teamAdminId]);
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${leaf.id}/archive`,
      ...auth(admin),
      payload: { revision: leaf.revision },
    });
    expect(archived.statusCode).toBe(200);

    const blockedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${leaf.id}`,
      ...auth(admin),
      payload: { revision: archived.json().revision },
    });
    expect(blockedDelete.statusCode).toBe(409);

    await teams.removeMembership(leaf.id, teamAdminId);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${leaf.id}`,
      ...auth(admin),
      payload: { revision: archived.json().revision },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await teams.getTeam(DEPLOYMENT_BUSINESS_ID, leaf.id)).toBeUndefined();
  });

  it("does not commit a Team share after the Team is archived concurrently", async () => {
    const owner = await createTeam("concurrent-lifecycle-owner");
    const target = await createTeam("concurrent-lifecycle-target");
    const ownership = await teamAssets.ensure("agent", "concurrent-lifecycle-agent", {
      owners: [{ teamId: owner.id }],
    });
    const pausedPut = ownershipRepo.pauseNextPut();
    const share = app.inject({
      method: "PUT",
      url: "/api/v1/team-assets/agent/concurrent-lifecycle-agent/shares",
      ...auth(teamAdmin),
      payload: {
        shares: [{ teamId: target.id, access: "view" }],
        revision: ownership.revision,
      },
    });
    expect(await Promise.race([pausedPut.entered.then(() => true), share.then(() => false)])).toBe(
      true
    );

    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${target.id}/archive`,
      ...auth(admin),
      payload: { revision: target.revision },
    });
    pausedPut.release();
    const shared = await share;

    expect(archived.statusCode, archived.body).toBe(200);
    expect(shared.statusCode, shared.body).toBe(400);
    expect(shared.json().error).toMatch(/active Teams/i);
    expect(await teams.getTeam(DEPLOYMENT_BUSINESS_ID, target.id)).toMatchObject({
      status: "archived",
    });
    expect(
      await ownershipRepo.get(DEPLOYMENT_BUSINESS_ID, "agent", "concurrent-lifecycle-agent")
    ).toMatchObject({ shares: [] });
  });

  it("previews and confirms identity, authority, asset, and notification impact", async () => {
    const oldParent = await createTeam("old-parent");
    const newParent = await createTeam("new-parent");
    const moved = await createTeam("moved", [teamAdminId], oldParent.id);
    const descendant = await createTeam("moved-child", [adminId], moved.id);
    await teams.putMembership({
      teamId: descendant.id,
      principalId: memberId,
      principalKind: "user",
      level: "member",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await teams.assignRole({ teamId: oldParent.id, roleId: "team-reader", assignedAt: new Date() });
    await roles.putRole({
      id: "new-parent-role",
      businessId: DEPLOYMENT_BUSINESS_ID,
      assignableTo: ["team"],
      parentRoleIds: [],
      grants: [{ action: "record.update", resourceType: "ticket", effect: "allow" }],
    });
    await teams.assignRole({
      teamId: newParent.id,
      roleId: "new-parent-role",
      assignedAt: new Date(),
    });
    const oldGrantId = "22222222-2222-4222-8222-222222222222";
    const newGrantId = "33333333-3333-4333-8333-333333333333";
    await teams.putGrant({
      id: oldGrantId,
      teamId: oldParent.id,
      action: "record.read",
      resourceType: "invoice",
      effect: "allow",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await teams.putGrant({
      id: newGrantId,
      teamId: newParent.id,
      action: "record.update",
      resourceType: "invoice",
      effect: "allow",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await Promise.all([
      ownershipRepo.create({
        businessId: DEPLOYMENT_BUSINESS_ID,
        assetType: "agent",
        assetId: "owned-agent",
        owners: [{ kind: "team", teamId: moved.id }],
        shares: [],
        revision: 1,
        createdAt: currentTime,
        updatedAt: currentTime,
      }),
      ownershipRepo.create({
        businessId: DEPLOYMENT_BUSINESS_ID,
        assetType: "file",
        assetId: "lost-file",
        owners: [{ kind: "team", teamId: everyoneId }],
        shares: [{ teamId: oldParent.id, access: "view" }],
        revision: 2,
        createdAt: currentTime,
        updatedAt: currentTime,
      }),
      ownershipRepo.create({
        businessId: DEPLOYMENT_BUSINESS_ID,
        assetType: "knowledge",
        assetId: "gained-page",
        owners: [{ kind: "team", teamId: everyoneId }],
        shares: [{ teamId: newParent.id, access: "use" }],
        revision: 3,
        createdAt: currentTime,
        updatedAt: currentTime,
      }),
    ]);

    const previewResponse = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move-preview`,
      ...auth(admin),
      payload: { parentTeamId: newParent.id, revision: moved.revision },
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const preview = previewResponse.json() as {
      previewToken: string;
      descendantTeamIds: string[];
      identities: { principalId: string }[];
      roles: { gained: { id: string }[]; lost: { id: string }[] };
      grants: { gained: { id: string }[]; lost: { id: string }[] };
      assets: {
        owned: { assetId: string }[];
        gained: { assetId: string }[];
        lost: { assetId: string }[];
      };
      accessChanges: {
        principalId: string;
        gainedRoleIds: string[];
        lostRoleIds: string[];
        gainedGrantIds: string[];
        lostGrantIds: string[];
      }[];
    };
    expect(preview.descendantTeamIds).toContain(descendant.id);
    expect(preview.identities.map((identity) => identity.principalId)).toEqual(
      expect.arrayContaining([teamAdminId, adminId, memberId])
    );
    expect(preview.roles.gained).toContainEqual(expect.objectContaining({ id: "new-parent-role" }));
    expect(preview.roles.lost).toContainEqual(expect.objectContaining({ id: "team-reader" }));
    expect(preview.grants.gained).toContainEqual(expect.objectContaining({ id: newGrantId }));
    expect(preview.grants.lost).toContainEqual(expect.objectContaining({ id: oldGrantId }));
    expect(preview.assets.owned).toContainEqual(
      expect.objectContaining({ assetId: "owned-agent" })
    );
    expect(preview.assets.gained).toContainEqual(
      expect.objectContaining({ assetId: "gained-page" })
    );
    expect(preview.assets.lost).toContainEqual(expect.objectContaining({ assetId: "lost-file" }));
    expect(preview.accessChanges).toContainEqual(
      expect.objectContaining({
        principalId: memberId,
        gainedRoleIds: ["new-parent-role"],
        lostRoleIds: ["team-reader"],
        gainedGrantIds: [newGrantId],
        lostGrantIds: [oldGrantId],
      })
    );
    expect((await teams.getTeam(DEPLOYMENT_BUSINESS_ID, moved.id))?.parentTeamId).toBe(
      oldParent.id
    );

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move`,
      ...auth(admin),
      payload: { parentTeamId: newParent.id, previewToken: preview.previewToken },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().parentTeamId).toBe(newParent.id);
    expect(moveNotifications).toContainEqual({
      teamId: moved.id,
      affectedPrincipalIds: expect.arrayContaining([teamAdminId, adminId, memberId]),
    });

    const activity = await app.inject({
      method: "GET",
      url: `/api/v1/teams/${moved.id}/activity?action=team.moved`,
      cookies: { tf_sid: admin.sid },
    });
    expect(activity.json().items).toContainEqual(
      expect.objectContaining({
        action: "team.moved",
        metadata: expect.objectContaining({
          hierarchyChange: expect.objectContaining({
            previousParentTeamId: oldParent.id,
            proposedParentTeamId: newParent.id,
          }),
        }),
      })
    );
  });

  it("rejects stale, concurrent, and reused move confirmations", async () => {
    const firstParent = await createTeam("first-parent");
    const secondParent = await createTeam("second-parent");
    const moved = await createTeam("concurrent-move", [teamAdminId], firstParent.id);
    const preview = async () =>
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/teams/${moved.id}/move-preview`,
          ...auth(admin),
          payload: { parentTeamId: secondParent.id, revision: moved.revision },
        })
      ).json() as { previewToken: string };
    const firstPreview = await preview();
    const concurrentPreview = await preview();

    await teams.putMembership({
      teamId: moved.id,
      principalId: memberId,
      principalKind: "user",
      level: "member",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move`,
      ...auth(admin),
      payload: { parentTeamId: secondParent.id, previewToken: firstPreview.previewToken },
    });
    expect(stale.statusCode).toBe(409);

    const parentPreview = await preview();
    const currentParent = await teams.getTeam(DEPLOYMENT_BUSINESS_ID, secondParent.id);
    if (!currentParent) throw new Error("second parent was not found");
    await teams.putTeam({
      ...currentParent,
      displayName: "second parent updated",
      revision: currentParent.revision + 1,
      updatedAt: new Date(),
    });
    const staleParent = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move`,
      ...auth(admin),
      payload: { parentTeamId: secondParent.id, previewToken: parentPreview.previewToken },
    });
    expect(staleParent.statusCode).toBe(409);

    const authorityPreview = await preview();
    await teams.assignRole({
      teamId: moved.id,
      roleId: "team-reader",
      assignedAt: new Date(),
    });
    const staleAuthority = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move`,
      ...auth(admin),
      payload: { parentTeamId: secondParent.id, previewToken: authorityPreview.previewToken },
    });
    expect(staleAuthority.statusCode).toBe(409);

    await teams.putMembership({
      teamId: moved.id,
      principalId: memberId,
      principalKind: "user",
      level: "member",
      expiresAt: new Date(currentTime.getTime() + 60_000),
      revision: 2,
      createdAt: currentTime,
      updatedAt: currentTime,
    });
    const expiryPreview = await preview();
    currentTime = new Date(currentTime.getTime() + 120_000);
    const staleExpiry = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move`,
      ...auth(admin),
      payload: { parentTeamId: secondParent.id, previewToken: expiryPreview.previewToken },
    });
    expect(staleExpiry.statusCode).toBe(409);

    const ownership = {
      businessId: DEPLOYMENT_BUSINESS_ID,
      assetType: "file" as const,
      assetId: "move-race-file",
      owners: [{ kind: "team" as const, teamId: firstParent.id }],
      shares: [{ teamId: moved.id, access: "view" as const }],
      revision: 1,
      createdAt: currentTime,
      updatedAt: currentTime,
    };
    await ownershipRepo.create(ownership);
    const assetPreview = await preview();
    await ownershipRepo.put(
      {
        ...ownership,
        shares: [{ teamId: moved.id, access: "edit" }],
        revision: 2,
        updatedAt: new Date(currentTime.getTime() + 1),
      },
      1
    );
    const staleAsset = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move`,
      ...auth(admin),
      payload: { parentTeamId: secondParent.id, previewToken: assetPreview.previewToken },
    });
    expect(staleAsset.statusCode).toBe(409);

    const freshPreview = await preview();
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move`,
      ...auth(admin),
      payload: { parentTeamId: secondParent.id, previewToken: freshPreview.previewToken },
    });
    expect(confirmed.statusCode).toBe(200);

    for (const previewToken of [freshPreview.previewToken, concurrentPreview.previewToken]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/v1/teams/${moved.id}/move`,
        ...auth(admin),
        payload: { parentTeamId: secondParent.id, previewToken },
      });
      expect(rejected.statusCode).toBe(409);
    }
  });

  it("rejects a move whose descendants would cross the ten-level boundary", async () => {
    let deepParentId = everyoneId;
    for (let depth = 2; depth <= 8; depth += 1) {
      deepParentId = (await createTeam(`deep-${depth}`, [adminId], deepParentId)).id;
    }
    const moved = await createTeam("boundary-root");
    const child = await createTeam("boundary-child", [adminId], moved.id);
    await createTeam("boundary-grandchild", [adminId], child.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/teams/${moved.id}/move-preview`,
      ...auth(admin),
      payload: { parentTeamId: deepParentId, revision: moved.revision },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/10 levels/i);
  });

  it("revokes migrated group authority when the member is removed through the Team API", async () => {
    const groups = new PgGroupRepo(transactionPort(db));
    await roles.putRole({
      id: "legacy-reader",
      businessId: DEPLOYMENT_BUSINESS_ID,
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [{ action: "legacy.read", resourceType: "legacy-record", effect: "allow" }],
    });
    await groups.putGroup({ businessId: DEPLOYMENT_BUSINESS_ID, id: "legacy-readers" });
    await groups.addMember({
      businessId: DEPLOYMENT_BUSINESS_ID,
      groupId: "legacy-readers",
      principalId: memberId,
    });
    await groups.assignRole({
      businessId: DEPLOYMENT_BUSINESS_ID,
      groupId: "legacy-readers",
      roleId: "legacy-reader",
    });
    await db.query("UPDATE schema_version SET version = 87 WHERE id = true");
    await db.query("DELETE FROM schema_migrations WHERE version >= 88");
    await runPgMigrations(
      db,
      (code) => {
        throw new Error(`migration exited with ${code}`);
      },
      () => {}
    );

    const migratedTeamId = await teams.resolveLegacyGroupId(
      DEPLOYMENT_BUSINESS_ID,
      "legacy-readers"
    );
    if (!migratedTeamId) throw new Error("legacy group was not migrated");
    const resolver = buildApiAuthorityLayerResolver(db);
    const request = { action: "legacy.read", resourceType: "legacy-record" };
    const resolvePermission = async () =>
      decideEffectivePermission(
        [
          await resolver.resolvePrincipalLayer("user", {
            id: memberId,
            businessId: DEPLOYMENT_BUSINESS_ID,
            kind: "user",
          }),
        ],
        request,
        new Date()
      ).allowed;
    await expect(resolvePermission()).resolves.toBe(true);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/teams/${migratedTeamId}/members/${memberId}`,
      ...auth(admin),
      payload: { revision: 1 },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      (
        await db.query(
          `SELECT 1 FROM principal_group_members
            WHERE business_id = $1 AND group_id = 'legacy-readers' AND principal_id = $2`,
          [DEPLOYMENT_BUSINESS_ID, memberId]
        )
      ).rows
    ).toHaveLength(1);
    await expect(resolvePermission()).resolves.toBe(false);
  });

  it("keeps group aliases on the Team model and returns deprecation metadata", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/authz/groups",
      ...auth(admin),
      payload: { id: "legacy-ops", initialAdminUserIds: [teamAdminId] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().deprecation).toMatchObject({
      deprecated: true,
      replacement: "Team",
      replacementPath: "/api/v1/teams",
    });

    const teamId = created.json().team.id as string;
    expect(await teams.getTeam(DEPLOYMENT_BUSINESS_ID, teamId)).toBeDefined();
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/authz/groups/legacy-ops/members",
      ...auth(admin),
      payload: { principalId: memberId },
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().deprecation.deprecated).toBe(true);
    expect(added.json().membership.level).toBe("member");

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/authz/groups/legacy-ops",
      cookies: { tf_sid: member.sid },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      team: { id: teamId, slug: "legacy-ops" },
      deprecation: { deprecated: true },
    });
  });
});
