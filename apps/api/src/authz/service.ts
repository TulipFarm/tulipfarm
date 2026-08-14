/** Never writes Role definitions; `explain` uses the live resolver + decision function. */

import {
  type AccessGrant,
  type AccessRequest,
  type AuthzDecisionReason,
  assertRoleAssignable,
  decideEffectivePermission,
} from "@tulipfarm/authz";
import type {
  GroupRecord,
  GroupRepo,
  PrincipalKind,
  PrincipalRecord,
  PrincipalRepo,
  RoleRecord,
  RoleRepo,
} from "@tulipfarm/storage";
import type { AuditRecordInput, AuditService } from "../audit/service";
import {
  type AuthorityPrincipal,
  agentAuthorityPrincipal,
  type LayerEmptyReason,
  type LiveAuthorityLayerResolver,
} from "../identity/authority-layers";
import { RESERVED_ROLE_IDS } from "../identity/role-reconcile";

export const AUTHZ_ADMIN_CHANGE = "AUTHZ_ADMIN_CHANGE";

export interface AuthzAuditPort {
  recordOrWarn(input: AuditRecordInput): Promise<void>;
}

/** Real gate layers this endpoint cannot evaluate; `allowed` is only a partial answer. */
const UNREACHABLE_LAYERS: readonly string[] = ["run", "guardrail", "credential"];

export const ROLE_AUTHORING_UNAVAILABLE =
  "Role definitions are authored in Soul and published through the Soul changeset gateway, which " +
  "is not yet wired into this API. Writing a durable Role row here would be reaped on the next " +
  "soul sync. Author the Role in Soul instead.";

export interface AuthzAdminServiceDeps {
  readonly roles: RoleRepo;
  readonly groups: GroupRepo;
  readonly principals: PrincipalRepo;
  readonly resolver: LiveAuthorityLayerResolver;
  readonly businessId: string;
  /** Authorization changes are audited when present; failures log and continue. */
  readonly audit?: AuthzAuditPort;
  /** Read live because Soul reloads can rename or add authored Roles after construction. */
  readonly roleNames?: () => ReadonlyMap<string, { displayName?: string; slug: string }>;
  now?(): Date;
}

export interface GrantView {
  readonly effect: AccessGrant["effect"];
  readonly action: string;
  readonly resourceType: string;
  readonly label: string;
}

export interface RoleView {
  readonly id: string;
  readonly displayName: string | null;
  /** `null` when the built-in or Soul catalog cannot identify the deletion slug. */
  readonly slug: string | null;
  /** `builtin` for the reserved bootstrap Roles (owner/admin/member), `authored` for Soul Roles. */
  readonly source: "builtin" | "authored";
  readonly assignableTo: readonly string[];
  readonly parentRoleIds: readonly string[];
  readonly grants: readonly GrantView[];
  readonly expiresAt: string | null;
}

export interface AssigneeView {
  readonly principalId: string;
  readonly expiresAt: string | null;
}

export interface GroupView {
  readonly id: string;
  readonly expiresAt: string | null;
}

export interface GroupDetailView extends GroupView {
  readonly members: readonly { readonly principalId: string; readonly expiresAt: string | null }[];
  readonly roles: readonly { readonly roleId: string; readonly expiresAt: string | null }[];
}

export interface EffectiveGrantsView {
  readonly principalId: string;
  readonly kind: string;
  readonly grants: readonly GrantView[];
  /** Present only when empty grants need a cause. */
  readonly emptyReason?: LayerEmptyReason;
  readonly unresolvedRoleIds?: readonly string[];
}

export type ExplainNotFound = { readonly notFound: "principal" | "agent" };

export interface ExplainInput {
  readonly principalId: string;
  readonly action: string;
  readonly resourceType: string;
  /** When given, the Agent's own layer (L2) is intersected with the caller's, as the gate will. */
  readonly agentId?: string;
  readonly domain?: string;
  readonly recordId?: string;
  readonly field?: string;
  readonly dataClass?: string;
  readonly destination?: string;
  readonly conditions?: Readonly<Record<string, string>>;
}

