import {
  type AccessGrant,
  type AuthorityEvidence,
  type AuthorityLayer,
  assertPrincipalAuthenticatable,
  assertRoleAssignable,
  collectRoleGrantEntries,
  type Principal,
  type Role,
  resolveTeamAuthority,
} from "@tulipfarm/authz";
import type { TransactionPort } from "@tulipfarm/storage";
import {
  type GrantRecord,
  type GroupRepo,
  PgPrincipalRepo,
  PgRoleRepo,
  PgTeamRepo,
  type PrincipalRecord,
  type PrincipalRepo,
  type RoleRecord,
  type RoleRepo,
  type TeamRepo,
} from "@tulipfarm/storage";
import type { AuthorityPrincipal } from "./principal";

export interface AuthorityLayerResolverOptions {
  readonly principals: PrincipalRepo;
  readonly roles: RoleRepo;
  /** Pre-Team compatibility only; ignored whenever the Team repo is present. */
  readonly groups?: GroupRepo;
  /** Optional Team expansion fails closed: without it, Team-held authority grants nothing. */
  readonly teams?: TeamRepo;
  now?(): Date;
}

/** The durable repos the resolver reads. Split out so a subclass can be built from them too. */
export function authorityLayerRepos(
  transactions: TransactionPort,
  options: { now?: () => Date } = {}
): AuthorityLayerResolverOptions {
  return {
    principals: new PgPrincipalRepo(transactions),
    roles: new PgRoleRepo(transactions),
    teams: new PgTeamRepo(transactions),
    ...options,
  };
}

export function buildLiveAuthorityLayerResolver(
  transactions: TransactionPort,
  options: { now?: () => Date } = {}
): LiveAuthorityLayerResolver {
  return new LiveAuthorityLayerResolver(authorityLayerRepos(transactions, options));
}

function grantFromRecord(grant: GrantRecord): AccessGrant {
  return {
    action: grant.action,
    resourceType: grant.resourceType,
    ...(grant.domain === undefined ? {} : { domain: grant.domain }),
    ...(grant.recordSelector === undefined ? {} : { recordSelector: grant.recordSelector }),
    ...(grant.fieldSelector === undefined ? {} : { fieldSelector: grant.fieldSelector }),
    ...(grant.dataClass === undefined ? {} : { dataClass: grant.dataClass }),
    ...(grant.destination === undefined ? {} : { destination: grant.destination }),
    ...(grant.conditions === undefined ? {} : { conditions: grant.conditions }),
    effect: grant.effect,
    ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
  };
}

function roleFromRecord(role: RoleRecord): Role {
  return {
    id: role.id,
    businessId: role.businessId,
    assignableTo: role.assignableTo,
    parentRoleIds: role.parentRoleIds,
    grants: role.grants.map(grantFromRecord),
    ...(role.expiresAt === undefined ? {} : { expiresAt: role.expiresAt }),
  };
}

