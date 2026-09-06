import { describe, expect, it } from "vitest";
import type { Role } from "./roles";
import {
  decideTeamDelegation,
  resolveTeamAuthority,
  TeamAuthorityAssignmentService,
  type TeamAuthorityPort,
} from "./team-authority";
import type { TeamMembershipRecord, TeamRecord } from "./teams";

const NOW = new Date("2026-09-05T12:00:00Z");
const BUSINESS_ID = "business";
const ROOT = "00000000-0000-4000-8000-000000000001";
const PARENT = "00000000-0000-4000-8000-000000000002";
const CHILD = "00000000-0000-4000-8000-000000000003";

function team(id: string, parentTeamId?: string): TeamRecord {
  return {
    id,
    businessId: BUSINESS_ID,
    slug: id,
    displayName: id,
    ...(parentTeamId ? { parentTeamId } : {}),
    status: "active",
    protected: id === ROOT,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function membership(
  teamId: string,
  principalId: string,
  expiresAt?: Date,
  level: TeamMembershipRecord["level"] = "member"
): TeamMembershipRecord {
  return {
    teamId,
    principalId,
    principalKind: "user",
    level,
    ...(expiresAt ? { expiresAt } : {}),
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture(): {
  port: TeamAuthorityPort;
  memberships: TeamMembershipRecord[];
  assignments: { teamId: string; roleId: string; expiresAt?: Date }[];
  grants: {
    id: string;
    teamId: string;
    action: string;
    resourceType: string;
    effect: "allow" | "deny";
    expiresAt?: Date;
  }[];
} {
  const teams = [team(ROOT), team(PARENT, ROOT), team(CHILD, PARENT)];
  const memberships: TeamMembershipRecord[] = [];
  const assignments: { teamId: string; roleId: string; expiresAt?: Date }[] = [];
  const grants: {
    id: string;
    teamId: string;
    action: string;
    resourceType: string;
    effect: "allow" | "deny";
    expiresAt?: Date;
  }[] = [];
  return {
    memberships,
    assignments,
    grants,
    port: {
      listTeams: async () => teams,
      listAllPrincipalMemberships: async (_businessId, principalId) =>
        memberships.filter((entry) => entry.principalId === principalId),
      listAllRoleAssignments: async (teamId) =>
        assignments.filter((entry) => entry.teamId === teamId),
      listAllGrants: async (teamId) => grants.filter((entry) => entry.teamId === teamId),
    },
  };
}

const roles = new Map<string, Role>([
  [
    "reader",
    {
      id: "reader",
      businessId: BUSINESS_ID,
      assignableTo: ["team"],
      parentRoleIds: [],
      grants: [{ action: "record.read", resourceType: "ticket", effect: "allow" }],
    },
  ],
]);

describe("resolveTeamAuthority", () => {
  it("flows parent authority down without flowing child authority up", async () => {
    const childMember = fixture();
    childMember.memberships.push(membership(CHILD, "person"));
    childMember.assignments.push({ teamId: PARENT, roleId: "reader" });
    const inherited = await resolveTeamAuthority(
      childMember.port,
      roles,
      { id: "person", kind: "user", businessId: BUSINESS_ID },
      NOW
    );
    expect(inherited.grants).toContainEqual(
      expect.objectContaining({ action: "record.read", resourceType: "ticket" })
    );
    expect(inherited.evidence).toContainEqual(
      expect.objectContaining({
        kind: "inherited_membership",
        sourceTeamId: PARENT,
        pathTeamIds: [CHILD, PARENT],
      })
    );

    const parentMember = fixture();
    parentMember.memberships.push(membership(PARENT, "person"));
    parentMember.assignments.push({ teamId: CHILD, roleId: "reader" });
    const upward = await resolveTeamAuthority(
      parentMember.port,
      roles,
      { id: "person", kind: "user", businessId: BUSINESS_ID },
      NOW
    );
    expect(upward.grants).not.toContainEqual(
      expect.objectContaining({ action: "record.read", resourceType: "ticket" })
    );
  });

  it("grants Team members read actions and human admins exact-Team management actions", async () => {
    const data = fixture();
    data.memberships.push(membership(CHILD, "person", undefined, "admin"));

    const resolved = await resolveTeamAuthority(
      data.port,
      roles,
      { id: "person", kind: "user", businessId: BUSINESS_ID },
      NOW
    );

    expect(resolved.grants).toContainEqual({
      action: "team.read",
      resourceType: "team",
      recordSelector: PARENT,
      effect: "allow",
    });
    expect(resolved.grants).toContainEqual({
      action: "team.member.manage",
      resourceType: "team",
      recordSelector: CHILD,
      effect: "allow",
    });
    expect(resolved.grants).not.toContainEqual(
      expect.objectContaining({
        action: "team.member.manage",
        recordSelector: PARENT,
      })
    );
  });

  it("combines multiple Teams, retains denies, and records expired sources", async () => {
    const data = fixture();
    data.memberships.push(membership(PARENT, "person"), membership(CHILD, "person"));
    data.assignments.push({ teamId: PARENT, roleId: "reader" });
    data.grants.push({
      id: "deny-delete",
      teamId: CHILD,
      action: "record.delete",
      resourceType: "ticket",
      effect: "deny",
    });
    data.grants.push({
      id: "expired",
      teamId: CHILD,
      action: "record.write",
      resourceType: "ticket",
      effect: "allow",
      expiresAt: NOW,
    });

    const resolved = await resolveTeamAuthority(
      data.port,
      roles,
      { id: "person", kind: "user", businessId: BUSINESS_ID },
      NOW
    );
    expect(resolved.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "record.read", effect: "allow" }),
        expect.objectContaining({ action: "record.delete", effect: "deny" }),
      ])
    );
    expect(resolved.evidence).toContainEqual(
      expect.objectContaining({ kind: "explicit_deny", grantId: "deny-delete" })
    );
    expect(resolved.evidence).toContainEqual(
      expect.objectContaining({ kind: "expiry", grantId: "expired", expiresAt: NOW })
    );
  });
});

