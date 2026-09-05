import type { TeamDelegationGrantScope } from "@tulipfarm/schema";
import type { AccessGrant } from "./grants";
import {
  assertRoleAssignable,
  collectRoleGrantEntries,
  type Role,
  type RoleGrantEntry,
} from "./roles";
import type { TeamMembershipRecord, TeamRecord } from "./teams";

export interface TeamRoleAssignment {
  readonly teamId: string;
  readonly roleId: string;
  readonly expiresAt?: Date;
}

export interface TeamDirectGrant extends AccessGrant {
  readonly id: string;
  readonly teamId: string;
}

export interface TeamAuthorityPort {
  listTeams(businessId: string): Promise<readonly TeamRecord[]>;
  listAllPrincipalMemberships(
    businessId: string,
    principalId: string
  ): Promise<readonly TeamMembershipRecord[]>;
  listAllRoleAssignments(teamId: string): Promise<readonly TeamRoleAssignment[]>;
  listAllGrants(teamId: string): Promise<readonly TeamDirectGrant[]>;
}

export type AuthorityEvidenceKind =
  | "direct_membership"
  | "inherited_membership"
  | "team_ancestry"
  | "role"
  | "grant"
  | "explicit_deny"
  | "expiry"
  | "authority_layer";

export interface AuthorityEvidence {
  readonly kind: AuthorityEvidenceKind;
  readonly effect: "allow" | "deny" | "informational";
  readonly sourceTeamId?: string;
  readonly sourcePrincipalId?: string;
  readonly roleId?: string;
  readonly grantId?: string;
  readonly authorityLayer?: string;
  readonly pathTeamIds?: readonly string[];
  readonly expiresAt?: Date;
}

export interface TeamAuthorityResolution {
  readonly grants: readonly AccessGrant[];
  readonly evidence: readonly AuthorityEvidence[];
  readonly unresolvedRoleIds: readonly string[];
  readonly unassignableRoleIds: readonly string[];
}

const TEAM_MEMBER_ACTIONS = [
  "team.read",
  "team.member.read",
  "team.authority.read",
  "team.activity.read",
  "team.access.explain",
  "team.leave.request",
] as const;

const TEAM_ADMIN_ACTIONS = [
  "team.write",
  "team.member.manage",
  "team.leave.decide",
  "team.role.manage",
  "team.grant.manage",
] as const;

export interface TeamDelegationPolicy {
  readonly teamId: string;
  readonly allowedRoleIds: readonly string[];
  readonly allowedGrantScopes: readonly TeamDelegationGrantScope[];
}

export interface TeamDelegationPolicyPort {
  getDelegationPolicy(teamId: string): Promise<TeamDelegationPolicy | undefined>;
}

export interface TeamAuthorityAssignmentPort extends TeamDelegationPolicyPort {
  getTeam(businessId: string, teamId: string): Promise<TeamRecord | undefined>;
  assignRole(record: TeamRoleAssignment & { readonly assignedAt: Date }): Promise<void>;
  putGrant(
    record: TeamDirectGrant & { readonly createdAt: Date; readonly updatedAt: Date }
  ): Promise<void>;
}

export interface TeamAuthorityRolePort {
  getRole(businessId: string, roleId: string): Promise<Role | undefined>;
}

export type TeamAuthorityAssignment =
  | { readonly kind: "role"; readonly roleId: string }
  | { readonly kind: "grant"; readonly grant: Pick<AccessGrant, "action" | "resourceType"> };

export type TeamDelegationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "not_exact_team_admin"
        | "missing_policy"
        | "role_not_delegated"
        | "scope_not_delegated";
    };

export type TeamAuthorityAssignmentErrorReason =
  | "not_found"
  | "inactive_team"
  | "not_assignable"
  | "not_delegated"
  | "invalid_expiry";

export class TeamAuthorityAssignmentError extends Error {
  constructor(
    readonly reason: TeamAuthorityAssignmentErrorReason,
    message: string
  ) {
    super(message);
    this.name = "TeamAuthorityAssignmentError";
  }
}

function activeAt(record: { readonly expiresAt?: Date }, now: Date): boolean {
  return !record.expiresAt || record.expiresAt > now;
}

function pathToRoot(
  source: TeamRecord,
  teamsById: ReadonlyMap<string, TeamRecord>
): readonly TeamRecord[] {
  const path: TeamRecord[] = [];
  let current: TeamRecord | undefined = source;
  while (current) {
    if (path.length >= 10 || path.some((team) => team.id === current?.id)) {
      throw new Error("Team hierarchy exceeds its maximum depth or contains a cycle");
    }
    path.push(current);
    if (!current.parentTeamId) break;
    current = teamsById.get(current.parentTeamId);
    if (!current) throw new Error("Team hierarchy contains a missing parent");
  }
  return path;
}

