import {
  type AccessGrant,
  type AuthorityLayer,
  assertPrincipalAuthenticatable,
  assertRoleAssignable,
  collectRoleGrants,
  type Principal,
  type PrincipalKind,
  type Role,
} from "@tulipfarm/authz";
import {
  type GrantRecord,
  type GroupRepo,
  PgGroupRepo,
  PgPrincipalRepo,
  PgRoleRepo,
  type PrincipalRecord,
  type PrincipalRepo,
  type RoleRecord,
  type RoleRepo,
} from "@tulipfarm/storage";
import { type Queryable, transactionPort } from "../db";
import type { RequestPrincipal } from "./principal";

export interface AuthorityPrincipal {
  readonly id: string;
  readonly businessId: string;
  readonly kind: PrincipalKind;
}

export interface AuthorityLayerResolverOptions {
  readonly principals: PrincipalRepo;
  readonly roles: RoleRepo;
  /**
   * Optional. When present, a principal's grants include the Roles held by every unexpired group
   * it belongs to. When absent, group-held Roles contribute nothing — fail closed: a resolver
   * without a group repo can only ever grant less, never more.
   */
  readonly groups?: GroupRepo;
  now?(): Date;
}

export function buildLiveAuthorityLayerResolver(
  database: Queryable,
  options: { now?: () => Date } = {}
): LiveAuthorityLayerResolver {
  const transactions = transactionPort(database);
  return new LiveAuthorityLayerResolver({
    principals: new PgPrincipalRepo(transactions),
    roles: new PgRoleRepo(transactions),
    groups: new PgGroupRepo(transactions),
    ...options,
  });
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

/**
 * Why a layer resolved to no grants. Six structurally different situations produce the identical
 * empty layer, and only one of them ("holds roles, they grant nothing") is unremarkable. The rest
 * are faults an operator needs to see: a principal that is not there, one that cannot authenticate,
 * a repo read that threw, or — the dangerous one — a Role assignment naming a Role the durable
 * store does not have, or one the principal is not assignable to.
 *
 * That last pair is the reason this type exists. The resolver fails the *whole* layer closed on a
 * single bad assignment, which is correct: a partially-understood role set must not be treated as
 * the full one. But the observable result is a principal who silently holds nothing, reported by
 * the admin surfaces as "holds nothing, this is expected" — telling the operator all is well at the
 * exact moment of lockout. The reason travels alongside the layer so the surfaces can say which
 * of the six it was. It never changes what is granted.
 */
export type LayerEmptyReason =
  | "no-such-principal"
  | "not-authenticatable"
  | "assignment-read-failed"
  | "no-roles-assigned"
  | "roles-grant-nothing"
  | "unknown-role"
  | "role-not-assignable"
  | "grant-collection-failed";

/**
 * A resolved layer plus, when it came out empty, why. `resolvePrincipalLayer` discards the reason
 * so the gate path is unchanged; diagnostic surfaces call {@link
 * LiveAuthorityLayerResolver.diagnosePrincipalLayer} instead.
 */
export interface DiagnosedAuthorityLayer {
  readonly layer: AuthorityLayer;
  readonly emptyReason?: LayerEmptyReason;
  /** Role ids named by an assignment that the durable store could not honour. */
  readonly unresolvedRoleIds?: readonly string[];
}

function emptyLayer(name: string): AuthorityLayer {
  return { name, grants: [] };
}

function emptyDiagnosis(name: string, reason: LayerEmptyReason): DiagnosedAuthorityLayer {
  return { layer: emptyLayer(name), emptyReason: reason };
}

export function callerAuthorityPrincipal(principal: RequestPrincipal): AuthorityPrincipal {
  return {
    id: principal.id,
    businessId: principal.businessId,
    kind: principal.kind,
  };
}

export function agentAuthorityPrincipal(businessId: string, agentId: string): AuthorityPrincipal {
  return { id: agentId, businessId, kind: "agent" };
}

/**
 * Resolves live Role assignments for principals into the `AuthorityLayer` shape the Stage 4 gate
 * will consume. It only reads durable principal/role rows; Soul artifact compilation into those
 * rows stays owned by the shared compiler path.
 */
export class LiveAuthorityLayerResolver {
  private readonly now: () => Date;

  constructor(private readonly options: AuthorityLayerResolverOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async resolvePrincipalLayer(
    name: string,
    principal: AuthorityPrincipal
  ): Promise<AuthorityLayer> {
    return (await this.diagnosePrincipalLayer(name, principal)).layer;
  }

  /**
   * The same resolution, carrying why an empty layer emptied. Every `return` below is byte-for-byte
   * the layer `resolvePrincipalLayer` used to return; only the accompanying reason is new.
   */
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
    try {
      assignedRoleIds = await this.collectAssignedRoleIds(principal, now);
    } catch {
      // A group repo read that throws must never widen a layer — fail closed.
      return emptyDiagnosis(name, "assignment-read-failed");
    }
    if (assignedRoleIds.length === 0) return emptyDiagnosis(name, "no-roles-assigned");

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
      const grants = collectRoleGrants(assignedRoleIds, rolesById, now);
      return grants.length === 0
        ? emptyDiagnosis(name, "roles-grant-nothing")
        : { layer: { name, grants } };
    } catch {
      return emptyDiagnosis(name, "grant-collection-failed");
    }
  }

  /**
   * The Roles a principal effectively holds: its direct assignments unioned with the Roles held by
   * every unexpired group it is an unexpired member of. Fails closed at every ambiguity — an
   * expired group, an expired membership, or an expired group-Role holding contributes nothing,
   * and duplicates collapse so a Role reached two ways is resolved once.
   */
  private async collectAssignedRoleIds(
    principal: AuthorityPrincipal,
    now: Date
  ): Promise<string[]> {
    const roleIds = new Set<string>();
    const directAssignments = await this.options.roles.listAssignments(
      principal.businessId,
      principal.id,
      now
    );
    for (const assignment of directAssignments) roleIds.add(assignment.roleId);

    const groupRepo = this.options.groups;
    if (groupRepo !== undefined) {
      const memberships = await groupRepo.listMemberships(principal.businessId, principal.id, now);
      for (const membership of memberships) {
        const group = await groupRepo.getGroup(principal.businessId, membership.groupId);
        // A missing group, or one that has itself expired, grants nothing even if the membership
        // row survives — `listMemberships` only checks the membership's own expiry.
        if (group === undefined || (group.expiresAt !== undefined && group.expiresAt <= now)) {
          continue;
        }
        const held = await groupRepo.listGroupRoles(principal.businessId, membership.groupId, now);
        for (const holding of held) roleIds.add(holding.roleId);
      }
    }

    return [...roleIds];
  }

  resolveCallerLayer(principal: RequestPrincipal): Promise<AuthorityLayer> {
    return this.resolvePrincipalLayer(principal.kind, callerAuthorityPrincipal(principal));
  }

  resolveAgentLayer(businessId: string, agentId: string): Promise<AuthorityLayer> {
    return this.resolvePrincipalLayer("agent", agentAuthorityPrincipal(businessId, agentId));
  }

  async resolveCallerAndAgentLayers(
    principal: RequestPrincipal,
    agentId: string
  ): Promise<readonly AuthorityLayer[]> {
    const [caller, agent] = await Promise.all([
      this.resolveCallerLayer(principal),
      this.resolveAgentLayer(principal.businessId, agentId),
    ]);
    return [caller, agent];
  }
}
