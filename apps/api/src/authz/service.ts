/**
 * Read/write service behind the Stage 3 admin authorization API.
 *
 * It exposes the durable authority state an owner needs to author and inspect grants *before*
 * Stage 4 flips the gate to default-deny: who holds which Role, which group holds which Role, and
 * — via {@link AuthzAdminService.explain} — what the one decision function would decide for a
 * concrete request and which layer denied it.
 *
 * Two boundaries are load-bearing:
 *
 * - **Role *definitions* are never written here.** `reconcileSoulRoles` reaps every non-reserved
 *   durable Role absent from Soul on each `soul.synced`, so a Role row this service wrote directly
 *   would be silently deleted on the next sync. Soul stays the single writer of Role definitions
 *   (design doc §4 / D1); {@link AuthzAdminService.createRole} therefore reports the missing
 *   authoring path instead of forging a row. Assignments, groups, and memberships are durable
 *   operational state, not Soul artifacts, so this service does write those directly.
 * - **The decision is not reimplemented.** `explain` builds the principal's live authority layer
 *   through the same {@link LiveAuthorityLayerResolver} the gate will use and hands it to
 *   `decideEffectivePermission`; a second intersection would be a defect (design doc invariant 4).
 */

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

/** Reason code stamped on every audit event a mutation on this surface emits (design invariant 5). */
export const AUTHZ_ADMIN_CHANGE = "AUTHZ_ADMIN_CHANGE";

/**
 * The slice of {@link AuditService} this surface needs. Narrowing to `recordOrWarn` keeps the
 * dependency injectable in tests (a class with private fields is not structurally fakeable) while
 * `AuditService` satisfies it directly in production.
 */
export interface AuthzAuditPort {
  recordOrWarn(input: AuditRecordInput): Promise<void>;
}

/**
 * Layers the real gate intersects that this endpoint structurally cannot reach: L3 run context and
 * L4 guardrail policy are pinned inside a Run, and L5 credential scope belongs to one integration
 * grant. Named in every response so an `allowed` is never mistaken for a gate guarantee.
 */
const UNREACHABLE_LAYERS: readonly string[] = ["run", "guardrail", "credential"];

/** Why the Role-definition authoring path is unavailable, surfaced verbatim to the caller as `501`. */ export const ROLE_AUTHORING_UNAVAILABLE =
  "Role definitions are authored in Soul and published through the Soul changeset gateway, which " +
  "is not yet wired into this API. Writing a durable Role row here would be reaped on the next " +
  "soul sync. Author the Role in Soul instead.";

export interface AuthzAdminServiceDeps {
  readonly roles: RoleRepo;
  readonly groups: GroupRepo;
  readonly principals: PrincipalRepo;
  readonly resolver: LiveAuthorityLayerResolver;
  readonly businessId: string;
  /** Optional: authorization changes are audited when present, logged-and-continued when it fails. */
  readonly audit?: AuthzAuditPort;
  /**
   * Authored Role id → how the Soul catalog identifies it: the name its author gave it, and the
   * slug its artifact directory is named after.
   *
   * Read through a function rather than captured, because Soul reloads on every sync: a map taken
   * at construction would keep naming a level after it was renamed, or leave a newly authored one
   * anonymous until the process restarted. Absent leaves both fields null, which is what the
   * pre-Soul boot path and most tests want.
   */
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
  /**
   * The name its author gave it. A Role's durable id is a UUID for an authored level, so without
   * this every level a business creates would be listed to them as `a3f1c0de-...`. Absent for the
   * built-in Roles, whose names are product copy rather than authored data.
   */
  readonly displayName: string | null;
  /**
   * The artifact directory this level lives in, which is also how it is addressed for deletion.
   * `null` for the built-ins, and for any authored Role the Soul catalog cannot account for —
   * a level whose slug is unknown cannot be deleted, which is the right failure.
   */
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
  /**
   * Present only when `grants` is empty, naming which of the six emptying situations occurred.
   * Without it "holds nothing" is indistinguishable from "authority could not be determined".
   */
  readonly emptyReason?: LayerEmptyReason;
  /** Role ids an assignment names that the durable store could not honour. */
  readonly unresolvedRoleIds?: readonly string[];
}

/**
 * Which principal could not be found, so the route can say *which* id was wrong rather than making
 * an operator guess between the two ids they supplied.
 */
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
  /**
   * Exactly which layers this decision intersected. Load-bearing, not diagnostics decoration —
   * see {@link AuthzAdminService.explain} for why an `allowed` here is an upper bound.
   */
  readonly evaluatedLayers: readonly string[];
  /** The layers the real gate will also intersect but this endpoint cannot. Empty means none. */
  readonly unevaluatedLayers: readonly string[];
  /**
   * Why an evaluated layer resolved to no grants, keyed by layer name. A `deniedLayer` naming a
   * layer that appears here is a data fault masquerading as a policy decision.
   */
  readonly layerEmptyReasons?: Readonly<Record<string, LayerEmptyReason>>;
  /** Role ids named by assignments the durable store could not honour, across evaluated layers. */
  readonly unresolvedRoleIds?: readonly string[];
  /**
   * True whenever `unevaluatedLayers` is non-empty: `allowed: true` means "no layer *checked here*
   * denied", never "the gate will permit this".
   */
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

/** How an audited mutation was carried out — the signed-in admin, for attribution. */
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