function grantEvidence(
  entry: RoleGrantEntry,
  sourceTeamId: string,
  pathTeamIds: readonly string[]
): AuthorityEvidence {
  return {
    kind: entry.grant.effect === "deny" ? "explicit_deny" : "grant",
    effect: entry.grant.effect,
    sourceTeamId,
    roleId: entry.roleId,
    grantId: `${entry.roleId}:${entry.grantIndex}`,
    pathTeamIds,
    ...(entry.grant.expiresAt ? { expiresAt: entry.grant.expiresAt } : {}),
  };
}

/**
 * Resolves Team authority live. Direct membership reaches the source Team and each active
 * ancestor; the inverse direction is never traversed.
 */
export async function resolveTeamAuthority(
  port: TeamAuthorityPort,
  rolesById: ReadonlyMap<string, Role>,
  principal: { readonly id: string; readonly kind: string; readonly businessId: string },
  now: Date
): Promise<TeamAuthorityResolution> {
  const teams = await port.listTeams(principal.businessId);
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const grants: AccessGrant[] = [];
  const evidence: AuthorityEvidence[] = [];
  const unresolvedRoleIds = new Set<string>();
  const unassignableRoleIds = new Set<string>();
  const memberships = await port.listAllPrincipalMemberships(principal.businessId, principal.id);

  for (const membership of memberships) {
    const team = teamsById.get(membership.teamId);
    if (!team || membership.principalKind !== principal.kind) continue;
    if (!activeAt(membership, now)) {
      evidence.push({
        kind: "expiry",
        effect: "informational",
        sourceTeamId: team.id,
        expiresAt: membership.expiresAt,
      });
      continue;
    }
    if (team.status !== "active") continue;

    const ancestry = pathToRoot(team, teamsById);
    for (const [index, authorityTeam] of ancestry.entries()) {
      if (authorityTeam.status !== "active") break;
      const pathTeamIds = ancestry.slice(0, index + 1).map((candidate) => candidate.id);
      evidence.push({
        kind: index === 0 ? "direct_membership" : "inherited_membership",
        effect: "informational",
        sourceTeamId: authorityTeam.id,
        pathTeamIds,
        ...(membership.expiresAt ? { expiresAt: membership.expiresAt } : {}),
      });
      if (index > 0) {
        evidence.push({
          kind: "team_ancestry",
          effect: "informational",
          sourceTeamId: authorityTeam.id,
          pathTeamIds,
        });
      }
      for (const action of TEAM_MEMBER_ACTIONS) {
        grants.push({
          action,
          resourceType: "team",
          recordSelector: authorityTeam.id,
          effect: "allow",
          ...(membership.expiresAt ? { expiresAt: membership.expiresAt } : {}),
        });
      }
      if (index === 0 && membership.level === "admin" && membership.principalKind === "user") {
        for (const action of TEAM_ADMIN_ACTIONS) {
          grants.push({
            action,
            resourceType: "team",
            recordSelector: authorityTeam.id,
            effect: "allow",
            ...(membership.expiresAt ? { expiresAt: membership.expiresAt } : {}),
          });
        }
      }

      for (const assignment of await port.listAllRoleAssignments(authorityTeam.id)) {
        if (!activeAt(assignment, now)) {
          evidence.push({
            kind: "expiry",
            effect: "informational",
            sourceTeamId: authorityTeam.id,
            roleId: assignment.roleId,
            pathTeamIds,
            expiresAt: assignment.expiresAt,
          });
          continue;
        }
        const role = rolesById.get(assignment.roleId);
        if (!role) {
          unresolvedRoleIds.add(assignment.roleId);
          continue;
        }
        try {
          assertRoleAssignable(role, { kind: "team", businessId: principal.businessId }, now);
          const entries = collectRoleGrantEntries([role.id], rolesById, now);
          evidence.push({
            kind: "role",
            effect: "informational",
            sourceTeamId: authorityTeam.id,
            roleId: role.id,
            pathTeamIds,
            ...(assignment.expiresAt ? { expiresAt: assignment.expiresAt } : {}),
          });
          for (const entry of entries) {
            grants.push(entry.grant);
            evidence.push(grantEvidence(entry, authorityTeam.id, pathTeamIds));
          }
        } catch {
          unassignableRoleIds.add(assignment.roleId);
        }
      }

      for (const grant of await port.listAllGrants(authorityTeam.id)) {
        if (!activeAt(grant, now)) {
          evidence.push({
            kind: "expiry",
            effect: "informational",
            sourceTeamId: authorityTeam.id,
            grantId: grant.id,
            pathTeamIds,
            expiresAt: grant.expiresAt,
          });
          continue;
        }
        grants.push(grant);
        evidence.push({
          kind: grant.effect === "deny" ? "explicit_deny" : "grant",
          effect: grant.effect,
          sourceTeamId: authorityTeam.id,
          grantId: grant.id,
          pathTeamIds,
          ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
        });
      }
    }
  }

  return {
    grants,
    evidence,
    unresolvedRoleIds: [...unresolvedRoleIds],
    unassignableRoleIds: [...unassignableRoleIds],
  };
}