export interface ExplainView {
  readonly principalId: string;
  readonly kind: string;
  readonly allowed: boolean;
  readonly reason: AuthzDecisionReason;
  /** The layer that denied, when denied; absent when allowed. */
  readonly deniedLayer?: string;
  /** Layers actually intersected; `allowed` remains an upper bound. */
  readonly evaluatedLayers: readonly string[];
  /** The layers the real gate will also intersect but this endpoint cannot. Empty means none. */
  readonly unevaluatedLayers: readonly string[];
  readonly layerEmptyReasons?: Readonly<Record<string, LayerEmptyReason>>;
  readonly unresolvedRoleIds?: readonly string[];
  /** True when `allowed` means only "no evaluated layer denied". */
  readonly partial: boolean;
}

export type MutationErrorCode =
  | "role_not_found"
  | "principal_not_found"
  | "group_not_found"
  | "not_assignable"
  | "principal_kind_conflict"
  | "user_principal_managed"
  | "last_owner";

export type MutationResult = { ok: true } | { ok: false; code: MutationErrorCode; message: string };

export interface AssignInput {
  readonly roleId: string;
  readonly principalId: string;
  readonly expiresAt?: string;
}

export interface GroupRoleInput {
  readonly groupId: string;
  readonly roleId: string;
  readonly expiresAt?: string;
}

export interface GroupMemberInput {
  readonly groupId: string;
  readonly principalId: string;
  readonly expiresAt?: string;
}

export interface PrincipalView {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly status: PrincipalRecord["status"];
  readonly expiresAt: string | null;
}

export interface RegisterPrincipalInput {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly expiresAt?: string;
}

export interface AuthzActor {
  readonly actorId: string | null;
  readonly correlationId?: string;
}

function iso(value: Date | undefined): string | null {
  return value === undefined ? null : value.toISOString();
}

