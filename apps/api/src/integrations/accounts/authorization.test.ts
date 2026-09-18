import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { TeamMembershipRecord, TeamRecord } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import type { UserDoc } from "../../auth/users";
import { createMcpAccountAuthorization } from "./authorization";

class UserLookup {
  readonly records = new Map<string, UserDoc>();
  async findById(id: string) {
    return this.records.get(id) ?? null;
  }
}

class TeamLookup {
  team: TeamRecord | undefined;
  membership: TeamMembershipRecord | undefined;
  async getTeam(businessId: string, teamId: string) {
    return this.team?.businessId === businessId && this.team.id === teamId ? this.team : undefined;
  }
  async getMembership(teamId: string, principalId: string) {
    return this.membership?.teamId === teamId && this.membership.principalId === principalId
      ? this.membership
      : undefined;
  }
}

function fixture() {
  const users = new UserLookup();
  const teams = new TeamLookup();
  const now = new Date("2026-09-18T00:00:00.000Z");
  const user: UserDoc = {
    _id: "user",
    email: "muskan@example.test",
    name: "Muskan Vijayvargiya",
    passwordHash: null,
    role: "admin",
    status: "active",
    createdAt: now,
  };
  users.records.set(user._id, user);
  const authorizationCheck = vi.fn(async () => false);
  const authorization = createMcpAccountAuthorization({
    businessId: DEPLOYMENT_BUSINESS_ID,
    users,
    teams,
    authorizationCheck,
    now: () => now,
  });
  return { users, teams, user, authorizationCheck, authorization, now };
}

describe("MCP account human authorization", () => {
  it("rejects disabled, invited, unlinked, service-only, and cross-business identities", async () => {
    const f = fixture();
    expect(await f.authorization.isActivePrincipal(DEPLOYMENT_BUSINESS_ID, "user")).toBe(true);
    expect(await f.authorization.isActivePrincipal(DEPLOYMENT_BUSINESS_ID, "external-sender")).toBe(
      false
    );
    expect(await f.authorization.isActivePrincipal(DEPLOYMENT_BUSINESS_ID, "api-client")).toBe(
      false
    );
    expect(await f.authorization.isActivePrincipal("another-business", "user")).toBe(false);
    f.user.status = "disabled";
    expect(await f.authorization.isActivePrincipal(DEPLOYMENT_BUSINESS_ID, "user")).toBe(false);
    f.user.status = "invited";
    expect(await f.authorization.isActivePrincipal(DEPLOYMENT_BUSINESS_ID, "user")).toBe(false);
  });

  it("uses the existing authorizer rather than granting shared management from an inline role check", async () => {
    const f = fixture();
    expect(await f.authorization.canManageShared(DEPLOYMENT_BUSINESS_ID, "user")).toBe(false);
    expect(f.authorizationCheck).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user", kind: "user" }),
      {
        action: "integration.accounts.manage",
        resourceType: "integration_account",
        fallback: "admin",
      }
    );
    f.authorizationCheck.mockResolvedValue(true);
    expect(await f.authorization.canManageShared(DEPLOYMENT_BUSINESS_ID, "user")).toBe(true);
    f.user.status = "disabled";
    expect(await f.authorization.canManageShared(DEPLOYMENT_BUSINESS_ID, "user")).toBe(false);
    expect(f.authorizationCheck).toHaveBeenCalledTimes(2);
  });

  it("rechecks active Team membership, expiry, and human member kind on every use", async () => {
    const f = fixture();
    f.teams.team = {
      id: "team",
      businessId: DEPLOYMENT_BUSINESS_ID,
      slug: "support",
      displayName: "Support",
      status: "active",
      protected: false,
      revision: 1,
      createdAt: f.now,
      updatedAt: f.now,
    };
    f.teams.membership = {
      teamId: "team",
      principalId: "user",
      principalKind: "user",
      level: "member",
      revision: 1,
      createdAt: f.now,
      updatedAt: f.now,
    };
    expect(await f.authorization.isTeamMember(DEPLOYMENT_BUSINESS_ID, "team", "user")).toBe(true);
    f.teams.membership = { ...f.teams.membership, expiresAt: f.now };
    expect(await f.authorization.isTeamMember(DEPLOYMENT_BUSINESS_ID, "team", "user")).toBe(false);
    f.teams.membership = undefined;
    expect(await f.authorization.isTeamMember(DEPLOYMENT_BUSINESS_ID, "team", "user")).toBe(false);
  });
});
