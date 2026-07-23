/**
 * Persistence for custom composable roles and role assignments (SPEC §12), scoped to a
 * business_id. Storage owns the mechanics; `@tulipfarm/authz` owns cycle checks, assignability,
 * and the effective-permission decision. Assignment expiry is enforced here (`listAssignments`
 * never returns an expired row) so every caller sees the same durable truth.
 */

export type RoleAssignableTo = "user" | "agent" | "both";

export type GrantEffect = "allow" | "deny";

export interface GrantRecord {
  readonly action: string;
  readonly resourceType: string;
  readonly recordSelector?: string;
  readonly fieldSelector?: readonly string[];
  readonly dataClass?: string;
  readonly destination?: string;
  readonly conditions?: Readonly<Record<string, string>>;
  readonly effect: GrantEffect;
  readonly expiresAt?: Date;
}

export interface RoleRecord {
  readonly id: string;
  readonly businessId: string;
  readonly assignableTo: RoleAssignableTo;
  readonly parentRoleIds: readonly string[];
  readonly grants: readonly GrantRecord[];
  readonly expiresAt?: Date;
}

export interface RoleAssignmentRecord {
  readonly principalId: string;
  readonly roleId: string;
  readonly businessId: string;
  readonly expiresAt?: Date;
}

export interface RoleRepo {
  getRole(id: string): Promise<RoleRecord | undefined>;
  putRole(record: RoleRecord): Promise<void>;
  assign(record: RoleAssignmentRecord): Promise<void>;
  /** Only unexpired assignments, even if expired rows have not been reaped yet. */
  listAssignments(principalId: string): Promise<RoleAssignmentRecord[]>;
}

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link RoleRepo} contract.
 */
export class InMemoryRoleRepo implements RoleRepo {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly assignments: RoleAssignmentRecord[] = [];

  async getRole(id: string): Promise<RoleRecord | undefined> {
    return this.roles.get(id);
  }

  async putRole(record: RoleRecord): Promise<void> {
    this.roles.set(record.id, Object.freeze({ ...record }));
  }

  async assign(record: RoleAssignmentRecord): Promise<void> {
    this.assignments.push(Object.freeze({ ...record }));
  }

  async listAssignments(principalId: string): Promise<RoleAssignmentRecord[]> {
    const now = new Date();
    return this.assignments.filter(
      (a) => a.principalId === principalId && (!a.expiresAt || a.expiresAt > now)
    );
  }
}