function principalFromRecord(record: PrincipalRecord): Principal {
  return {
    id: record.id,
    businessId: record.businessId,
    kind: record.kind,
    status: record.status,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

/** Empty-layer reasons expose faults, especially missing or unassignable Roles. */
export type LayerEmptyReason =
  | "no-such-principal"
  | "not-authenticatable"
  | "assignment-read-failed"
  | "no-roles-assigned"
  | "roles-grant-nothing"
  | "unknown-role"
  | "role-not-assignable"
  | "grant-collection-failed";

export interface DiagnosedAuthorityLayer {
  readonly layer: AuthorityLayer;
  readonly emptyReason?: LayerEmptyReason;
  readonly unresolvedRoleIds?: readonly string[];
  readonly evidence?: readonly AuthorityEvidence[];
}

function emptyLayer(name: string): AuthorityLayer {
  return { name, grants: [] };
}

function emptyDiagnosis(name: string, reason: LayerEmptyReason): DiagnosedAuthorityLayer {
  return { layer: emptyLayer(name), emptyReason: reason };
}

function uniqueGrants(grants: readonly AccessGrant[]): AccessGrant[] {
  const unique = new Map<string, AccessGrant>();
  for (const grant of grants) unique.set(JSON.stringify(grant), grant);
  return [...unique.values()];
}

export function agentAuthorityPrincipal(businessId: string, agentId: string): AuthorityPrincipal {
  return { id: agentId, businessId, kind: "agent" };
}

/**
 * Every Role a Principal holds right now: direct assignments plus Roles held through a Team,
 * with anything expired left out. Supplying a Team repo cuts compatibility-group reads off.
 *
 * Exported because a second caller needs the same answer — File sharing resolves a Role share
 * against the reader's live Roles — and two implementations of "which Roles does this person hold"
 * is exactly how a File stays readable to someone a Role no longer contains.
 */
export async function collectHeldRoleIds(
  repos: Pick<AuthorityLayerResolverOptions, "principals" | "roles" | "groups" | "teams">,
  businessId: string,
  principalId: string,
  now: Date
): Promise<string[]> {
  const roleIds = new Set<string>();
  const directAssignments = await repos.roles.listAssignments(businessId, principalId, now);
  for (const assignment of directAssignments) roleIds.add(assignment.roleId);

  if (repos.teams !== undefined) {
    const principal = await repos.principals.get(businessId, principalId);
    if (principal === undefined) return [...roleIds];
    const roles = (await repos.roles.listRoles(businessId)).map(roleFromRecord);
    const resolved = await resolveTeamAuthority(
      repos.teams,
      new Map(roles.map((role) => [role.id, role])),
      principal,
      now
    );
    for (const evidence of resolved.evidence) {
      if (evidence.kind === "role" && evidence.roleId !== undefined) {
        roleIds.add(evidence.roleId);
      }
    }
    return [...roleIds];
  }

  const groupRepo = repos.groups;
  if (groupRepo !== undefined) {
    const memberships = await groupRepo.listMemberships(businessId, principalId, now);
    for (const membership of memberships) {
      const group = await groupRepo.getGroup(businessId, membership.groupId);
      // A missing group, or one that has itself expired, grants nothing even if the membership
      // row survives — `listMemberships` only checks the membership's own expiry.
      if (group === undefined || (group.expiresAt !== undefined && group.expiresAt <= now)) {
        continue;
      }
      const held = await groupRepo.listGroupRoles(businessId, membership.groupId, now);
      for (const holding of held) roleIds.add(holding.roleId);
    }
  }

  return [...roleIds];
}

/** Resolve durable principal and role rows only; Soul compilation stays on the shared path. */
export class LiveAuthorityLayerResolver {
  private readonly now: () => Date;

  constructor(protected readonly options: AuthorityLayerResolverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async resolvePrincipalLayer(
    name: string,
    principal: AuthorityPrincipal
  ): Promise<AuthorityLayer> {
    return (await this.diagnosePrincipalLayer(name, principal)).layer;
  }

  /** Diagnostic resolution keeps empty-layer reasons without changing gate layers. */
  async diagnosePrincipalLayer(
    name: string,
    principal: AuthorityPrincipal
  ): Promise<DiagnosedAuthorityLayer> {
    const now = this.now();
    const durablePrincipal = await this.options.principals.get(principal.businessId, principal.id);
    if (
      durablePrincipal === undefined ||
      durablePrincipal.businessId !== principal.businessId ||
      durablePrincipal.kind !== principal.kind
    ) {
      return emptyDiagnosis(name, "no-such-principal");
    }

    const authzPrincipal = principalFromRecord(durablePrincipal);
    try {
      assertPrincipalAuthenticatable(authzPrincipal, now);
    } catch {
      return emptyDiagnosis(name, "not-authenticatable");
    }

    let assignedRoleIds: string[];
    let directAssignments: Awaited<ReturnType<RoleRepo["listAllAssignments"]>>;
    let teamAuthority: Awaited<ReturnType<typeof resolveTeamAuthority>> | undefined;
    try {
      [assignedRoleIds, directAssignments] = await Promise.all([
        this.collectAssignedRoleIds(principal, now),
        this.options.roles.listAllAssignments(principal.businessId, principal.id),
      ]);
      if (this.options.teams !== undefined) {
        const roles = (await this.options.roles.listRoles(principal.businessId)).map(
          roleFromRecord
        );
        teamAuthority = await resolveTeamAuthority(
          this.options.teams,
          new Map(roles.map((role) => [role.id, role])),
          principal,
          now
        );
      }
    } catch {
      // A membership or assignment read that throws must never widen a layer — fail closed.
      return emptyDiagnosis(name, "assignment-read-failed");
    }
    if (
      assignedRoleIds.length === 0 &&
      (teamAuthority?.grants.length ?? 0) === 0 &&
      (teamAuthority?.unresolvedRoleIds.length ?? 0) === 0 &&
      (teamAuthority?.unassignableRoleIds.length ?? 0) === 0
    ) {
      const diagnosis = emptyDiagnosis(name, "no-roles-assigned");
      const expiryEvidence: AuthorityEvidence[] = directAssignments
        .filter((assignment) => assignment.expiresAt && assignment.expiresAt <= now)
        .map((assignment) => ({
          kind: "expiry",
          effect: "informational",
          sourcePrincipalId: principal.id,
          roleId: assignment.roleId,
          expiresAt: assignment.expiresAt,
        }));
      const evidence = [...expiryEvidence, ...(teamAuthority?.evidence ?? [])];
      return evidence.length ? { ...diagnosis, evidence } : diagnosis;
    }

    const roles = (await this.options.roles.listRoles(principal.businessId)).map(roleFromRecord);
    const rolesById = new Map(roles.map((role) => [role.id, role]));
    for (const roleId of assignedRoleIds) {
      const assignedRole = rolesById.get(roleId);
      if (assignedRole === undefined) {
        return {
          layer: emptyLayer(name),
          emptyReason: "unknown-role",
          unresolvedRoleIds: [roleId],
        };
      }
      try {
        // A group-held Role obeys the same assignability rule a direct assignment does, so a group
        // cannot escalate a principal past a Role it could not have been assigned directly.
        assertRoleAssignable(assignedRole, authzPrincipal, now);
      } catch {
        return {
          layer: emptyLayer(name),
          emptyReason: "role-not-assignable",
          unresolvedRoleIds: [roleId],
        };
      }
    }

    try {
      const directEntries = collectRoleGrantEntries(assignedRoleIds, rolesById, now);
      const directAssignmentsByRole = new Map(
        directAssignments
          .filter((assignment) => !assignment.expiresAt || assignment.expiresAt > now)
          .map((assignment) => [assignment.roleId, assignment])
      );
      const evidence: AuthorityEvidence[] = [
        ...directEntries.flatMap((entry) => {
          const assignment = directAssignmentsByRole.get(entry.roleId);
          if (!assignment) return [];
          return [
            {
              kind: "role" as const,
              effect: "informational" as const,
              sourcePrincipalId: principal.id,
              roleId: entry.roleId,
              ...(assignment.expiresAt ? { expiresAt: assignment.expiresAt } : {}),
            },
            {
              kind: entry.grant.effect === "deny" ? ("explicit_deny" as const) : ("grant" as const),
              effect: entry.grant.effect,
              sourcePrincipalId: principal.id,
              roleId: entry.roleId,
              grantId: `${entry.roleId}:${entry.grantIndex}`,
              ...(entry.grant.expiresAt ? { expiresAt: entry.grant.expiresAt } : {}),
            },
          ];
        }),
        ...directAssignments
          .filter((assignment) => assignment.expiresAt && assignment.expiresAt <= now)
          .map(
            (assignment): AuthorityEvidence => ({
              kind: "expiry",
              effect: "informational",
              sourcePrincipalId: principal.id,
              roleId: assignment.roleId,
              expiresAt: assignment.expiresAt,
            })
          ),
        ...(teamAuthority?.evidence ?? []),
      ];
      const grants = uniqueGrants([
        ...directEntries.map((entry) => entry.grant),
        ...(teamAuthority?.grants ?? []),
      ]);
      const unresolvedRoleIds = teamAuthority?.unresolvedRoleIds ?? [];
      if (unresolvedRoleIds.length > 0) {
        return {
          layer: emptyLayer(name),
          emptyReason: "unknown-role",
          unresolvedRoleIds,
          evidence,
        };
      }
      const unassignableRoleIds = teamAuthority?.unassignableRoleIds ?? [];
      if (unassignableRoleIds.length > 0) {
        return {
          layer: emptyLayer(name),
          emptyReason: "role-not-assignable",
          unresolvedRoleIds: unassignableRoleIds,
          evidence,
        };
      }
      return grants.length === 0
        ? { ...emptyDiagnosis(name, "roles-grant-nothing"), evidence }
        : { layer: { name, grants }, evidence };
    } catch {
      return emptyDiagnosis(name, "grant-collection-failed");
    }
  }

  /**
   * Effective Roles are direct plus unexpired group-derived holdings; ambiguous edges grant
   * nothing.
   */
  private async collectAssignedRoleIds(
    principal: AuthorityPrincipal,
    now: Date
  ): Promise<string[]> {
    if (this.options.teams !== undefined) {
      const assignments = await this.options.roles.listAssignments(
        principal.businessId,
        principal.id,
        now
      );
      return assignments.map((assignment) => assignment.roleId);
    }
    return await collectHeldRoleIds(this.options, principal.businessId, principal.id, now);
  }

  resolveAgentLayer(businessId: string, agentId: string): Promise<AuthorityLayer> {
    return this.resolvePrincipalLayer("agent", agentAuthorityPrincipal(businessId, agentId));
  }
}