describe("decideTeamDelegation", () => {
  const policies = {
    getDelegationPolicy: async () => ({
      teamId: CHILD,
      allowedRoleIds: ["reader"],
      allowedGrantScopes: [{ actions: ["record.read"], resourceTypes: ["ticket"] }],
    }),
  };

  it("uses exact-Team policy and ignores personal authority", async () => {
    await expect(
      decideTeamDelegation(policies, {
        teamId: CHILD,
        administeredTeamIds: [CHILD],
        companyAdmin: false,
        assignment: { kind: "role", roleId: "reader" },
      })
    ).resolves.toEqual({ allowed: true });
    await expect(
      decideTeamDelegation(policies, {
        teamId: CHILD,
        administeredTeamIds: [PARENT],
        companyAdmin: false,
        assignment: { kind: "role", roleId: "reader" },
      })
    ).resolves.toEqual({ allowed: false, reason: "not_exact_team_admin" });
    await expect(
      decideTeamDelegation(policies, {
        teamId: CHILD,
        administeredTeamIds: [CHILD],
        companyAdmin: false,
        assignment: {
          kind: "grant",
          grant: { action: "record.delete", resourceType: "ticket" },
        },
      })
    ).resolves.toEqual({ allowed: false, reason: "scope_not_delegated" });
  });

  it("enforces policy and Team Role targets at the mutation boundary", async () => {
    const assigned: string[] = [];
    const service = new TeamAuthorityAssignmentService(
      {
        ...policies,
        getTeam: async () => team(CHILD, PARENT),
        assignRole: async (record) => void assigned.push(record.roleId),
        putGrant: async () => undefined,
      },
      {
        getRole: async (_businessId, roleId) =>
          roleId === "reader"
            ? roles.get("reader")
            : {
                id: roleId,
                businessId: BUSINESS_ID,
                assignableTo: ["user"],
                parentRoleIds: [],
                grants: [],
              },
      },
      { now: () => NOW }
    );

    await service.assignRole({
      businessId: BUSINESS_ID,
      teamId: CHILD,
      roleId: "reader",
      actor: { companyAdmin: false, administeredTeamIds: [CHILD] },
    });
    expect(assigned).toEqual(["reader"]);
    await expect(
      service.assignRole({
        businessId: BUSINESS_ID,
        teamId: CHILD,
        roleId: "person-only",
        actor: { companyAdmin: true, administeredTeamIds: [] },
      })
    ).rejects.toMatchObject({ reason: "not_assignable" });
  });
});
