import { randomUUID } from "node:crypto";
import type {
  TeamLifecycleStatus,
  TeamMemberPrincipalKind,
  TeamMembershipLevel,
} from "@tulipfarm/schema";
import type { Principal } from "./principals";

export interface TeamRecord {
  readonly id: string;
  readonly businessId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly parentTeamId?: string;
  readonly status: TeamLifecycleStatus;
  readonly protected: boolean;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt?: Date;
}

export interface TeamMembershipRecord {
  readonly teamId: string;
  readonly principalId: string;
  readonly principalKind: TeamMemberPrincipalKind;
  readonly level: TeamMembershipLevel;
  readonly expiresAt?: Date;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type TeamLeaveRequestStatus = "pending" | "approved" | "rejected";

export interface TeamLeaveRequestRecord {
  readonly id: string;
  readonly teamId: string;
  readonly principalId: string;
  readonly status: TeamLeaveRequestStatus;
  readonly revision: number;
  readonly requestedAt: Date;
  readonly decidedAt?: Date;
  readonly decidedByPrincipalId?: string;
}

export interface TeamRepoPort {
  ensureEveryone(businessId: string): Promise<TeamRecord>;
  getTeam(businessId: string, teamId: string): Promise<TeamRecord | undefined>;
  getTeamBySlug(businessId: string, slug: string): Promise<TeamRecord | undefined>;
  listTeams(businessId: string): Promise<TeamRecord[]>;
  createTeam(record: TeamRecord, memberships: readonly TeamMembershipRecord[]): Promise<void>;
  putTeam(record: TeamRecord): Promise<void>;
  deleteTeam(businessId: string, teamId: string): Promise<void>;
  putMembership(record: TeamMembershipRecord): Promise<void>;
  removeMembership(teamId: string, principalId: string, expectedRevision: number): Promise<void>;
  getMembership(teamId: string, principalId: string): Promise<TeamMembershipRecord | undefined>;
  listMemberships(teamId: string, now: Date): Promise<TeamMembershipRecord[]>;
  listAllMemberships(teamId: string): Promise<TeamMembershipRecord[]>;
  listPrincipalMemberships?(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<TeamMembershipRecord[]>;
  listAllRoleAssignments(teamId: string): Promise<readonly unknown[]>;
  listAllGrants(teamId: string): Promise<readonly unknown[]>;
  getDelegationPolicy(teamId: string): Promise<unknown>;
  putLeaveRequest(record: TeamLeaveRequestRecord): Promise<void>;
  getLeaveRequest(teamId: string, requestId: string): Promise<TeamLeaveRequestRecord | undefined>;
  listLeaveRequests(teamId: string): Promise<TeamLeaveRequestRecord[]>;
  recoverAdmin(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly principalId: string;
    readonly teamRevision: number;
    readonly now: Date;
  }): Promise<TeamMembershipRecord>;
  transitionLifecycle(input: {
    readonly businessId: string;
    readonly teamId: string;
    readonly action: "archive" | "delete";
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<
    | { readonly ok: true; readonly team?: TeamRecord }
    | {
        readonly ok: false;
        readonly reason: TeamServiceErrorReason;
        readonly message: string;
      }
  >;
}

export interface TeamPrincipalPort {
  get(businessId: string, principalId: string): Promise<Principal | undefined>;
}

export interface TeamActorCapabilities {
  readonly principalId: string;
  readonly companyAdmin: boolean;
  readonly administeredTeamIds: readonly string[];
}

export interface TeamLifecycleGuard {
  assertArchiveReady(businessId: string, teamId: string): Promise<void>;
  assertDeleteReady(businessId: string, teamId: string): Promise<void>;
}

export type TeamFactAction =
  | "team.created"
  | "team.identity_updated"
  | "team.moved"
  | "team.archived"
  | "team.deleted"
  | "team.member_added"
  | "team.membership_updated"
  | "team.member_removed"
  | "team.admin_recovered"
  | "team.leave_requested"
  | "team.leave_approved"
  | "team.leave_rejected";

export interface TeamFact {
  readonly action: TeamFactAction;
  readonly businessId: string;
  readonly teamId: string;
  readonly actorPrincipalId: string;
  readonly subjectPrincipalId?: string;
  readonly hierarchyChange?: {
    readonly previousParentTeamId: string;
    readonly proposedParentTeamId: string;
    readonly affectedPrincipalIds: readonly string[];
    readonly descendantTeamIds: readonly string[];
    readonly gainedAncestorTeamIds: readonly string[];
    readonly lostAncestorTeamIds: readonly string[];
    readonly impactDigest: string;
  };
  readonly occurredAt: Date;
}

export interface TeamFactPort {
  emit(fact: TeamFact): Promise<void>;
}

export type TeamServiceErrorReason =
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "protected"
  | "final_admin"
  | "not_empty";

export class TeamServiceError extends Error {
  constructor(
    readonly reason: TeamServiceErrorReason,
    message: string
  ) {
    super(message);
    this.name = "TeamServiceError";
  }
}

export interface TeamServiceDeps {
  readonly teams: TeamRepoPort;
  readonly principals: TeamPrincipalPort;
  readonly lifecycleGuard?: TeamLifecycleGuard;
  readonly facts: TeamFactPort;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface CreateTeamInput {
  readonly businessId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly parentTeamId: string;
  readonly initialAdminPrincipalIds: readonly string[];
  readonly actor: TeamActorCapabilities;
}

export interface UpdateTeamIdentityInput {
  readonly businessId: string;
  readonly teamId: string;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
  readonly expectedRevision: number;
  readonly actor: TeamActorCapabilities;
}

export interface AddTeamMemberInput {
  readonly businessId: string;
  readonly teamId: string;
  readonly principalId: string;
  readonly level: TeamMembershipLevel;
  readonly expiresAt?: Date;
  readonly actor: TeamActorCapabilities;
}

export interface UpdateTeamMembershipInput extends AddTeamMemberInput {
  readonly expectedRevision: number;
}

export interface ResolvedTeamMember {
  readonly membership: "direct" | "inherited";
  readonly sourceTeamId: string;
  readonly pathTeamIds: readonly string[];
  readonly principalId: string;
  readonly principalKind: TeamMemberPrincipalKind;
  readonly level: TeamMembershipLevel;
  readonly expiresAt?: Date;
  readonly removable: boolean;
  readonly revision: number;
}

const TEAM_SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function activeAt(record: { readonly expiresAt?: Date }, now: Date): boolean {
  return !record.expiresAt || record.expiresAt > now;
}

function isTeamMemberPrincipalKind(kind: Principal["kind"]): kind is TeamMemberPrincipalKind {
  return kind === "user" || kind === "agent" || kind === "service";
}

function isActivePerson(principal: Principal | undefined, now: Date): principal is Principal {
  return (
    principal?.kind === "user" &&
    principal.status === "active" &&
    (!principal.expiresAt || principal.expiresAt > now)
  );
}

export class TeamService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: TeamServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  async create(input: CreateTeamInput): Promise<TeamRecord> {
    this.assertCompanyAdmin(input.actor);
    if (!TEAM_SLUG.test(input.slug) || input.slug.length > 128 || input.slug === "everyone") {
      throw new TeamServiceError("invalid", "Team slug must be permanent lowercase kebab-case");
    }
    const displayName = this.displayName(input.displayName);
    const description = this.description(input.description);
    const labels = this.labels(input.labels);
    const initialAdminIds = [...new Set(input.initialAdminPrincipalIds)];
    if (initialAdminIds.length === 0) {
      throw new TeamServiceError("invalid", "A Team requires at least one initial human admin");
    }
    const parent = await this.activeTeam(input.businessId, input.parentTeamId);
    await this.assertDescendsFromEveryone(input.businessId, parent);
    const now = this.now();
    const admins = await Promise.all(
      initialAdminIds.map(async (principalId) => {
        const principal = await this.deps.principals.get(input.businessId, principalId);
        if (!isActivePerson(principal, now)) {
          throw new TeamServiceError("invalid", "Initial Team admins must be active people");
        }
        return principal;
      })
    );
    const team: TeamRecord = {
      id: this.newId(),
      businessId: input.businessId,
      slug: input.slug,
      displayName,
      ...(description === undefined ? {} : { description }),
      labels,
      parentTeamId: parent.id,
      status: "active",
      protected: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.createTeam(
      team,
      admins.map((admin) => ({
        teamId: team.id,
        principalId: admin.id,
        principalKind: "user",
        level: "admin",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }))
    );
    await this.emit("team.created", input, team.id);
    return team;
  }

  async read(businessId: string, teamId: string): Promise<TeamRecord> {
    return this.team(businessId, teamId);
  }

  async list(businessId: string): Promise<TeamRecord[]> {
    return this.deps.teams.listTeams(businessId);
  }

  async updateIdentity(input: UpdateTeamIdentityInput): Promise<TeamRecord> {
    const team = await this.activeTeam(input.businessId, input.teamId);
    this.assertExactTeamManager(input.actor, team);
    this.assertMutable(team);
    this.assertRevision(team.revision, input.expectedRevision);
    if (
      input.displayName === undefined &&
      input.description === undefined &&
      input.labels === undefined
    ) {
      throw new TeamServiceError("invalid", "A Team identity update must change a field");
    }
    const updated: TeamRecord = {
      ...team,
      ...(input.displayName === undefined
        ? {}
        : { displayName: this.displayName(input.displayName) }),
      ...(input.description === undefined
        ? {}
        : input.description === null
          ? { description: undefined }
          : { description: this.description(input.description) }),
      ...(input.labels === undefined ? {} : { labels: this.labels(input.labels) }),
      revision: team.revision + 1,
      updatedAt: this.now(),
    };
    await this.storeTeam(updated);
    await this.emit("team.identity_updated", input, team.id);
    return updated;
  }

  async move(
    businessId: string,
    teamId: string,
    parentTeamId: string,
    expectedRevision: number,
    actor: TeamActorCapabilities
  ): Promise<TeamRecord> {
    this.assertCompanyAdmin(actor);
    const team = await this.activeTeam(businessId, teamId);
    this.assertMutable(team);
    this.assertRevision(team.revision, expectedRevision);
    const parent = await this.activeTeam(businessId, parentTeamId);
    await this.assertDescendsFromEveryone(businessId, parent);
    const updated = {
      ...team,
      parentTeamId: parent.id,
      revision: team.revision + 1,
      updatedAt: this.now(),
    };
    await this.storeTeam(updated);
    await this.emit("team.moved", { businessId, actor }, team.id);
    return updated;
  }

  async archive(
    businessId: string,
    teamId: string,
    expectedRevision: number,
    actor: TeamActorCapabilities
  ): Promise<TeamRecord> {
    this.assertCompanyAdmin(actor);
    const result = await this.deps.teams.transitionLifecycle({
      businessId,
      teamId,
      action: "archive",
      expectedRevision,
      now: this.now(),
    });
    if (!result.ok) throw new TeamServiceError(result.reason, result.message);
    const archived = result.team;
    if (!archived) throw new Error("Team archive did not return the archived Team");
    await this.emit("team.archived", { businessId, actor }, archived.id);
    return archived;
  }

  async delete(
    businessId: string,
    teamId: string,
    expectedRevision: number,
    actor: TeamActorCapabilities
  ): Promise<void> {
    this.assertCompanyAdmin(actor);
    const result = await this.deps.teams.transitionLifecycle({
      businessId,
      teamId,
      action: "delete",
      expectedRevision,
      now: this.now(),
    });
    if (!result.ok) throw new TeamServiceError(result.reason, result.message);
    await this.emit("team.deleted", { businessId, actor }, teamId);
  }

  async addMember(input: AddTeamMemberInput): Promise<TeamMembershipRecord> {
    const team = await this.activeTeam(input.businessId, input.teamId);
    this.assertExactTeamManager(input.actor, team);
    if (await this.deps.teams.getMembership(team.id, input.principalId)) {
      throw new TeamServiceError("conflict", "The principal is already a direct Team member");
    }
    const now = this.now();
    const principal = await this.memberPrincipal(input.businessId, input.principalId, now);
    this.assertMembershipMutable(team, input.actor, principal.kind, input.level);
    this.assertMembershipLevel(principal.kind, input.level);
    this.assertFutureExpiry(input.expiresAt, now);
    const membership: TeamMembershipRecord = {
      teamId: team.id,
      principalId: principal.id,
      principalKind: principal.kind,
      level: input.level,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.storeMembership(membership);
    await this.emit("team.member_added", input, team.id, principal.id);
    return membership;
  }

  async updateMembership(input: UpdateTeamMembershipInput): Promise<TeamMembershipRecord> {
    const team = await this.activeTeam(input.businessId, input.teamId);
    this.assertExactTeamManager(input.actor, team);
    const membership = await this.membership(team.id, input.principalId);
    this.assertMembershipMutable(team, input.actor, membership.principalKind, input.level);
    this.assertRevision(membership.revision, input.expectedRevision);
    this.assertMembershipLevel(membership.principalKind, input.level);
    const now = this.now();
    this.assertFutureExpiry(input.expiresAt, now);
    if (
      membership.level === "admin" &&
      (input.level !== "admin" || (!membership.expiresAt && input.expiresAt))
    ) {
      await this.assertNotFinalAdmin(input.businessId, team.id, membership.principalId, now);
    }
    const updated = {
      ...membership,
      level: input.level,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : { expiresAt: undefined }),
      revision: membership.revision + 1,
      updatedAt: now,
    };
    await this.storeMembership(updated);
    await this.emit("team.membership_updated", input, team.id, membership.principalId);
    return updated;
  }

  async extendMembershipExpiry(
    businessId: string,
    teamId: string,
    principalId: string,
    expiresAt: Date,
    expectedRevision: number,
    actor: TeamActorCapabilities
  ): Promise<TeamMembershipRecord> {
    const membership = await this.membership(teamId, principalId);
    if (!membership.expiresAt || expiresAt <= membership.expiresAt) {
      throw new TeamServiceError(
        "invalid",
        "Extended expiry must be later than the current expiry"
      );
    }
    return this.updateMembership({
      businessId,
      teamId,
      principalId,
      level: membership.level,
      expiresAt,
      expectedRevision,
      actor,
    });
  }

  async removeMember(
    businessId: string,
    teamId: string,
    principalId: string,
    expectedRevision: number,
    actor: TeamActorCapabilities
  ): Promise<void> {
    const team = await this.team(businessId, teamId);
    if (team.status === "archived") {
      this.assertCompanyAdmin(actor);
    } else {
      this.assertExactTeamManager(actor, team);
    }
    const membership = await this.membership(team.id, principalId);
    this.assertMembershipMutable(team, actor, membership.principalKind, membership.level);
    this.assertRevision(membership.revision, expectedRevision);
    if (
      team.status === "active" &&
      membership.level === "admin" &&
      activeAt(membership, this.now())
    ) {
      await this.assertNotFinalAdmin(businessId, team.id, principalId, this.now());
    }
    await this.removeStoredMembership(team.id, principalId, membership.revision);
    await this.emit("team.member_removed", { businessId, actor }, team.id, principalId);
  }

  async recoverAdmin(
    businessId: string,
    teamId: string,
    principalId: string,
    expectedRevision: number,
    actor: TeamActorCapabilities
  ): Promise<TeamMembershipRecord> {
    this.assertCompanyAdmin(actor);
    const team = await this.activeTeam(businessId, teamId);
    this.assertMutable(team);
    this.assertRevision(team.revision, expectedRevision);
    const now = this.now();
    const existing = await this.membership(team.id, principalId);
    if (existing.principalKind !== "user" || !activeAt(existing, now)) {
      throw new TeamServiceError(
        "invalid",
        "Team admin recovery requires an active direct human member"
      );
    }
    const principal = await this.memberPrincipal(businessId, principalId, now);
    if (!isActivePerson(principal, now)) {
      throw new TeamServiceError(
        "invalid",
        "Only an active person can recover Team administration"
      );
    }
    let recovered: TeamMembershipRecord;
    try {
      recovered = await this.deps.teams.recoverAdmin({
        businessId,
        teamId,
        principalId,
        teamRevision: expectedRevision,
        now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.toLocaleLowerCase().includes("revision conflict") ||
        message.toLocaleLowerCase().includes("no active human admins") ||
        message.toLocaleLowerCase().includes("active mutable team")
      ) {
        throw new TeamServiceError("conflict", message);
      }
      if (message.toLocaleLowerCase().includes("active direct human membership")) {
        throw new TeamServiceError("invalid", message);
      }
      throw error;
    }
    await this.emit("team.admin_recovered", { businessId, actor }, team.id, principalId);
    return recovered;
  }

  async requestLeave(
    businessId: string,
    teamId: string,
    actor: TeamActorCapabilities
  ): Promise<TeamLeaveRequestRecord> {
    const team = await this.activeTeam(businessId, teamId);
    const membership = await this.membership(team.id, actor.principalId);
    if (team.protected && membership.principalKind === "user") {
      throw new TeamServiceError(
        "protected",
        "Active people cannot leave Everyone while they belong to the business"
      );
    }
    if (!activeAt(membership, this.now())) {
      throw new TeamServiceError("not_found", "Active direct Team membership was not found");
    }
    const pending = (await this.deps.teams.listLeaveRequests(team.id)).find(
      (request) => request.principalId === actor.principalId && request.status === "pending"
    );
    if (pending) throw new TeamServiceError("conflict", "A leave request is already pending");
    const request: TeamLeaveRequestRecord = {
      id: this.newId(),
      teamId: team.id,
      principalId: actor.principalId,
      status: "pending",
      revision: 1,
      requestedAt: this.now(),
    };
    await this.storeLeaveRequest(request);
    await this.emit("team.leave_requested", { businessId, actor }, team.id, actor.principalId);
    return request;
  }

  async decideLeave(
    businessId: string,
    teamId: string,
    requestId: string,
    decision: "approved" | "rejected",
    expectedRevision: number,
    actor: TeamActorCapabilities
  ): Promise<TeamLeaveRequestRecord> {
    const team = await this.activeTeam(businessId, teamId);
    this.assertExactTeamManager(actor, team);
    const request = await this.deps.teams.getLeaveRequest(team.id, requestId);
    if (!request) throw new TeamServiceError("not_found", "Team leave request was not found");
    this.assertRevision(request.revision, expectedRevision);
    if (request.status !== "pending") {
      throw new TeamServiceError("conflict", "Team leave request is already decided");
    }
    if (decision === "approved") {
      const membership = await this.membership(team.id, request.principalId);
      if (membership.level === "admin" && activeAt(membership, this.now())) {
        await this.assertNotFinalAdmin(businessId, team.id, request.principalId, this.now());
      }
      await this.removeStoredMembership(team.id, request.principalId, membership.revision);
    }
    const decided: TeamLeaveRequestRecord = {
      ...request,
      status: decision,
      revision: request.revision + 1,
      decidedAt: this.now(),
      decidedByPrincipalId: actor.principalId,
    };
    await this.storeLeaveRequest(decided);
    await this.emit(
      decision === "approved" ? "team.leave_approved" : "team.leave_rejected",
      { businessId, actor },
      team.id,
      request.principalId
    );
    return decided;
  }

  async resolveMembers(businessId: string, teamId: string): Promise<ResolvedTeamMember[]> {
    const target = await this.activeTeam(businessId, teamId);
    const teams = await this.deps.teams.listTeams(businessId);
    const byId = new Map(teams.map((team) => [team.id, team]));
    const now = this.now();
    const sources = teams.filter(
      (team) => team.status === "active" && this.pathToAncestor(team, target.id, byId) !== undefined
    );
    const resolved: ResolvedTeamMember[] = [];
    for (const source of sources) {
      const path = this.pathToAncestor(source, target.id, byId);
      if (!path) continue;
      for (const membership of await this.deps.teams.listMemberships(source.id, now)) {
        resolved.push({
          membership: source.id === target.id ? "direct" : "inherited",
          sourceTeamId: source.id,
          pathTeamIds: path,
          principalId: membership.principalId,
          principalKind: membership.principalKind,
          level: membership.level,
          ...(membership.expiresAt ? { expiresAt: membership.expiresAt } : {}),
          removable: source.id === target.id,
          revision: membership.revision,
        });
      }
    }
    return resolved.sort(
      (left, right) =>
        left.principalId.localeCompare(right.principalId) ||
        left.sourceTeamId.localeCompare(right.sourceTeamId)
    );
  }

  async resolvePrincipalForTeams(
    businessId: string,
    teamIds: readonly string[],
    principalId: string
  ): Promise<ReadonlyMap<string, readonly ResolvedTeamMember[]>> {
    const teams = await this.deps.teams.listTeams(businessId);
    const byId = new Map(teams.map((team) => [team.id, team]));
    const targets = new Set(teamIds);
    if (this.deps.teams.listPrincipalMemberships === undefined) {
      return new Map(
        await Promise.all(
          [...targets].map(
            async (teamId) =>
              [
                teamId,
                (await this.resolveMembers(businessId, teamId)).filter(
                  (member) => member.principalId === principalId
                ),
              ] as const
          )
        )
      );
    }
    const memberships = await this.deps.teams.listPrincipalMemberships(
      businessId,
      principalId,
      this.now()
    );
    const resolved = new Map<string, ResolvedTeamMember[]>(
      [...targets].map((teamId) => [teamId, []])
    );
    for (const membership of memberships) {
      const source = byId.get(membership.teamId);
      if (source?.status !== "active") continue;
      for (const targetTeamId of targets) {
        const target = byId.get(targetTeamId);
        if (target?.status !== "active") continue;
        const path = this.pathToAncestor(source, targetTeamId, byId);
        if (!path) continue;
        resolved.get(targetTeamId)?.push({
          membership: source.id === targetTeamId ? "direct" : "inherited",
          sourceTeamId: source.id,
          pathTeamIds: path,
          principalId: membership.principalId,
          principalKind: membership.principalKind,
          level: membership.level,
          ...(membership.expiresAt ? { expiresAt: membership.expiresAt } : {}),
          removable: source.id === targetTeamId,
          revision: membership.revision,
        });
      }
    }
    return resolved;
  }

  private async team(businessId: string, teamId: string): Promise<TeamRecord> {
    const team = await this.deps.teams.getTeam(businessId, teamId);
    if (!team) throw new TeamServiceError("not_found", "Team was not found");
    return team;
  }

  private async activeTeam(businessId: string, teamId: string): Promise<TeamRecord> {
    const team = await this.team(businessId, teamId);
    if (team.status !== "active") throw new TeamServiceError("invalid", "Team is archived");
    return team;
  }

  private async membership(teamId: string, principalId: string): Promise<TeamMembershipRecord> {
    const membership = await this.deps.teams.getMembership(teamId, principalId);
    if (!membership)
      throw new TeamServiceError("not_found", "Direct Team membership was not found");
    return membership;
  }

  private async memberPrincipal(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<Principal & { readonly kind: TeamMemberPrincipalKind }> {
    const principal = await this.deps.principals.get(businessId, principalId);
    if (
      principal?.status !== "active" ||
      (principal.expiresAt && principal.expiresAt <= now) ||
      !isTeamMemberPrincipalKind(principal.kind)
    ) {
      throw new TeamServiceError(
        "invalid",
        "Team members must be active people, Agents, or service accounts"
      );
    }
    return { ...principal, kind: principal.kind };
  }

  private async assertDescendsFromEveryone(businessId: string, team: TeamRecord): Promise<void> {
    const everyone = await this.deps.teams.ensureEveryone(businessId);
    const teams = await this.deps.teams.listTeams(businessId);
    const path = this.pathToAncestor(
      team,
      everyone.id,
      new Map(teams.map((item) => [item.id, item]))
    );
    if (!path) throw new TeamServiceError("invalid", "Parent Team must descend from Everyone");
  }

  private pathToAncestor(
    team: TeamRecord,
    ancestorId: string,
    byId: ReadonlyMap<string, TeamRecord>
  ): string[] | undefined {
    const path = [team.id];
    let current = team;
    while (current.id !== ancestorId) {
      if (!current.parentTeamId) return undefined;
      const parent = byId.get(current.parentTeamId);
      if (!parent || path.includes(parent.id)) return undefined;
      path.push(parent.id);
      current = parent;
    }
    return path;
  }

  private async activeAdmins(
    businessId: string,
    teamId: string,
    now: Date
  ): Promise<TeamMembershipRecord[]> {
    const admins = (await this.deps.teams.listMemberships(teamId, now)).filter(
      (membership) => membership.level === "admin" && membership.principalKind === "user"
    );
    const active = await Promise.all(
      admins.map(async (membership) => ({
        membership,
        principal: await this.deps.principals.get(businessId, membership.principalId),
      }))
    );
    return active
      .filter(({ principal }) => isActivePerson(principal, now))
      .map(({ membership }) => membership);
  }

  private async storeTeam(team: TeamRecord): Promise<void> {
    try {
      await this.deps.teams.putTeam(team);
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  private async createTeam(
    team: TeamRecord,
    memberships: readonly TeamMembershipRecord[]
  ): Promise<void> {
    try {
      await this.deps.teams.createTeam(team, memberships);
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  private async storeMembership(membership: TeamMembershipRecord): Promise<void> {
    try {
      await this.deps.teams.putMembership(membership);
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  private async removeStoredMembership(
    teamId: string,
    principalId: string,
    expectedRevision: number
  ): Promise<void> {
    try {
      await this.deps.teams.removeMembership(teamId, principalId, expectedRevision);
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  private async storeLeaveRequest(request: TeamLeaveRequestRecord): Promise<void> {
    try {
      await this.deps.teams.putLeaveRequest(request);
    } catch (error) {
      this.rethrowConflict(error);
    }
  }

  private rethrowConflict(error: unknown): never {
    if (error instanceof Error && error.message.toLocaleLowerCase().includes("revision conflict")) {
      throw new TeamServiceError("conflict", error.message);
    }
    throw error;
  }

  private async assertNotFinalAdmin(
    businessId: string,
    teamId: string,
    principalId: string,
    now: Date
  ): Promise<void> {
    const admins = await this.activeAdmins(businessId, teamId, now);
    if (admins.length === 1 && admins[0]?.principalId === principalId) {
      throw new TeamServiceError(
        "final_admin",
        "The final Team admin cannot be removed or demoted"
      );
    }
  }

  private assertCompanyAdmin(actor: TeamActorCapabilities): void {
    if (!actor.companyAdmin) {
      throw new TeamServiceError("forbidden", "Company admin capability is required");
    }
  }

  private assertExactTeamManager(actor: TeamActorCapabilities, team: TeamRecord): void {
    if (!actor.companyAdmin && !actor.administeredTeamIds.includes(team.id)) {
      throw new TeamServiceError("forbidden", "Exact-Team admin capability is required");
    }
  }

  private assertMutable(team: TeamRecord): void {
    if (team.protected) throw new TeamServiceError("protected", "Everyone is protected");
  }

  private assertMembershipMutable(
    team: TeamRecord,
    actor: TeamActorCapabilities,
    principalKind: TeamMemberPrincipalKind,
    level: TeamMembershipLevel
  ): void {
    if (!team.protected) return;
    if (actor.companyAdmin && principalKind !== "user" && level === "member") {
      return;
    }
    throw new TeamServiceError(
      "protected",
      "Everyone people membership is maintained by principal synchronization; non-human membership requires a company admin"
    );
  }

  private assertMembershipLevel(
    principalKind: TeamMemberPrincipalKind,
    level: TeamMembershipLevel
  ): void {
    if (level === "admin" && principalKind !== "user") {
      throw new TeamServiceError("invalid", "Only people may be Team admins");
    }
  }

  private assertFutureExpiry(expiresAt: Date | undefined, now: Date): void {
    if (expiresAt && expiresAt <= now) {
      throw new TeamServiceError("invalid", "Team membership expiry must be in the future");
    }
  }

  private assertRevision(actual: number, expected: number): void {
    if (actual !== expected) throw new TeamServiceError("conflict", "Team revision conflict");
  }

  private displayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 256) {
      throw new TeamServiceError("invalid", "Team display name must be 1 to 256 characters");
    }
    return normalized;
  }

  private description(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const normalized = value.trim();
    if (normalized.length > 2000) {
      throw new TeamServiceError("invalid", "Team description cannot exceed 2000 characters");
    }
    return normalized || undefined;
  }

  private labels(values: readonly string[] | undefined): readonly string[] {
    if (!values) return [];
    const labels = values.map((label) => label.trim().toLocaleLowerCase()).filter(Boolean);
    const unique = [...new Set(labels)];
    if (unique.length > 12 || unique.some((label) => label.length > 40)) {
      throw new TeamServiceError(
        "invalid",
        "A Team may have up to 12 labels of 40 characters each"
      );
    }
    return unique;
  }

  private async emit(
    action: TeamFactAction,
    input: { readonly businessId: string; readonly actor: TeamActorCapabilities },
    teamId: string,
    subjectPrincipalId?: string
  ): Promise<void> {
    await this.deps.facts.emit({
      action,
      businessId: input.businessId,
      teamId,
      actorPrincipalId: input.actor.principalId,
      ...(subjectPrincipalId ? { subjectPrincipalId } : {}),
      occurredAt: this.now(),
    });
  }
}
