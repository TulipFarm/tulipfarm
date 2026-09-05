import { describe, expect, it } from "vitest";
import type { Principal } from "./principals";
import {
  type TeamActorCapabilities,
  type TeamFact,
  type TeamLeaveRequestRecord,
  type TeamMembershipRecord,
  type TeamRecord,
  type TeamRepoPort,
  TeamService,
  TeamServiceError,
} from "./teams";

const BUSINESS_ID = "business-1";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const EVERYONE_ID = "00000000-0000-4000-8000-000000000001";
const TEAM_ID = "00000000-0000-4000-8000-000000000002";
const CHILD_ID = "00000000-0000-4000-8000-000000000003";

const companyAdmin: TeamActorCapabilities = {
  principalId: "company-admin",
  companyAdmin: true,
  administeredTeamIds: [],
};

function teamAdmin(teamId = TEAM_ID): TeamActorCapabilities {
  return {
    principalId: "team-admin",
    companyAdmin: false,
    administeredTeamIds: [teamId],
  };
}

function person(id: string, status: Principal["status"] = "active"): Principal {
  return { id, businessId: BUSINESS_ID, kind: "user", status };
}

class FakeTeamRepo implements TeamRepoPort {
  readonly teams = new Map<string, TeamRecord>();
  readonly memberships = new Map<string, TeamMembershipRecord>();
  readonly leaves = new Map<string, TeamLeaveRequestRecord>();
  roles: unknown[] = [];
  grants: unknown[] = [];
  policy: unknown;
  isActiveHuman = (_principalId: string) => true;