function delegatedValue(value: string, allowed: readonly string[]): boolean {
  return allowed.includes("*") || allowed.includes(value);
}

/** Decides Team-admin assignment from the Team policy only; personal authority is not an input. */
export async function decideTeamDelegation(
  policies: TeamDelegationPolicyPort,
  input: {
    readonly teamId: string;
    readonly administeredTeamIds: readonly string[];
    readonly companyAdmin: boolean;
    readonly assignment: TeamAuthorityAssignment;
  }
): Promise<TeamDelegationDecision> {
  if (input.companyAdmin) return { allowed: true };
  if (!input.administeredTeamIds.includes(input.teamId)) {
    return { allowed: false, reason: "not_exact_team_admin" };
  }
  const policy = await policies.getDelegationPolicy(input.teamId);
  if (!policy) return { allowed: false, reason: "missing_policy" };
  if (input.assignment.kind === "role") {
    return policy.allowedRoleIds.includes(input.assignment.roleId)
      ? { allowed: true }
      : { allowed: false, reason: "role_not_delegated" };
  }
  const grant = input.assignment.grant;
  return policy.allowedGrantScopes.some(
    (scope) =>
      delegatedValue(grant.action, scope.actions) &&
      delegatedValue(grant.resourceType, scope.resourceTypes)
  )
    ? { allowed: true }
    : { allowed: false, reason: "scope_not_delegated" };
}

/** Mutation boundary for later Team APIs; every Team-admin write passes the persisted policy. */
export class TeamAuthorityAssignmentService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly assignments: TeamAuthorityAssignmentPort,
    private readonly roles: TeamAuthorityRolePort,
    options: { readonly now?: () => Date; readonly newId?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  async assignRole(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly roleId: string;
    readonly expiresAt?: Date;
    readonly actor: {
      readonly companyAdmin: boolean;
      readonly administeredTeamIds: readonly string[];
    };
  }): Promise<void> {
    const now = this.now();
    const [team, role] = await Promise.all([
      this.assignments.getTeam(input.businessId, input.teamId),
      this.roles.getRole(input.businessId, input.roleId),
    ]);
    if (!team || !role) {
      throw new TeamAuthorityAssignmentError("not_found", "Team or Role was not found");
    }
    if (team.status !== "active") {
      throw new TeamAuthorityAssignmentError("inactive_team", "Team is archived");
    }
    this.assertFutureExpiry(input.expiresAt, now);
    try {
      assertRoleAssignable(role, { kind: "team", businessId: input.businessId }, now);
    } catch (error) {
      throw new TeamAuthorityAssignmentError(
        "not_assignable",
        error instanceof Error ? error.message : String(error)
      );
    }
    await this.assertDelegated(input, { kind: "role", roleId: input.roleId });
    await this.assignments.assignRole({
      teamId: input.teamId,
      roleId: input.roleId,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      assignedAt: now,
    });
  }

  async putGrant(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly grant: AccessGrant;
    readonly actor: {
      readonly companyAdmin: boolean;
      readonly administeredTeamIds: readonly string[];
    };
  }): Promise<string> {
    const now = this.now();
    const team = await this.assignments.getTeam(input.businessId, input.teamId);
    if (!team) throw new TeamAuthorityAssignmentError("not_found", "Team was not found");
    if (team.status !== "active") {
      throw new TeamAuthorityAssignmentError("inactive_team", "Team is archived");
    }
    this.assertFutureExpiry(input.grant.expiresAt, now);
    await this.assertDelegated(input, { kind: "grant", grant: input.grant });
    const id = this.newId();
    await this.assignments.putGrant({
      id,
      teamId: input.teamId,
      ...input.grant,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  private async assertDelegated(
    input: {
      readonly teamId: string;
      readonly actor: {
        readonly companyAdmin: boolean;
        readonly administeredTeamIds: readonly string[];
      };
    },
    assignment: TeamAuthorityAssignment
  ): Promise<void> {
    const decision = await decideTeamDelegation(this.assignments, {
      teamId: input.teamId,
      administeredTeamIds: input.actor.administeredTeamIds,
      companyAdmin: input.actor.companyAdmin,
      assignment,
    });
    if (!decision.allowed) {
      throw new TeamAuthorityAssignmentError("not_delegated", decision.reason);
    }
  }

  private assertFutureExpiry(expiresAt: Date | undefined, now: Date): void {
    if (expiresAt && expiresAt <= now) {
      throw new TeamAuthorityAssignmentError("invalid_expiry", "Assignment expiry must be future");
    }
  }
}

import { randomUUID } from "node:crypto";