/** The Role id that can grant `authz.*`, and therefore the one that must never reach zero holders. */
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

  /**
   * Every principal in the deployment, human and not.
   *
   * Non-human principals are the reason this exists. A `user` gets its row from the
   * `sync_user_authorization()` trigger, so it can always be found from the users list — but an
   * Integration adapter, a service identity or an Agent has no such source. Nothing else in the
   * product can enumerate them, so without this an operator would have to already know the exact
   * id of the principal they were about to grant authority to.
   */
  async listPrincipals(): Promise<readonly PrincipalView[]> {
    const principals = await this.deps.principals.list(this.deps.businessId);
    return principals.map((principal) => ({
      id: principal.id,
      kind: principal.kind,
      status: principal.status,
      expiresAt: iso(principal.expiresAt),
    }));
  }

  /**
   * Registers a non-human principal so authority can be granted to it.
   *
   * This closes the one gap that made default-deny unrecoverable. Production mints subjects that
   * are not users — `integration:<slug>` for a Slack or Telegram delivery, `agent:assistant` for a
   * chat-started Routine, `service:cron-scheduler` for a schedule fire — and a principal with no
   * durable row resolves to an empty authority layer, which under intersection denies everything.
   * Soul Role authoring already supports every principal kind end to end (`principalTypes` →
   * `assignableTo`), so the row was the only missing link: without it there was no id to assign a
   * Role to, and no UI could restore a deployment that had locked its own channels out.
   *
   * Two refusals keep it from becoming a way to rewrite authority rather than extend it:
   *
   * - **`user` is refused.** Those rows are owned by the `sync_user_authorization()` trigger. A
   *   hand-written one would either be overwritten without notice or drift from the account it
   *   claims to represent.
   * - **A kind change is refused.** Re-registering an existing id with the same kind is idempotent
   *   and harmless, but silently re-pointing an id at a different kind would re-interpret every
   *   Role assignment already made against it — `assertRoleAssignable` is evaluated per kind — so
   *   it is a conflict, not an update.
   */
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

  /**
   * A principal's effective grants: its direct assignments unioned with every unexpired
   * group-held Role it inherits, resolved through the live authority resolver the gate will use.
   * `null` when the principal has no durable row, so the route answers `404`.
   */
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

  /**
   * The single decision endpoint. Resolves the principal's live layer (and the Agent's, when an
   * `agentId` is given) and hands them to the one decision function; `deniedLayer` names which
   * layer denied. `null` when the principal has no durable row, so the route answers `404` rather
   * than inventing an empty layer whose denial would read as a policy gap.
   *
   * **An `allowed: true` here is an upper bound, never a guarantee.** `decideEffectivePermission`
   * allows only when *every* layer allows, so evaluating a subset can only ever be more permissive
   * than the real gate. This endpoint can reach the live layers (L1 caller, L2 Agent) but not the
   * pinned ones — L3 run context and L4 guardrail policy exist only inside a Run, and L5 credential
   * scope belongs to a specific integration grant. A denial here is therefore authoritative (a
   * layer that denies in isolation denies in the intersection too), while an allow is provisional.
   *
   * That asymmetry is why the response names `evaluatedLayers`/`unevaluatedLayers` and sets
   * `partial` rather than returning a bare boolean: a diagnostic tool that silently answers "yes"
   * where the gate says "no" is worse than no tool, because it is trusted.
   */
  async explain(input: ExplainInput): Promise<ExplainView | ExplainNotFound> {
    const principal = await this.deps.principals.get(this.deps.businessId, input.principalId);
    if (principal === undefined) return { notFound: "principal" };
    // The same reasoning that returns 404 for an unknown caller applies to an unknown Agent, and
    // for a sharper reason: `resolvePrincipalLayer` returns an *empty* layer for a principal that
    // does not exist, and an empty layer denies. A typo'd agent id would therefore produce a
    // confident `deniedLayer: "agent"` that this endpoint calls authoritative, and an operator
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
    // Attribute each empty layer to its cause. `deniedLayer: "agent"` reads as a policy answer, but
    // if that layer emptied because an assignment names a Role the store does not have, the honest
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

  /** Role *definition* authoring is not available here — see {@link ROLE_AUTHORING_UNAVAILABLE}. */
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

  /**
   * Creates a group, or re-states an existing one.
   *
   * The subtlety is the expiry. `putGroup` is a full upsert, so posting an existing id without
   * `expiresAt` silently *clears* a previously set expiry — turning a deliberately time-boxed group
   * into a permanent one, answering `201` as though it had just been created, and leaving no trace
   * of what was dropped. Distinguishing the two cases is what makes that visible: a genuine create
   * still answers `201`, a re-statement answers `200`, and the audit record carries the previous
   * expiry so the change is reconstructible.
   */
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

  /**
   * Refuses any mutation that would leave the deployment with nobody holding the `owner` Role.
   *
   * `owner` is the only Role that can grant `authz.*`, and Role *definitions* are Soul-owned — the
   * admin API answers `501` to authoring one — so an empty owner set cannot be repaired from the
   * product at all. It is not one door but four, and guarding only the obvious one leaves the
   * other three wide open:
   *
   *   1. revoke the direct `owner` assignment            → revokeRole
   *   2. remove the last member of a group holding it    → removeGroupMember
   *   3. revoke `owner` from that group                  → revokeGroupRole
   *   4. delete the group outright                       → deleteGroup
   *
   * Each computes the *resulting* owner set and refuses when it would be empty, rather than
   * pattern-matching on the specific action — so a fifth door added later fails safe by reusing
   * this. Today `owner` is not yet enforced by any gate, which makes this look academic; at the
   * Stage 4 flip it becomes the difference between a recoverable deployment and a bricked one.
   */
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

  /**
   * A group-held Role is resolved per member under the same assignability rule a direct assignment
   * obeys, and `authority-layers.ts` fails the *entire* group layer closed when one Role does not
   * apply to that member — stripping them of everything the group grants, not just that Role. So
   * both writes that can create such a pairing must refuse it up front rather than report success
   * and silently empty the layer.
   */
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
