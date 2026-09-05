/** Roles compose cycle-free, stay within business/kind boundaries, and resolve fail-closed. */

import type { RoleAssignmentTargetKind } from "@tulipfarm/schema";
import type { AccessGrant } from "./grants";

export type RoleAssignableTo = readonly RoleAssignmentTargetKind[];

export interface RoleAssignmentTarget {
  readonly kind: RoleAssignmentTargetKind;
  readonly businessId: string;
}

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

export interface RoleGrantEntry {
  readonly roleId: string;
  readonly grantIndex: number;
  readonly grant: AccessGrant;
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
 * Throws unless `role` may be assigned to `principal` at `now`: the principal kind must be in
 * `assignableTo`, the business must match, and the role must not be expired (SPEC §12).
 */
export function assertRoleAssignable(
  role: Role,
  target: RoleAssignmentTarget,
  now: Date = new Date()
): void {
  if (role.businessId !== target.businessId) {
    throw new RoleAssignmentError(
      "business_mismatch",
      `role ${role.id} belongs to a different business than the assignment target`
    );
  }
  if (role.expiresAt && role.expiresAt <= now) {
    throw new RoleAssignmentError("expired", `role ${role.id} has expired`);
  }
  if (!role.assignableTo.includes(target.kind)) {
    throw new RoleAssignmentError(
      "kind_mismatch",
      `role ${role.id} (${role.assignableTo.join(", ")}) is not assignable to a ${
        target.kind
      } target`
    );
  }
}

/** Flattens role grants; unknown, cyclic, or cross-business composition fails closed. */
export function collectRoleGrants(
  roleIds: readonly string[],
  rolesById: ReadonlyMap<string, Role>,
  now: Date = new Date()
): AccessGrant[] {
  return collectRoleGrantEntries(roleIds, rolesById, now).map((entry) => entry.grant);
}

/** Flattens Role grants while retaining the authored Role and grant index for explanations. */
export function collectRoleGrantEntries(
  roleIds: readonly string[],
  rolesById: ReadonlyMap<string, Role>,
  now: Date = new Date()
): RoleGrantEntry[] {
  const entries: RoleGrantEntry[] = [];
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
    for (const [grantIndex, grant] of role.grants.entries()) {
      if (!grant.expiresAt || grant.expiresAt > now) {
        entries.push({ roleId: role.id, grantIndex, grant });
      }
    }
    for (const parentId of role.parentRoleIds) visit(parentId, [...path, id]);
  };
  for (const id of roleIds) visit(id, []);
  return entries;
}
