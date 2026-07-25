/**
 * Custom composable roles per SPEC §12: administrators define roles assignable to users,
 * Agents, or both; roles compose through parents but must stay cycle-free; assignment never
 * crosses a business boundary or a principal-kind boundary. Resolution fails closed — an
 * unknown or cyclic reference is an error, and an expired role contributes nothing.
 */

import type { AccessGrant } from "./grants";
import type { Principal } from "./principals";

export type RoleAssignableTo = "user" | "agent" | "both";

export interface Role {
  readonly id: string;
  readonly businessId: string;
  readonly assignableTo: RoleAssignableTo;
  /** Composed parent roles whose grants this role inherits. */
  readonly parentRoleIds: readonly string[];
  readonly grants: readonly AccessGrant[];
  /** The role stops granting anything at this instant; absent means no expiry. */
  readonly expiresAt?: Date;
}

export class RoleCycleError extends Error {
  constructor(public readonly cycle: readonly string[]) {
    super(`role composition cycle: ${cycle.join(" -> ")}`);
    this.name = "RoleCycleError";
  }
}

export class RoleResolutionError extends Error {
  constructor(public readonly roleId: string) {
    super(`role ${roleId} does not exist`);
    this.name = "RoleResolutionError";
  }
}

export type RoleAssignmentDenialReason = "kind_mismatch" | "business_mismatch" | "expired";

export class RoleAssignmentError extends Error {
  constructor(
    public readonly reason: RoleAssignmentDenialReason,
    message: string
  ) {
    super(message);
    this.name = "RoleAssignmentError";
  }
}

/** Throws {@link RoleCycleError} when any composition path in `roles` revisits a role. */
export function assertRoleGraphAcyclic(roles: readonly Role[]): void {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const done = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (path.includes(id)) {
      throw new RoleCycleError([...path.slice(path.indexOf(id)), id]);
    }
    if (done.has(id)) return;
    const role = byId.get(id);
    if (role) {
      for (const parentId of role.parentRoleIds) visit(parentId, [...path, id]);
    }
    done.add(id);
  };
  for (const role of roles) visit(role.id, []);
}

/**
 * Throws unless `role` may be assigned to `principal` at `now`: the kinds must agree with
 * `assignableTo` (only user and Agent principals ever take these roles), the business must
 * match, and the role must not be expired (SPEC §12).
 */
export function assertRoleAssignable(
  role: Role,
  principal: Pick<Principal, "kind" | "businessId">,
  now: Date = new Date()
): void {
  if (role.businessId !== principal.businessId) {
    throw new RoleAssignmentError(
      "business_mismatch",
      `role ${role.id} belongs to a different business than the principal`
    );
  }
  if (role.expiresAt && role.expiresAt <= now) {
    throw new RoleAssignmentError("expired", `role ${role.id} has expired`);
  }
  const kindAllowed =
    (principal.kind === "user" && role.assignableTo !== "agent") ||
    (principal.kind === "agent" && role.assignableTo !== "user");
  if (!kindAllowed) {
    throw new RoleAssignmentError(
      "kind_mismatch",
      `role ${role.id} (${role.assignableTo}) is not assignable to a ${principal.kind} principal`
    );
  }
}

/**
 * Flattens the grants of `roleIds` and their composed parents. Fails closed: an unknown role
 * throws {@link RoleResolutionError}, a cycle throws {@link RoleCycleError}, a cross-business
 * composition throws {@link RoleAssignmentError}, and an expired role contributes nothing (its
 * parents included). Each role is visited once.
 */
export function collectRoleGrants(
  roleIds: readonly string[],
  rolesById: ReadonlyMap<string, Role>,
  now: Date = new Date()
): AccessGrant[] {
  const grants: AccessGrant[] = [];
  const done = new Set<string>();
  let businessId: string | undefined;
  const visit = (id: string, path: readonly string[]): void => {
    if (path.includes(id)) {
      throw new RoleCycleError([...path.slice(path.indexOf(id)), id]);
    }
    if (done.has(id)) return;
    done.add(id);
    const role = rolesById.get(id);
    if (!role) throw new RoleResolutionError(id);
    businessId ??= role.businessId;
    if (role.businessId !== businessId) {
      throw new RoleAssignmentError(
        "business_mismatch",
        `role ${role.id} cannot compose with a role from another business`
      );
    }
    if (role.expiresAt && role.expiresAt <= now) return;
    grants.push(...role.grants);
    for (const parentId of role.parentRoleIds) visit(parentId, [...path, id]);
  };
  for (const id of roleIds) visit(id, []);
  return grants;
}
