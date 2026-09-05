import { randomBytes } from "node:crypto";
import {
  analyzeTeamMove,
  decideTeamDelegation,
  type TeamActorCapabilities,
  TeamAuthorityAssignmentError,
  TeamAuthorityAssignmentService,
  type TeamFact,
  type TeamMoveAssetImpactPort,
  type TeamMoveImpact,
  TeamService,
  TeamServiceError,
} from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  canonicalHash,
  type TeamDelegationGrantScope,
  type TeamMembershipLevel,
} from "@tulipfarm/schema";
import {
  type PrincipalRepo,
  type RoleRepo,
  type TeamDelegationPolicyRecord,
  TeamDelegationPolicyRevisionConflictError,
  type TeamGrantRecord,
  type TeamMembershipRecord,
  type TeamRepo,
  type TeamRoleAssignmentRecord,
} from "@tulipfarm/storage";
import type { ActivityService } from "../activity/service";
import type { AuditRecordInput } from "../audit/service";
import type { UserRepo } from "../auth/users";
import type { RequestPrincipal } from "../identity/principal";
import { isDeploymentAdmin } from "./route-gate";
import type { AuthzAdminService, ExplainInput } from "./service";
import type { TeamNotificationService } from "./team-notifications";

export interface TeamActivityQuery {
  readonly limit: number;
  readonly action?: string;
}

export interface TeamApiServiceDeps {
  readonly teams: TeamRepo;
  readonly principals: PrincipalRepo;
  readonly roles: RoleRepo;
  readonly explanations: AuthzAdminService;
  readonly activity?: ActivityService;
  readonly audit?: { recordOrWarn(input: AuditRecordInput): Promise<void> };
  readonly notifications?: TeamNotificationService;
  readonly users?: Pick<UserRepo, "findById">;
  readonly moveAssets: TeamMoveAssetImpactPort;
  readonly moveNotifications?: TeamMoveNotificationPort;
  readonly businessId?: string;
  readonly now?: () => Date;
}

export interface TeamMoveNotificationPort {
  emitHierarchyChange(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly previousParentTeamId: string;
    readonly proposedParentTeamId: string;
    readonly affectedPrincipalIds: readonly string[];
    readonly descendantTeamIds: readonly string[];
    readonly gainedAncestorTeamIds: readonly string[];
    readonly lostAncestorTeamIds: readonly string[];
    readonly accessChanges: TeamMoveImpact["accessChanges"];
    readonly impactDigest: string;
    readonly occurredAt: Date;
  }): Promise<void>;
}

function iso(value: Date | undefined): string | null {
  return value?.toISOString() ?? null;
}

function teamView(team: Awaited<ReturnType<TeamService["read"]>>) {
  return {
    id: team.id,
    businessId: team.businessId,
    slug: team.slug,
    displayName: team.displayName,
    description: team.description ?? null,
    labels: team.labels ?? [],
    status: team.status,
    parentTeamId: team.parentTeamId ?? null,
    protected: team.protected,
    revision: team.revision,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
    archivedAt: iso(team.archivedAt),
  };
}

function membershipView(membership: TeamMembershipRecord) {
  return {
    teamId: membership.teamId,
    principalId: membership.principalId,
    principalKind: membership.principalKind,
    level: membership.level,
    expiresAt: iso(membership.expiresAt),
    revision: membership.revision,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  };
}

function roleView(
  assignment: TeamRoleAssignmentRecord,
  source: "direct" | "inherited",
  path: string[]
) {
  return {
    source,
    sourceTeamId: assignment.teamId,
    pathTeamIds: path,
    roleId: assignment.roleId,
    expiresAt: iso(assignment.expiresAt),
    assignedAt: assignment.assignedAt.toISOString(),
  };
}