  constructor() {
    this.teams.set(EVERYONE_ID, {
      id: EVERYONE_ID,
      businessId: BUSINESS_ID,
      slug: "everyone",
      displayName: "Everyone",
      status: "active",
      protected: true,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  async ensureEveryone(): Promise<TeamRecord> {
    const everyone = this.teams.get(EVERYONE_ID);
    if (!everyone) throw new Error("missing Everyone");
    return everyone;
  }

  async getTeam(businessId: string, teamId: string): Promise<TeamRecord | undefined> {
    const team = this.teams.get(teamId);
    return team?.businessId === businessId ? team : undefined;
  }

  async getTeamBySlug(businessId: string, slug: string): Promise<TeamRecord | undefined> {
    return [...this.teams.values()].find(
      (team) => team.businessId === businessId && team.slug === slug
    );
  }

  async listTeams(businessId: string): Promise<TeamRecord[]> {
    return [...this.teams.values()].filter((team) => team.businessId === businessId);
  }

  async createTeam(
    record: TeamRecord,
    memberships: readonly TeamMembershipRecord[]
  ): Promise<void> {
    await this.putTeam(record);
    for (const membership of memberships) await this.putMembership(membership);
  }

  async putTeam(record: TeamRecord): Promise<void> {
    const previous = this.teams.get(record.id);
    if (previous && record.revision !== previous.revision + 1) {
      throw new Error("Team revision conflict");
    }
    if (!previous && record.revision !== 1) throw new Error("invalid initial revision");
    this.teams.set(record.id, record);
  }

  async deleteTeam(_businessId: string, teamId: string): Promise<void> {
    this.teams.delete(teamId);
  }

  async putMembership(record: TeamMembershipRecord): Promise<void> {
    const key = `${record.teamId}:${record.principalId}`;
    const previous = this.memberships.get(key);
    if (previous && record.revision !== previous.revision + 1) {
      throw new Error("membership revision conflict");
    }
    if (!previous && record.revision !== 1) throw new Error("invalid initial revision");
    this.memberships.set(key, record);
  }

  async removeMembership(
    teamId: string,
    principalId: string,
    expectedRevision?: number
  ): Promise<void> {
    const key = `${teamId}:${principalId}`;
    const membership = this.memberships.get(key);
    if (expectedRevision !== undefined && membership?.revision !== expectedRevision) {
      throw new Error("membership revision conflict");
    }
    this.memberships.delete(key);
  }

  async getMembership(
    teamId: string,
    principalId: string
  ): Promise<TeamMembershipRecord | undefined> {
    return this.memberships.get(`${teamId}:${principalId}`);
  }

  async listMemberships(teamId: string, now: Date): Promise<TeamMembershipRecord[]> {
    return (await this.listAllMemberships(teamId)).filter(
      (membership) => !membership.expiresAt || membership.expiresAt > now
    );
  }

  async listAllMemberships(teamId: string): Promise<TeamMembershipRecord[]> {
    return [...this.memberships.values()].filter((membership) => membership.teamId === teamId);
  }

  async listAllRoleAssignments(): Promise<readonly unknown[]> {
    return this.roles;
  }

  async listAllGrants(): Promise<readonly unknown[]> {
    return this.grants;
  }

  async getDelegationPolicy(): Promise<unknown> {
    return this.policy;
  }

  async putLeaveRequest(record: TeamLeaveRequestRecord): Promise<void> {
    const previous = this.leaves.get(record.id);
    if (previous && record.revision !== previous.revision + 1) {
      throw new Error("leave revision conflict");
    }
    this.leaves.set(record.id, record);
  }

  async getLeaveRequest(
    teamId: string,
    requestId: string
  ): Promise<TeamLeaveRequestRecord | undefined> {
    const request = this.leaves.get(requestId);
    return request?.teamId === teamId ? request : undefined;
  }

  async listLeaveRequests(teamId: string): Promise<TeamLeaveRequestRecord[]> {
    return [...this.leaves.values()].filter((request) => request.teamId === teamId);
  }

  async recoverAdmin(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly principalId: string;
    readonly teamRevision: number;
    readonly now: Date;
  }): Promise<TeamMembershipRecord> {
    const team = await this.getTeam(input.businessId, input.teamId);
    if (!team || team.revision !== input.teamRevision) {
      throw new Error("Team revision conflict");
    }
    const hasAdmin = [...this.memberships.values()].some(
      (membership) =>
        membership.teamId === input.teamId &&
        membership.level === "admin" &&
        membership.principalKind === "user" &&
        (!membership.expiresAt || membership.expiresAt > input.now) &&
        this.isActiveHuman(membership.principalId)
    );
    if (hasAdmin) {
      throw new Error("Team admin recovery requires a Team with no active human admins");
    }
    const key = `${input.teamId}:${input.principalId}`;
    const membership = this.memberships.get(key);
    if (!membership) {
      throw new Error("Team admin recovery requires an active direct human membership");
    }
    if (
      membership.principalKind !== "user" ||
      (membership.expiresAt && membership.expiresAt <= input.now) ||
      !this.isActiveHuman(membership.principalId)
    ) {
      throw new Error("Team admin recovery requires an active direct human membership");
    }
    const recovered = {
      ...membership,
      level: "admin" as const,
      expiresAt: undefined,
      revision: membership.revision + 1,
      updatedAt: input.now,
    };
    this.memberships.set(key, recovered);
    return recovered;
  }

  async transitionLifecycle(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly action: "archive" | "delete";
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<
    | { readonly ok: true; readonly team?: TeamRecord }
    | {
        readonly ok: false;
        readonly reason: "not_found" | "conflict" | "invalid" | "protected" | "not_empty";
        readonly message: string;
      }
  > {
    const team = await this.getTeam(input.businessId, input.teamId);
    if (!team) return { ok: false, reason: "not_found", message: "Team was not found" };
    if (team.protected) return { ok: false, reason: "protected", message: "Everyone is protected" };
    if (team.revision !== input.expectedRevision) {
      return { ok: false, reason: "conflict", message: "Team revision conflict" };
    }
    const hasChild = [...this.teams.values()].some(
      (candidate) =>
        candidate.businessId === input.businessId && candidate.parentTeamId === input.teamId
    );
    if (input.action === "archive") {
      if (team.status !== "active") {
        return { ok: false, reason: "invalid", message: "Team is archived" };
      }
      if (hasChild) {
        return {
          ok: false,
          reason: "not_empty",
          message: "Move child Teams before archiving this Team",
        };
      }
      const archived = {
        ...team,
        status: "archived" as const,
        archivedAt: input.now,
        revision: team.revision + 1,
        updatedAt: input.now,
      };
      this.teams.set(input.teamId, archived);
      return { ok: true, team: archived };
    }
    if (team.status !== "archived") {
      return { ok: false, reason: "invalid", message: "Only an archived Team can be deleted" };
    }
    if (
      hasChild ||
      [...this.memberships.values()].some((membership) => membership.teamId === input.teamId) ||
      this.roles.length > 0 ||
      this.grants.length > 0 ||
      this.policy !== undefined ||
      [...this.leaves.values()].some(
        (request) => request.teamId === input.teamId && request.status === "pending"
      )
    ) {
      return {
        ok: false,
        reason: "not_empty",
        message: "The archived Team still has references",
      };
    }
    this.teams.delete(input.teamId);
    return { ok: true };
  }
}

function fixture() {
  const teams = new FakeTeamRepo();
  const principals = new Map<string, Principal>([
    ["company-admin", person("company-admin")],
    ["team-admin", person("team-admin")],
    ["second-admin", person("second-admin")],
    ["member", person("member")],
    ["agent", { id: "agent", businessId: BUSINESS_ID, kind: "agent", status: "active" }],
    ["service", { id: "service", businessId: BUSINESS_ID, kind: "service", status: "active" }],
  ]);
  teams.isActiveHuman = (principalId) => {
    const principal = principals.get(principalId);
    return Boolean(
      principal?.kind === "user" &&
        principal.status === "active" &&
        (!principal.expiresAt || principal.expiresAt > NOW)
    );
  };
  const facts: TeamFact[] = [];
  let nextId = 2;
  const service = new TeamService({
    teams,
    principals: {
      get: async (businessId, principalId) => {
        const principal = principals.get(principalId);
        return principal?.businessId === businessId ? principal : undefined;
      },
    },
    facts: { emit: async (fact) => void facts.push(fact) },
    now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
  });
  return { service, teams, principals, facts };
}

async function createTeam(
  service: TeamService,
  overrides: Partial<Parameters<TeamService["create"]>[0]> = {}
): Promise<TeamRecord> {
  return service.create({
    businessId: BUSINESS_ID,
    slug: "engineering",
    displayName: "Engineering",
    parentTeamId: EVERYONE_ID,
    initialAdminPrincipalIds: ["team-admin"],
    actor: companyAdmin,
    ...overrides,
  });
}

describe("TeamService", () => {
  it("requires company authority, a parent under Everyone, and an initial active human admin", async () => {
    const { service, teams, principals, facts } = fixture();

    await expect(createTeam(service, { actor: teamAdmin() })).rejects.toMatchObject({
      reason: "forbidden",
    });
    await expect(
      createTeam(service, { initialAdminPrincipalIds: ["agent"] })
    ).rejects.toMatchObject({ reason: "invalid" });
    principals.set("disabled-admin", person("disabled-admin", "disabled"));
    await expect(
      createTeam(service, { initialAdminPrincipalIds: ["disabled-admin"] })
    ).rejects.toMatchObject({ reason: "invalid" });

    const created = await createTeam(service);
    expect(created.parentTeamId).toBe(EVERYONE_ID);
    expect(await teams.getMembership(created.id, "team-admin")).toMatchObject({ level: "admin" });
    expect(await teams.getMembership(created.id, "company-admin")).toBeUndefined();
    expect(facts).toContainEqual(expect.objectContaining({ action: "team.created" }));
  });

  it("limits identity changes to company admins and exact-Team admins with revision checks", async () => {
    const { service } = fixture();
    const created = await createTeam(service);

    await expect(
      service.updateIdentity({
        businessId: BUSINESS_ID,
        teamId: created.id,
        displayName: "Platform",
        expectedRevision: created.revision,
        actor: teamAdmin(CHILD_ID),
      })
    ).rejects.toMatchObject({ reason: "forbidden" });

    const updated = await service.updateIdentity({
      businessId: BUSINESS_ID,
      teamId: created.id,
      displayName: "Platform",
      description: "Builds the platform",
      labels: [" Engineering ", "engineering", "Infrastructure"],
      expectedRevision: created.revision,
      actor: teamAdmin(created.id),
    });
    expect(updated).toMatchObject({
      displayName: "Platform",
      description: "Builds the platform",
      labels: ["engineering", "infrastructure"],
      revision: 2,
    });
    await expect(
      service.updateIdentity({
        businessId: BUSINESS_ID,
        teamId: created.id,
        displayName: "Stale",
        expectedRevision: 1,
        actor: teamAdmin(created.id),
      })
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("allows mixed direct membership but only people can be admins", async () => {
    const { service } = fixture();
    const created = await createTeam(service);
    const actor = teamAdmin(created.id);

    await expect(
      service.addMember({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId: "agent",
        level: "admin",
        actor,
      })
    ).rejects.toMatchObject({ reason: "invalid" });
    await expect(
      service.addMember({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId: "member",
        level: "member",
        expiresAt: NOW,
        actor,
      })
    ).rejects.toMatchObject({ reason: "invalid" });

    await expect(
      service.addMember({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId: "agent",
        level: "member",
        actor,
      })
    ).resolves.toMatchObject({ principalKind: "agent", level: "member" });
    await expect(
      service.addMember({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId: "service",
        level: "member",
        actor,
      })
    ).resolves.toMatchObject({ principalKind: "service", level: "member" });
  });

  it("protects the final active admin and supports company-admin recovery", async () => {
    const { service, teams, principals } = fixture();
    const created = await createTeam(service);
    const actor = teamAdmin(created.id);
    for (const principalId of ["second-admin", "member"]) {
      await service.addMember({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId,
        level: "member",
        actor,
      });
    }
    const admin = await teams.getMembership(created.id, "team-admin");
    if (!admin) throw new Error("missing admin");

    await expect(
      service.removeMember(BUSINESS_ID, created.id, admin.principalId, admin.revision, actor)
    ).rejects.toMatchObject({ reason: "final_admin" });
    await expect(
      service.updateMembership({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId: admin.principalId,
        level: "admin",
        expiresAt: new Date(NOW.getTime() + 60_000),
        expectedRevision: admin.revision,
        actor,
      })
    ).rejects.toMatchObject({ reason: "final_admin" });
    principals.set("team-admin", person("team-admin", "disabled"));

    const recovered = await service.recoverAdmin(
      BUSINESS_ID,
      created.id,
      "second-admin",
      created.revision,
      companyAdmin
    );
    expect(recovered.level).toBe("admin");
    expect(recovered.expiresAt).toBeUndefined();
    await expect(
      service.recoverAdmin(BUSINESS_ID, created.id, "member", created.revision, companyAdmin)
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("requires an active direct human membership for Team admin recovery", async () => {
    const { service, principals } = fixture();
    const created = await createTeam(service);
    principals.set("team-admin", person("team-admin", "disabled"));

    await expect(
      service.recoverAdmin(BUSINESS_ID, created.id, "second-admin", created.revision, companyAdmin)
    ).rejects.toMatchObject({ reason: "not_found" });
  });

  it("allows only one concurrent Team admin recovery", async () => {
    const { service, principals } = fixture();
    const created = await createTeam(service);
    const actor = teamAdmin(created.id);
    for (const principalId of ["second-admin", "member"]) {
      await service.addMember({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId,
        level: "member",
        actor,
      });
    }
    principals.set("team-admin", person("team-admin", "disabled"));

    const results = await Promise.allSettled([
      service.recoverAdmin(BUSINESS_ID, created.id, "second-admin", created.revision, companyAdmin),
      service.recoverAdmin(BUSINESS_ID, created.id, "member", created.revision, companyAdmin),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: {
        reason: "conflict",
      },
    });
  });

  it("rejects Team admin recovery at a stale Team revision", async () => {
    const { service, principals } = fixture();
    const created = await createTeam(service);
    principals.set("team-admin", person("team-admin", "disabled"));

    await expect(
      service.recoverAdmin(
        BUSINESS_ID,
        created.id,
        "second-admin",
        created.revision + 1,
        companyAdmin
      )
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("extends expiry only forward and rejects stale membership updates", async () => {
    const { service } = fixture();
    const created = await createTeam(service);
    const actor = teamAdmin(created.id);
    const firstExpiry = new Date(NOW.getTime() + 60_000);
    const membership = await service.addMember({
      businessId: BUSINESS_ID,
      teamId: created.id,
      principalId: "member",
      level: "member",
      expiresAt: firstExpiry,
      actor,
    });

    await expect(
      service.extendMembershipExpiry(
        BUSINESS_ID,
        created.id,
        "member",
        firstExpiry,
        membership.revision,
        actor
      )
    ).rejects.toMatchObject({ reason: "invalid" });
    const extended = await service.extendMembershipExpiry(
      BUSINESS_ID,
      created.id,
      "member",
      new Date(NOW.getTime() + 120_000),
      membership.revision,
      actor
    );
    expect(extended.revision).toBe(2);
    await expect(
      service.updateMembership({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId: "member",
        level: "member",
        expectedRevision: 1,
        actor,
      })
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("allows only one concurrent mutation at the same revision", async () => {
    const { service } = fixture();
    const created = await createTeam(service);
    const actor = teamAdmin(created.id);
    const teamResults = await Promise.allSettled([
      service.updateIdentity({
        businessId: BUSINESS_ID,
        teamId: created.id,
        displayName: "Platform",
        expectedRevision: created.revision,
        actor,
      }),
      service.updateIdentity({
        businessId: BUSINESS_ID,
        teamId: created.id,
        displayName: "Infrastructure",
        expectedRevision: created.revision,
        actor,
      }),
    ]);
    expect(teamResults.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(teamResults.find((result) => result.status === "rejected")?.reason).toMatchObject({
      reason: "conflict",
    });

    const membership = await service.addMember({
      businessId: BUSINESS_ID,
      teamId: created.id,
      principalId: "member",
      level: "member",
      actor,
    });
    const membershipResults = await Promise.allSettled([
      service.updateMembership({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId: "member",
        level: "admin",
        expectedRevision: membership.revision,
        actor,
      }),
      service.updateMembership({
        businessId: BUSINESS_ID,
        teamId: created.id,
        principalId: "member",
        level: "member",
        expiresAt: new Date(NOW.getTime() + 60_000),
        expectedRevision: membership.revision,
        actor,
      }),
    ]);
    expect(membershipResults.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(membershipResults.find((result) => result.status === "rejected")?.reason).toMatchObject({
      reason: "conflict",
    });
  });

  it("resolves direct and descendant membership with non-removable source evidence", async () => {
    const { service, teams } = fixture();
    const parent = await createTeam(service);
    const child = await createTeam(service, {
      slug: "platform",
      displayName: "Platform",
      parentTeamId: parent.id,
      initialAdminPrincipalIds: ["second-admin"],
    });
    await service.addMember({
      businessId: BUSINESS_ID,
      teamId: child.id,
      principalId: "member",
      level: "member",
      actor: teamAdmin(child.id),
    });

    const resolved = await service.resolveMembers(BUSINESS_ID, parent.id);
    expect(resolved).toContainEqual(
      expect.objectContaining({
        membership: "inherited",
        sourceTeamId: child.id,
        pathTeamIds: [child.id, parent.id],
        principalId: "member",
        removable: false,
      })
    );

    const archivedChild = teams.teams.get(child.id);
    if (!archivedChild) throw new Error("missing child");
    teams.teams.set(child.id, {
      ...archivedChild,
      status: "archived",
      archivedAt: NOW,
      revision: 2,
    });
    expect(
      (await service.resolveMembers(BUSINESS_ID, parent.id)).some(
        (membership) => membership.sourceTeamId === child.id
      )
    ).toBe(false);
  });

  it("creates and decides leave requests while preserving the final admin", async () => {
    const { service, teams } = fixture();
    const created = await createTeam(service);
    await service.addMember({
      businessId: BUSINESS_ID,
      teamId: created.id,
      principalId: "member",
      level: "member",
      actor: teamAdmin(created.id),
    });
    const request = await service.requestLeave(BUSINESS_ID, created.id, {
      principalId: "member",
      companyAdmin: false,
      administeredTeamIds: [],
    });
    const rejected = await service.decideLeave(
      BUSINESS_ID,
      created.id,
      request.id,
      "rejected",
      request.revision,
      teamAdmin(created.id)
    );
    expect(rejected.status).toBe("rejected");
    expect(await teams.getMembership(created.id, "member")).toBeDefined();

    const adminRequest = await service.requestLeave(BUSINESS_ID, created.id, teamAdmin(created.id));
    await expect(
      service.decideLeave(
        BUSINESS_ID,
        created.id,
        adminRequest.id,
        "approved",
        adminRequest.revision,
        companyAdmin
      )
    ).rejects.toMatchObject({ reason: "final_admin" });
  });

  it("requires child and ownership cleanup before archive and an empty archive before delete", async () => {
    const { service, teams } = fixture();
    const parent = await createTeam(service);
    await createTeam(service, {
      slug: "platform",
      displayName: "Platform",
      parentTeamId: parent.id,
      initialAdminPrincipalIds: ["second-admin"],
    });

    await expect(
      service.archive(BUSINESS_ID, parent.id, parent.revision, companyAdmin)
    ).rejects.toMatchObject({ reason: "not_empty" });
    teams.teams.delete("00000000-0000-4000-8000-000000000003");
    const archived = await service.archive(BUSINESS_ID, parent.id, parent.revision, companyAdmin);
    expect(archived.status).toBe("archived");

    const admin = await teams.getMembership(parent.id, "team-admin");
    if (!admin) throw new Error("missing admin");
    await service.removeMember(
      BUSINESS_ID,
      parent.id,
      admin.principalId,
      admin.revision,
      companyAdmin
    );
    await service.delete(BUSINESS_ID, parent.id, archived.revision, companyAdmin);
    expect(await teams.getTeam(BUSINESS_ID, parent.id)).toBeUndefined();
  });

  it("protects Everyone identity and membership at the service boundary", async () => {
    const { service } = fixture();

    await expect(
      service.updateIdentity({
        businessId: BUSINESS_ID,
        teamId: EVERYONE_ID,
        displayName: "All",
        expectedRevision: 1,
        actor: companyAdmin,
      })
    ).rejects.toMatchObject({ reason: "protected" });
    await expect(
      service.addMember({
        businessId: BUSINESS_ID,
        teamId: EVERYONE_ID,
        principalId: "member",
        level: "member",
        actor: companyAdmin,
      })
    ).rejects.toBeInstanceOf(TeamServiceError);
    await expect(
      service.addMember({
        businessId: BUSINESS_ID,
        teamId: EVERYONE_ID,
        principalId: "agent",
        level: "member",
        actor: companyAdmin,
      })
    ).resolves.toMatchObject({ principalKind: "agent", level: "member" });
  });
});