function grantLabel(grant: AccessGrant): string {
  const action = grant.action === "*" ? "any action" : grant.action;
  const resource = grant.resourceType === "*" ? "any resource" : grant.resourceType;
  const domain =
    grant.domain === undefined
      ? ""
      : grant.domain === "*"
        ? " in any domain"
        : ` in domain ${grant.domain}`;
  const scope = Object.entries(grant.conditions ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const base = `${grant.effect} ${action} on ${resource}${domain}`;
  return scope ? `${base} when ${scope}` : base;
}

function grantView(grant: AccessGrant): GrantView {
  return {
    effect: grant.effect,
    action: grant.action,
    resourceType: grant.resourceType,
    label: grantLabel(grant),
  };
}

/** The Role id that can grant `authz.*`; it must never reach zero holders. */
const OWNER_ROLE_ID = "owner";

function lastOwner(message: string): MutationResult {
  return { ok: false, code: "last_owner", message };
}

function notFound(code: MutationErrorCode, message: string): MutationResult {
  return { ok: false, code, message };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Thrown by {@link AuthzAdminService.createRole}; the route translates it into `501`. */
export class RoleAuthoringUnavailableError extends Error {
  readonly name = "RoleAuthoringUnavailableError";
  constructor() {
    super(ROLE_AUTHORING_UNAVAILABLE);
  }
}

export class AuthzAdminService {
  private readonly now: () => Date;

  constructor(private readonly deps: AuthzAdminServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async listRoles(): Promise<readonly RoleView[]> {
    const roles = await this.deps.roles.listRoles(this.deps.businessId);
    return roles.map((role) => this.roleView(role));
  }

  private roleView(role: RoleRecord): RoleView {
    const soul = this.deps.roleNames?.().get(role.id);
    return {
      id: role.id,
      displayName: soul?.displayName ?? null,
      slug: soul?.slug ?? null,
      source: RESERVED_ROLE_IDS.has(role.id) ? "builtin" : "authored",
      assignableTo: role.assignableTo,
      parentRoleIds: role.parentRoleIds,
      grants: role.grants.map((grant) => grantView(grant)),
      expiresAt: iso(role.expiresAt),
    };
  }

  /** `null` when the Role does not exist, so the route answers `404`. */
  async listAssignees(roleId: string): Promise<readonly AssigneeView[] | null> {
    const role = await this.deps.roles.getRole(this.deps.businessId, roleId);
    if (role === undefined) return null;
    const assignees = await this.deps.roles.listAssignees(this.deps.businessId, roleId, this.now());
    return assignees.map((assignment) => ({
      principalId: assignment.principalId,
      expiresAt: iso(assignment.expiresAt),
    }));
  }

  async listGroups(): Promise<readonly GroupView[]> {
    const groups = await this.deps.groups.listGroups(this.deps.businessId);
    return groups.map((group) => ({ id: group.id, expiresAt: iso(group.expiresAt) }));
  }

  /** Includes non-human principals that have no users-list source. */
  async listPrincipals(): Promise<readonly PrincipalView[]> {
    const principals = await this.deps.principals.list(this.deps.businessId);
    return principals.map((principal) => ({
      id: principal.id,
      kind: principal.kind,
      status: principal.status,
      expiresAt: iso(principal.expiresAt),
    }));
  }

  /** Registers non-human principals; `user` rows stay users-table managed. */
  async registerPrincipal(
    input: RegisterPrincipalInput,
    actor: AuthzActor
  ): Promise<MutationResult> {
    if (input.kind === "user") {
      return {
        ok: false,
        code: "user_principal_managed",
        message:
          "user principals are maintained from the users table and cannot be registered here",
      };
    }
    const existing = await this.deps.principals.get(this.deps.businessId, input.id);
    if (existing !== undefined && existing.kind !== input.kind) {
      return {
        ok: false,
        code: "principal_kind_conflict",
        message: `principal ${input.id} already exists as ${existing.kind}`,
      };
    }
    await this.deps.principals.put({
      id: input.id,
      businessId: this.deps.businessId,
      kind: input.kind,
      status: "active",
      ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }),
    });
    await this.audit(actor, "authz.principal.register", `principal:${input.id}`, {
      kind: input.kind,
      created: existing === undefined,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    return { ok: true };
  }

  /** `null` when the group does not exist, so the route answers `404`. */
  async getGroup(groupId: string): Promise<GroupDetailView | null> {
    const group = await this.deps.groups.getGroup(this.deps.businessId, groupId);
    if (group === undefined) return null;
    const now = this.now();
    const [members, roles] = await Promise.all([
      this.deps.groups.listMembers(this.deps.businessId, groupId, now),
      this.deps.groups.listGroupRoles(this.deps.businessId, groupId, now),
    ]);
    return {
      id: group.id,
      expiresAt: iso(group.expiresAt),
      members: members.map((member) => ({
        principalId: member.principalId,
        expiresAt: iso(member.expiresAt),
      })),
      roles: roles.map((held) => ({ roleId: held.roleId, expiresAt: iso(held.expiresAt) })),
    };
  }

  /** Uses the live authority resolver; `null` lets the route answer `404`. */
  async effectiveGrants(principalId: string): Promise<EffectiveGrantsView | null> {
    const principal = await this.deps.principals.get(this.deps.businessId, principalId);
    if (principal === undefined) return null;
    const diagnosed = await this.deps.resolver.diagnosePrincipalLayer(
      principal.kind,
      this.authorityPrincipal(principal)
    );
    return {
      principalId,
      kind: principal.kind,
      grants: diagnosed.layer.grants.map((grant) => grantView(grant)),
      ...(diagnosed.emptyReason === undefined ? {} : { emptyReason: diagnosed.emptyReason }),
      ...(diagnosed.unresolvedRoleIds === undefined
        ? {}
        : { unresolvedRoleIds: [...diagnosed.unresolvedRoleIds] }),
    };
  }

  /** Uses the one decision function; missing principals return `404`, not empty-layer denials. */
  async explain(input: ExplainInput): Promise<ExplainView | ExplainNotFound> {
    const principal = await this.deps.principals.get(this.deps.businessId, input.principalId);
    if (principal === undefined) return { notFound: "principal" };
    // The same reasoning that returns 404 for an unknown caller applies to an unknown Agent, and
    // diagnosing a complaint would author grants against a phantom. "No such principal" must not
    // be presented as "policy denied".
    if (input.agentId !== undefined) {
      const agent = await this.deps.principals.get(this.deps.businessId, input.agentId);
      if (agent === undefined) return { notFound: "agent" };
    }
    const now = this.now();
    const diagnosed = [
      await this.deps.resolver.diagnosePrincipalLayer(
        principal.kind,
        this.authorityPrincipal(principal)
      ),
    ];
    if (input.agentId !== undefined) {
      diagnosed.push(
        await this.deps.resolver.diagnosePrincipalLayer(
          "agent",
          agentAuthorityPrincipal(this.deps.businessId, input.agentId)
        )
      );
    }
    const layers = diagnosed.map((entry) => entry.layer);
    // answer is that authority could not be determined — a different problem with a different fix.
    const layerEmptyReasons: Record<string, LayerEmptyReason> = {};
    const unresolvedRoleIds: string[] = [];
    for (const entry of diagnosed) {
      if (entry.emptyReason !== undefined) layerEmptyReasons[entry.layer.name] = entry.emptyReason;
      if (entry.unresolvedRoleIds !== undefined) unresolvedRoleIds.push(...entry.unresolvedRoleIds);
    }
    const request: AccessRequest = {
      action: input.action,
      resourceType: input.resourceType,
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
      ...(input.field === undefined ? {} : { field: input.field }),
      ...(input.dataClass === undefined ? {} : { dataClass: input.dataClass }),
      ...(input.destination === undefined ? {} : { destination: input.destination }),
      ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
    };
    const decision = decideEffectivePermission(layers, request, now);
    const evaluatedLayers = layers.map((layer) => layer.name);
    const unevaluatedLayers = [
      ...(input.agentId === undefined ? ["agent"] : []),
      ...UNREACHABLE_LAYERS,
    ];
    return {
      principalId: input.principalId,
      kind: principal.kind,
      allowed: decision.allowed,
      reason: decision.reason,
      ...(decision.deniedLayer === undefined ? {} : { deniedLayer: decision.deniedLayer }),
      evaluatedLayers,
      unevaluatedLayers,
      partial: unevaluatedLayers.length > 0,
      ...(Object.keys(layerEmptyReasons).length === 0 ? {} : { layerEmptyReasons }),
      ...(unresolvedRoleIds.length === 0 ? {} : { unresolvedRoleIds }),
    };
  }

  async createRole(): Promise<never> {
    throw new RoleAuthoringUnavailableError();
  }

  async assignRole(input: AssignInput, actor: AuthzActor): Promise<MutationResult> {
    const now = this.now();
    const role = await this.deps.roles.getRole(this.deps.businessId, input.roleId);
    if (role === undefined) {
      return notFound("role_not_found", `role ${input.roleId} does not exist`);
    }
    const principal = await this.deps.principals.get(this.deps.businessId, input.principalId);
    if (principal === undefined) {
      return notFound("principal_not_found", `principal ${input.principalId} does not exist`);
    }
    try {
      assertRoleAssignable(
        { ...role, grants: [] },
        { kind: principal.kind, businessId: principal.businessId },
        now
      );
    } catch (error) {
      return { ok: false, code: "not_assignable", message: message(error) };
    }
    await this.deps.roles.assign({
      businessId: this.deps.businessId,
      principalId: input.principalId,
      roleId: input.roleId,
      ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }),
    });
    await this.audit(actor, "authz.assignment.create", `role:${input.roleId}`, {
      principalId: input.principalId,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    return { ok: true };
  }

  async revokeRole(
    roleId: string,
    principalId: string,
    actor: AuthzActor
  ): Promise<MutationResult> {
    const role = await this.deps.roles.getRole(this.deps.businessId, roleId);
    if (role === undefined) {
      return notFound("role_not_found", `role ${roleId} does not exist`);
    }
    if (roleId === OWNER_ROLE_ID && (await this.wouldStrandOwnership({ principalId }))) {
      return lastOwner("revoking this assignment would leave the deployment with no owner");
    }
    await this.deps.roles.revokeAssignment(this.deps.businessId, principalId, roleId);
    await this.audit(actor, "authz.assignment.revoke", `role:${roleId}`, { principalId });
    return { ok: true };
  }

  /** Existing groups without `expiresAt` clear expiry; audit records the previous value. */
  async createGroup(
    groupId: string,
    expiresAt: string | undefined,
    actor: AuthzActor
  ): Promise<{ readonly created: boolean }> {
    const existing = await this.deps.groups.getGroup(this.deps.businessId, groupId);
    const record: GroupRecord = {
      businessId: this.deps.businessId,
      id: groupId,
      ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) }),
    };
    await this.deps.groups.putGroup(record);
    const previousExpiresAt = existing?.expiresAt?.toISOString();
    await this.audit(actor, "authz.group.upsert", `group:${groupId}`, {
      created: existing === undefined,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(previousExpiresAt === undefined ? {} : { previousExpiresAt }),
      ...(existing !== undefined && previousExpiresAt !== undefined && expiresAt === undefined
        ? { expiryCleared: true }
        : {}),
    });
    return { created: existing === undefined };
  }

  async deleteGroup(groupId: string, actor: AuthzActor): Promise<MutationResult> {
    const group = await this.deps.groups.getGroup(this.deps.businessId, groupId);
    if (group === undefined) {
      return notFound("group_not_found", `group ${groupId} does not exist`);
    }
    if (await this.wouldStrandOwnership({ groupId })) {
      return lastOwner("deleting this group would leave the deployment with no owner");
    }
    await this.deps.groups.deleteGroup(this.deps.businessId, groupId);
    await this.audit(actor, "authz.group.delete", `group:${groupId}`);
    return { ok: true };
  }

  async addGroupMember(input: GroupMemberInput, actor: AuthzActor): Promise<MutationResult> {
    const group = await this.deps.groups.getGroup(this.deps.businessId, input.groupId);
    if (group === undefined) {
      return notFound("group_not_found", `group ${input.groupId} does not exist`);
    }
    const principal = await this.deps.principals.get(this.deps.businessId, input.principalId);
    if (principal === undefined) {
      return notFound("principal_not_found", `principal ${input.principalId} does not exist`);
    }
    const unassignable = await this.groupAssignabilityFailure(
      (await this.deps.groups.listGroupRoles(this.deps.businessId, input.groupId, this.now())).map(
        (held) => held.roleId
      ),
      [principal]
    );
    if (unassignable !== undefined) {
      return { ok: false, code: "not_assignable", message: unassignable };
    }
    await this.deps.groups.addMember({
      businessId: this.deps.businessId,
      groupId: input.groupId,
      principalId: input.principalId,
      ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }),
    });
    await this.audit(actor, "authz.group.member.add", `group:${input.groupId}`, {
      principalId: input.principalId,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    return { ok: true };
  }

  async removeGroupMember(
    groupId: string,
    principalId: string,
    actor: AuthzActor
  ): Promise<MutationResult> {
    const group = await this.deps.groups.getGroup(this.deps.businessId, groupId);
    if (group === undefined) {
      return notFound("group_not_found", `group ${groupId} does not exist`);
    }
    if (await this.wouldStrandOwnership({ principalId })) {
      return lastOwner("removing this member would leave the deployment with no owner");
    }
    await this.deps.groups.removeMember(this.deps.businessId, groupId, principalId);
    await this.audit(actor, "authz.group.member.remove", `group:${groupId}`, { principalId });
    return { ok: true };
  }

  async assignGroupRole(input: GroupRoleInput, actor: AuthzActor): Promise<MutationResult> {
    const group = await this.deps.groups.getGroup(this.deps.businessId, input.groupId);
    if (group === undefined) {
      return notFound("group_not_found", `group ${input.groupId} does not exist`);
    }
    const role = await this.deps.roles.getRole(this.deps.businessId, input.roleId);
    if (role === undefined) {
      return notFound("role_not_found", `role ${input.roleId} does not exist`);
    }
    const members = await this.deps.groups.listMembers(
      this.deps.businessId,
      input.groupId,
      this.now()
    );
    const principals = (
      await Promise.all(
        members.map((member) => this.deps.principals.get(this.deps.businessId, member.principalId))
      )
    ).filter((principal): principal is PrincipalRecord => principal !== undefined);
    const unassignable = await this.groupAssignabilityFailure([input.roleId], principals);
    if (unassignable !== undefined) {
      return { ok: false, code: "not_assignable", message: unassignable };
    }
    await this.deps.groups.assignRole({
      businessId: this.deps.businessId,
      groupId: input.groupId,
      roleId: input.roleId,
      ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }),
    });
    await this.audit(actor, "authz.group.role.assign", `group:${input.groupId}`, {
      roleId: input.roleId,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    return { ok: true };
  }

  async revokeGroupRole(
    groupId: string,
    roleId: string,
    actor: AuthzActor
  ): Promise<MutationResult> {
    const group = await this.deps.groups.getGroup(this.deps.businessId, groupId);
    if (group === undefined) {
      return notFound("group_not_found", `group ${groupId} does not exist`);
    }
    if (
      roleId === OWNER_ROLE_ID &&
      (await this.wouldStrandOwnership({ groupLosingOwner: groupId }))
    ) {
      return lastOwner("revoking owner from this group would leave the deployment with no owner");
    }
    await this.deps.groups.revokeRole(this.deps.businessId, groupId, roleId);
    await this.audit(actor, "authz.group.role.revoke", `group:${groupId}`, { roleId });
    return { ok: true };
  }

  /** Refuses any mutation whose resulting owner set would be empty. */
  private async wouldStrandOwnership(exclude: {
    readonly principalId?: string;
    readonly groupId?: string;
    readonly groupLosingOwner?: string;
  }): Promise<boolean> {
    const before = await this.ownerHolders({});
    // Only the mutation that takes ownership from at least one holder to none is refused. If the
    // deployment already has no owner, this request did not cause that and blocking it would just
    // freeze every group operation behind a condition the operator cannot clear from here.
    if (before.size === 0) return false;
    return (await this.ownerHolders(exclude)).size === 0;
  }

  /** Principals holding `owner` — directly or through a group — ignoring the excluded subjects. */
  private async ownerHolders(exclude: {
    readonly principalId?: string;
    readonly groupId?: string;
    readonly groupLosingOwner?: string;
  }): Promise<Set<string>> {
    const now = this.now();
    const holders = new Set<string>();

    for (const assignment of await this.deps.roles.listAssignees(
      this.deps.businessId,
      OWNER_ROLE_ID,
      now
    )) {
      if (assignment.principalId !== exclude.principalId) holders.add(assignment.principalId);
    }

    for (const group of await this.deps.groups.listGroups(this.deps.businessId)) {
      if (group.id === exclude.groupId || group.id === exclude.groupLosingOwner) continue;
      const groupRoles = await this.deps.groups.listGroupRoles(this.deps.businessId, group.id, now);
      if (!groupRoles.some((role) => role.roleId === OWNER_ROLE_ID)) continue;
      for (const member of await this.deps.groups.listMembers(
        this.deps.businessId,
        group.id,
        now
      )) {
        if (member.principalId !== exclude.principalId) holders.add(member.principalId);
      }
    }

    return holders;
  }

  /** Refuses group Role/member pairings that would fail the whole group layer closed. */
  private async groupAssignabilityFailure(
    roleIds: readonly string[],
    principals: readonly PrincipalRecord[]
  ): Promise<string | undefined> {
    if (roleIds.length === 0 || principals.length === 0) return undefined;
    const now = this.now();
    for (const roleId of roleIds) {
      const role = await this.deps.roles.getRole(this.deps.businessId, roleId);
      if (role === undefined) continue;
      for (const principal of principals) {
        try {
          assertRoleAssignable(
            { ...role, grants: [] },
            { kind: principal.kind, businessId: principal.businessId },
            now
          );
        } catch (error) {
          return message(error);
        }
      }
    }
    return undefined;
  }

  private authorityPrincipal(principal: PrincipalRecord): AuthorityPrincipal {
    return { id: principal.id, businessId: principal.businessId, kind: principal.kind };
  }

  private audit(
    actor: AuthzActor,
    action: string,
    target: string,
    meta?: Record<string, unknown>
  ): Promise<void> {
    return (
      this.deps.audit?.recordOrWarn({
        actorId: actor.actorId,
        action,
        target,
        reasonCodes: [AUTHZ_ADMIN_CHANGE],
        ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
        ...(meta === undefined ? {} : { safeMetadata: meta }),
      }) ?? Promise.resolve()
    );
  }
}