function grantView(grant: TeamGrantRecord, source: "direct" | "inherited", path: string[]) {
  return {
    source,
    sourceTeamId: grant.teamId,
    pathTeamIds: path,
    id: grant.id,
    action: grant.action,
    resourceType: grant.resourceType,
    effect: grant.effect,
    domain: grant.domain ?? null,
    recordSelector: grant.recordSelector ?? null,
    fieldSelector: grant.fieldSelector ?? null,
    dataClass: grant.dataClass ?? null,
    destination: grant.destination ?? null,
    conditions: grant.conditions ?? null,
    expiresAt: iso(grant.expiresAt),
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

export class TeamApiService {
  private readonly businessId: string;
  private readonly now: () => Date;
  private readonly domain: TeamService;
  private readonly authority: TeamAuthorityAssignmentService;
  private readonly moveAssets: TeamMoveAssetImpactPort;

  constructor(private readonly deps: TeamApiServiceDeps) {
    if (!deps.moveAssets) {
      throw new Error("TeamApiService requires a Team move asset impact adapter");
    }
    this.businessId = deps.businessId ?? DEPLOYMENT_BUSINESS_ID;
    this.now = deps.now ?? (() => new Date());
    this.moveAssets = deps.moveAssets;
    this.domain = new TeamService({
      teams: deps.teams,
      principals: deps.principals,
      facts: { emit: (fact) => this.recordFact(fact) },
      now: this.now,
    });
    this.authority = new TeamAuthorityAssignmentService(deps.teams, deps.roles, {
      now: this.now,
    });
  }

  async actor(principal: RequestPrincipal): Promise<TeamActorCapabilities> {
    const memberships = await this.deps.teams.listPrincipalMemberships(
      this.businessId,
      principal.id,
      this.now()
    );
    return {
      principalId: principal.id,
      companyAdmin: isDeploymentAdmin(principal),
      administeredTeamIds: memberships
        .filter(
          (membership) =>
            membership.principalKind === "user" &&
            membership.level === "admin" &&
            (!membership.expiresAt || membership.expiresAt > this.now())
        )
        .map((membership) => membership.teamId),
    };
  }

  async list() {
    const teams = await this.domain.list(this.businessId);
    return {
      teams: await Promise.all(
        teams.map(async (team) => ({
          ...teamView(team),
          members: await Promise.all(
            (await this.deps.teams.listMemberships(team.id, this.now())).map(async (membership) => {
              const user =
                membership.principalKind === "user"
                  ? await this.deps.users?.findById(membership.principalId)
                  : null;
              return {
                principalId: membership.principalId,
                name: user?.name ?? user?.email ?? membership.principalId,
                level: membership.level,
              };
            })
          ),
        }))
      ),
    };
  }

  async get(teamId: string) {
    return teamView(await this.domain.read(this.businessId, teamId));
  }

  async notifications(principalId: string) {
    return {
      items: (await this.deps.notifications?.listForPrincipal(this.businessId, principalId)) ?? [],
    };
  }

  async hierarchy() {
    const teams = await this.domain.list(this.businessId);
    const byId = new Map(teams.map((team) => [team.id, team]));
    return {
      teams: teams.map((team) => {
        const ancestorTeamIds: string[] = [];
        let current = team;
        while (current.parentTeamId) {
          ancestorTeamIds.push(current.parentTeamId);
          const parent = byId.get(current.parentTeamId);
          if (!parent) break;
          current = parent;
        }
        return {
          teamId: team.id,
          parentTeamId: team.parentTeamId ?? null,
          ancestorTeamIds,
          depth: ancestorTeamIds.length + 1,
        };
      }),
    };
  }

  async create(
    input: {
      slug: string;
      displayName: string;
      description?: string;
      labels?: readonly string[];
      parentTeamId: string;
      initialAdminUserIds: readonly string[];
    },
    actor: TeamActorCapabilities
  ) {
    return teamView(
      await this.domain.create({
        businessId: this.businessId,
        slug: input.slug,
        displayName: input.displayName,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        parentTeamId: input.parentTeamId,
        initialAdminPrincipalIds: input.initialAdminUserIds,
        actor,
      })
    );
  }

  async update(
    teamId: string,
    input: {
      displayName?: string;
      description?: string | null;
      labels?: readonly string[];
      revision: number;
    },
    actor: TeamActorCapabilities
  ) {
    return teamView(
      await this.domain.updateIdentity({
        businessId: this.businessId,
        teamId,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        expectedRevision: input.revision,
        actor,
      })
    );
  }

  async members(teamId: string) {
    const members = await this.domain.resolveMembers(this.businessId, teamId);
    return {
      direct: members
        .filter((member) => member.membership === "direct")
        .map((member) => ({
          ...member,
          expiresAt: iso(member.expiresAt),
        })),
      inherited: members
        .filter((member) => member.membership === "inherited")
        .map((member) => ({
          ...member,
          expiresAt: iso(member.expiresAt),
        })),
    };
  }

  async addMember(
    teamId: string,
    input: {
      principalId: string;
      level: TeamMembershipLevel;
      expiresAt?: string;
    },
    actor: TeamActorCapabilities
  ) {
    const membership = await this.domain.addMember({
      businessId: this.businessId,
      teamId,
      principalId: input.principalId,
      level: input.level,
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      actor,
    });
    await this.deps.notifications?.membershipChanged({
      businessId: this.businessId,
      teamId,
      membership,
    });
    return membershipView(membership);
  }

  async bulkAddMembers(
    teamId: string,
    entries: readonly {
      principalId: string;
      level: TeamMembershipLevel;
      expiresAt?: string;
    }[],
    actor: TeamActorCapabilities
  ) {
    const results = [];
    for (const entry of entries) {
      try {
        results.push({
          principalId: entry.principalId,
          ok: true as const,
          membership: await this.addMember(teamId, entry, actor),
        });
      } catch (error) {
        results.push({
          principalId: entry.principalId,
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results };
  }

  async updateMember(
    teamId: string,
    principalId: string,
    input: { level: TeamMembershipLevel; expiresAt?: string | null; revision: number },
    actor: TeamActorCapabilities
  ) {
    const previous = await this.deps.teams.getMembership(teamId, principalId);
    const expiresAt =
      input.expiresAt === undefined
        ? previous?.expiresAt
        : input.expiresAt === null
          ? undefined
          : new Date(input.expiresAt);
    const membership = await this.domain.updateMembership({
      businessId: this.businessId,
      teamId,
      principalId,
      level: input.level,
      ...(expiresAt ? { expiresAt } : {}),
      expectedRevision: input.revision,
      actor,
    });
    await this.deps.notifications?.membershipChanged({
      businessId: this.businessId,
      teamId,
      membership,
      ...(previous ? { previous } : {}),
    });
    return membershipView(membership);
  }

  async removeMember(
    teamId: string,
    principalId: string,
    revision: number,
    actor: TeamActorCapabilities
  ) {
    const membership = await this.deps.teams.getMembership(teamId, principalId);
    await this.domain.removeMember(this.businessId, teamId, principalId, revision, actor);
    if (membership) {
      await this.deps.notifications?.membershipChanged({
        businessId: this.businessId,
        teamId,
        membership,
        removed: true,
      });
    }
  }

  async recoverAdmin(
    teamId: string,
    input: { principalId: string; revision: number },
    actor: TeamActorCapabilities
  ) {
    const previous = await this.deps.teams.getMembership(teamId, input.principalId);
    const membership = await this.domain.recoverAdmin(
      this.businessId,
      teamId,
      input.principalId,
      input.revision,
      actor
    );
    await this.deps.notifications?.membershipChanged({
      businessId: this.businessId,
      teamId,
      membership,
      ...(previous ? { previous } : {}),
    });
    return membershipView(membership);
  }

  async bulkRemoveMembers(
    teamId: string,
    entries: readonly { principalId: string; revision: number }[],
    actor: TeamActorCapabilities
  ) {
    const results = [];
    for (const entry of entries) {
      try {
        await this.removeMember(teamId, entry.principalId, entry.revision, actor);
        results.push({ principalId: entry.principalId, ok: true as const });
      } catch (error) {
        results.push({
          principalId: entry.principalId,
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results };
  }

  async requestLeave(teamId: string, actor: TeamActorCapabilities) {
    return this.leaveRequestView(await this.domain.requestLeave(this.businessId, teamId, actor));
  }

  async leaveRequests(teamId: string) {
    await this.domain.read(this.businessId, teamId);
    return {
      requests: (await this.deps.teams.listLeaveRequests(teamId)).map((request) =>
        this.leaveRequestView(request)
      ),
    };
  }

  async decideLeave(
    teamId: string,
    requestId: string,
    input: { decision: "approved" | "rejected"; revision: number },
    actor: TeamActorCapabilities
  ) {
    return this.leaveRequestView(
      await this.domain.decideLeave(
        this.businessId,
        teamId,
        requestId,
        input.decision,
        input.revision,
        actor
      )
    );
  }

  async authorityView(teamId: string) {
    const teams = await this.domain.list(this.businessId);
    const byId = new Map(teams.map((team) => [team.id, team]));
    const target = byId.get(teamId);
    if (!target) throw new TeamServiceError("not_found", "Team was not found");
    const path: string[] = [];
    let current = target;
    for (;;) {
      path.push(current.id);
      if (!current.parentTeamId) break;
      const parent = byId.get(current.parentTeamId);
      if (!parent) throw new TeamServiceError("invalid", "Team hierarchy has a missing parent");
      current = parent;
    }
    const roles = [];
    const grants = [];
    for (const [index, sourceTeamId] of path.entries()) {
      const source = index === 0 ? "direct" : "inherited";
      const sourcePath = path.slice(0, index + 1);
      roles.push(
        ...(await this.deps.teams.listRoleAssignments(sourceTeamId, this.now())).map((assignment) =>
          roleView(assignment, source, sourcePath)
        )
      );
      grants.push(
        ...(await this.deps.teams.listGrants(sourceTeamId, this.now())).map((grant) =>
          grantView(grant, source, sourcePath)
        )
      );
    }
    return {
      directRoles: roles.filter((role) => role.source === "direct"),
      inheritedRoles: roles.filter((role) => role.source === "inherited"),
      directGrants: grants.filter((grant) => grant.source === "direct"),
      inheritedGrants: grants.filter((grant) => grant.source === "inherited"),
    };
  }

  async assignRole(
    teamId: string,
    input: { roleId: string; expiresAt?: string },
    actor: TeamActorCapabilities
  ) {
    await this.authority.assignRole({
      businessId: this.businessId,
      teamId,
      roleId: input.roleId,
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      actor,
    });
    await this.recordChange("team.role_assigned", teamId, actor.principalId, {
      target: `role:${input.roleId}`,
    });
  }

  async revokeRole(teamId: string, roleId: string, actor: TeamActorCapabilities) {
    await this.assertDelegated(teamId, actor, { kind: "role", roleId });
    await this.deps.teams.revokeRole(teamId, roleId);
    await this.recordChange("team.role_revoked", teamId, actor.principalId, {
      target: `role:${roleId}`,
    });
  }

  async addGrant(
    teamId: string,
    input: {
      action: string;
      resourceType: string;
      effect: "allow" | "deny";
      domain?: string;
      recordSelector?: string;
      fieldSelector?: readonly string[];
      dataClass?: string;
      destination?: string;
      conditions?: Readonly<Record<string, string>>;
      expiresAt?: string;
    },
    actor: TeamActorCapabilities
  ) {
    const id = await this.authority.putGrant({
      businessId: this.businessId,
      teamId,
      grant: {
        action: input.action,
        resourceType: input.resourceType,
        effect: input.effect,
        ...(input.domain ? { domain: input.domain } : {}),
        ...(input.recordSelector ? { recordSelector: input.recordSelector } : {}),
        ...(input.fieldSelector ? { fieldSelector: input.fieldSelector } : {}),
        ...(input.dataClass ? { dataClass: input.dataClass } : {}),
        ...(input.destination ? { destination: input.destination } : {}),
        ...(input.conditions ? { conditions: input.conditions } : {}),
        ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
      },
      actor,
    });
    await this.recordChange("team.grant_added", teamId, actor.principalId, {
      target: `grant:${id}`,
      reason: `${input.effect}:${input.action}:${input.resourceType}`,
    });
    return { id };
  }

  async deleteGrant(teamId: string, grantId: string, actor: TeamActorCapabilities) {
    const grant = (await this.deps.teams.listAllGrants(teamId)).find(
      (candidate) => candidate.id === grantId
    );
    if (!grant) throw new TeamServiceError("not_found", "Team grant was not found");
    await this.assertDelegated(teamId, actor, {
      kind: "grant",
      grant: { action: grant.action, resourceType: grant.resourceType },
    });
    await this.deps.teams.deleteGrant(teamId, grantId);
    await this.recordChange("team.grant_removed", teamId, actor.principalId, {
      target: `grant:${grantId}`,
    });
  }

  async delegationPolicy(teamId: string) {
    await this.domain.read(this.businessId, teamId);
    const policy = await this.deps.teams.getDelegationPolicy(teamId);
    return {
      teamId,
      allowedRoleIds: policy?.allowedRoleIds ?? [],
      allowedGrantScopes: policy?.allowedGrantScopes ?? [],
      revision: policy?.revision ?? 0,
      updatedAt: policy?.updatedAt.toISOString() ?? null,
    };
  }

  async putDelegationPolicy(
    teamId: string,
    input: {
      allowedRoleIds: readonly string[];
      allowedGrantScopes: readonly TeamDelegationGrantScope[];
      revision: number;
    },
    actor: TeamActorCapabilities
  ) {
    if (!actor.companyAdmin) throw new TeamServiceError("forbidden", "Company admin required");
    await this.domain.read(this.businessId, teamId);
    const existing = await this.deps.teams.getDelegationPolicy(teamId);
    const expected = existing?.revision ?? 0;
    if (input.revision !== expected) {
      throw new TeamServiceError("conflict", "Team delegation policy revision conflict");
    }
    const policy: TeamDelegationPolicyRecord = {
      teamId,
      allowedRoleIds: [...new Set(input.allowedRoleIds)],
      allowedGrantScopes: input.allowedGrantScopes,
      revision: expected + 1,
      updatedAt: this.now(),
    };
    try {
      await this.deps.teams.putDelegationPolicy(policy);
    } catch (error) {
      if (error instanceof TeamDelegationPolicyRevisionConflictError) {
        throw new TeamServiceError("conflict", error.message);
      }
      throw error;
    }
    await this.recordChange("team.delegation_updated", teamId, actor.principalId, {
      target: `team:${teamId}`,
    });
    return this.delegationPolicy(teamId);
  }

  async previewMove(teamId: string, parentTeamId: string, revision: number) {
    const now = this.now();
    const [authorityRevision, bindingEvidenceDigest] = await Promise.all([
      this.deps.teams.getAuthorityRevision(this.businessId),
      this.deps.teams.getMoveBindingEvidenceDigest(this.businessId),
    ]);
    const snapshot = await this.moveSnapshot(now);
    const team = snapshot.teams.find((candidate) => candidate.id === teamId);
    const parent = snapshot.teams.find((candidate) => candidate.id === parentTeamId);
    if (!team || !parent) throw new TeamServiceError("not_found", "Team or parent was not found");
    if (team.revision !== revision)
      throw new TeamServiceError("conflict", "Team revision conflict");

    let impact: TeamMoveImpact;
    try {
      impact = analyzeTeamMove(snapshot, teamId, parentTeamId, now);
    } catch (error) {
      throw new TeamServiceError("invalid", error instanceof Error ? error.message : String(error));
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    try {
      await this.deps.teams.createMovePreview({
        tokenDigest: canonicalHash(token),
        businessId: this.businessId,
        teamId,
        proposedParentTeamId: parentTeamId,
        teamRevision: team.revision,
        parentRevision: parent.revision,
        authorityRevision,
        bindingEvidenceDigest,
        impactDigest: impact.evidenceDigest,
        createdAt: now,
        expiresAt,
      });
    } catch (error) {
      throw new TeamServiceError(
        "conflict",
        error instanceof Error ? error.message : String(error)
      );
    }
    return {
      ...impact,
      previewToken: token,
      previewExpiresAt: expiresAt.toISOString(),
    };
  }

  async move(
    teamId: string,
    input: { parentTeamId: string; previewToken: string },
    actor: TeamActorCapabilities
  ) {
    if (!actor.companyAdmin) {
      throw new TeamServiceError("forbidden", "Company admin capability is required");
    }
    const now = this.now();
    const bindingEvidenceDigest = await this.deps.teams.getMoveBindingEvidenceDigest(
      this.businessId
    );
    const snapshot = await this.moveSnapshot(now);
    let impact: TeamMoveImpact;
    try {
      impact = analyzeTeamMove(snapshot, teamId, input.parentTeamId, now);
    } catch (error) {
      throw new TeamServiceError(
        "conflict",
        error instanceof Error ? error.message : String(error)
      );
    }
    let moved: Awaited<ReturnType<TeamRepo["confirmMove"]>>;
    try {
      moved = await this.deps.teams.confirmMove({
        tokenDigest: canonicalHash(input.previewToken),
        businessId: this.businessId,
        teamId,
        proposedParentTeamId: input.parentTeamId,
        bindingEvidenceDigest,
        impactDigest: impact.evidenceDigest,
        now,
      });
    } catch (error) {
      throw new TeamServiceError(
        "conflict",
        error instanceof Error ? error.message : String(error)
      );
    }
    const previousParentTeamId = impact.currentAncestorTeamIds[0];
    if (!previousParentTeamId) {
      throw new TeamServiceError("protected", "Everyone is protected");
    }
    const affectedPrincipalIds = impact.accessChanges.map((change) => change.principalId);
    await this.recordFact({
      action: "team.moved",
      businessId: this.businessId,
      teamId,
      actorPrincipalId: actor.principalId,
      occurredAt: now,
      hierarchyChange: {
        previousParentTeamId,
        proposedParentTeamId: input.parentTeamId,
        affectedPrincipalIds,
        descendantTeamIds: impact.descendantTeamIds,
        gainedAncestorTeamIds: impact.gainedAncestorTeamIds,
        lostAncestorTeamIds: impact.lostAncestorTeamIds,
        impactDigest: impact.evidenceDigest,
      },
    });
    await this.deps.moveNotifications?.emitHierarchyChange({
      businessId: this.businessId,
      teamId,
      previousParentTeamId,
      proposedParentTeamId: input.parentTeamId,
      affectedPrincipalIds,
      descendantTeamIds: impact.descendantTeamIds,
      gainedAncestorTeamIds: impact.gainedAncestorTeamIds,
      lostAncestorTeamIds: impact.lostAncestorTeamIds,
      accessChanges: impact.accessChanges,
      impactDigest: impact.evidenceDigest,
      occurredAt: now,
    });
    await this.deps.notifications?.hierarchyChanged({
      businessId: this.businessId,
      teamId,
      recipients: impact.identities.map((identity) => ({
        principalId: identity.principalId,
        principalKind: identity.principalKind,
        changed: impact.accessChanges.some((change) => change.principalId === identity.principalId),
      })),
      impactDigest: impact.evidenceDigest,
      occurredAt: now,
    });
    return teamView(moved);
  }

  async archive(teamId: string, revision: number, actor: TeamActorCapabilities) {
    return teamView(await this.domain.archive(this.businessId, teamId, revision, actor));
  }

  async delete(teamId: string, revision: number, actor: TeamActorCapabilities) {
    await this.domain.delete(this.businessId, teamId, revision, actor);
  }

  async activity(teamId: string, query: TeamActivityQuery) {
    await this.domain.read(this.businessId, teamId);
    if (!this.deps.activity) return { items: [], nextCursor: null };
    const page = await this.deps.activity.list({
      limit: Math.min(query.limit, 200),
      category: "team",
      targetId: teamId,
      ...(query.action ? { action: query.action } : {}),
    });
    return {
      items: page.items.map((item) => ({
        id: item._id,
        action: item.action,
        actorId: item.actorId,
        targetId: item.targetId,
        summary: item.summary,
        target: String(item.metadata.target ?? item.targetId ?? ""),
        reason: typeof item.metadata.reason === "string" ? item.metadata.reason : null,
        outcome: item.status === "ok" ? "succeeded" : "failed",
        emergency: item.metadata.emergency === true,
        metadata: item.metadata,
        createdAt: item.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  explain(input: ExplainInput) {
    return this.deps.explanations.explain(input);
  }

  async legacyTeamId(groupId: string): Promise<string | undefined> {
    return (
      (await this.deps.teams.resolveLegacyGroupId(this.businessId, groupId)) ??
      (await this.deps.teams.getTeamBySlug(this.businessId, groupId))?.id
    );
  }

  async putLegacyMapping(groupId: string, teamId: string): Promise<void> {
    await this.deps.teams.putLegacyGroupMapping(this.businessId, groupId, teamId);
  }

  async everyoneId(): Promise<string> {
    return (await this.deps.teams.ensureEveryone(this.businessId)).id;
  }

  private async moveSnapshot(now: Date) {
    const teams = await this.domain.list(this.businessId);
    const [membershipsByTeam, rolesByTeam, grantsByTeam, assets] = await Promise.all([
      Promise.all(teams.map((team) => this.deps.teams.listAllMemberships(team.id))),
      Promise.all(teams.map((team) => this.deps.teams.listRoleAssignments(team.id, now))),
      Promise.all(teams.map((team) => this.deps.teams.listGrants(team.id, now))),
      this.moveAssets.listTeamAssetLinks(
        this.businessId,
        teams.map((team) => team.id)
      ),
    ]);
    return {
      teams,
      memberships: membershipsByTeam.flat(),
      roles: rolesByTeam.flat(),
      grants: grantsByTeam.flat(),
      assets,
    };
  }

  private async assertDelegated(
    teamId: string,
    actor: TeamActorCapabilities,
    assignment:
      | { readonly kind: "role"; readonly roleId: string }
      | {
          readonly kind: "grant";
          readonly grant: { readonly action: string; readonly resourceType: string };
        }
  ): Promise<void> {
    const decision = await decideTeamDelegation(this.deps.teams, {
      teamId,
      administeredTeamIds: actor.administeredTeamIds,
      companyAdmin: actor.companyAdmin,
      assignment,
    });
    if (!decision.allowed) {
      throw new TeamAuthorityAssignmentError("not_delegated", decision.reason);
    }
  }

  private leaveRequestView(request: {
    id: string;
    teamId: string;
    principalId: string;
    status: "pending" | "approved" | "rejected";
    revision: number;
    requestedAt: Date;
    decidedAt?: Date;
    decidedByPrincipalId?: string;
  }) {
    return {
      id: request.id,
      teamId: request.teamId,
      principalId: request.principalId,
      status: request.status,
      revision: request.revision,
      requestedAt: request.requestedAt.toISOString(),
      decidedAt: iso(request.decidedAt),
      decidedByPrincipalId: request.decidedByPrincipalId ?? null,
    };
  }

  private async recordFact(fact: TeamFact): Promise<void> {
    await this.recordChange(fact.action, fact.teamId, fact.actorPrincipalId, {
      target: fact.subjectPrincipalId
        ? `principal:${fact.subjectPrincipalId}`
        : `team:${fact.teamId}`,
      metadata: {
        ...(fact.subjectPrincipalId ? { subjectPrincipalId: fact.subjectPrincipalId } : {}),
        ...(fact.hierarchyChange ? { hierarchyChange: fact.hierarchyChange } : {}),
      },
    });
  }

  private async recordChange(
    action: string,
    teamId: string,
    actorPrincipalId: string,
    detail: {
      readonly target: string;
      readonly reason?: string;
      readonly outcome?: "succeeded" | "failed";
      readonly emergency?: boolean;
      readonly metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const outcome = detail.outcome ?? "succeeded";
    const metadata = {
      target: detail.target,
      ...(detail.reason ? { reason: detail.reason } : {}),
      ...(detail.emergency ? { emergency: true } : {}),
      ...detail.metadata,
    };
    await this.deps.activity?.record({
      category: "team",
      action,
      actorId: actorPrincipalId,
      targetType: "team",
      targetId: teamId,
      summary: action.replaceAll(".", " ").replaceAll("_", " "),
      status: outcome === "succeeded" ? "ok" : "error",
      metadata,
    });
    await this.deps.audit?.recordOrWarn({
      actorId: actorPrincipalId,
      action,
      target: `team:${teamId}`,
      decision: outcome === "succeeded" ? "allow" : "deny",
      reasonCodes: detail.reason ? [detail.reason] : [],
      safeMetadata: metadata,
    });
  }
}

export { TeamAuthorityAssignmentError, TeamServiceError };
