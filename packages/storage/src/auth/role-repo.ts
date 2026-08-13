/**
 * Persistence for custom composable roles and role assignments (SPEC §12), scoped to a
 * business_id. Storage owns the mechanics; `@tulipfarm/authz` owns cycle checks, assignability,
 * and the effective-permission decision. Assignment expiry is enforced here (`listAssignments`
 * never returns an expired row) so every caller sees the same durable truth.
 */

import type { PrincipalKind } from "@tulipfarm/schema";
import type { TransactionPort } from "../ports";

export type RoleAssignableTo = readonly PrincipalKind[];

export type GrantEffect = "allow" | "deny";

export interface GrantRecord {
  readonly action: string;
  readonly resourceType: string;
  readonly domain?: string;
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

export interface GroupRecord {
  readonly id: string;
  readonly businessId: string;
  readonly expiresAt?: Date;
}

export interface GroupMembershipRecord {
  readonly principalId: string;
  readonly groupId: string;
  readonly businessId: string;
  readonly expiresAt?: Date;
}

/**
 * A Role a group holds. Members of the group inherit these roles, subject to the same assignability
 * and expiry rules a direct assignment obeys. A group cannot be assigned a role through
 * {@link RoleAssignmentRecord} because `role_assignments.principal_id` has a foreign key into
 * `principals`, and a group is not a principal (`principals.kind` has no `group` value) — so
 * group-held roles need their own relation.
 */
export interface GroupRoleAssignmentRecord {
  readonly groupId: string;
  readonly roleId: string;
  readonly businessId: string;
  readonly expiresAt?: Date;
}

export interface RoleRepo {
  getRole(businessId: string, id: string): Promise<RoleRecord | undefined>;
  listRoles(businessId: string): Promise<RoleRecord[]>;
  putRole(record: RoleRecord): Promise<void>;
  /** Removes a Role and, via ON DELETE CASCADE, its grants, parents, and assignments. */
  deleteRole(businessId: string, id: string): Promise<void>;
  assign(record: RoleAssignmentRecord): Promise<void>;
  /** Removes one principal→Role assignment; a no-op when it does not exist. */
  revokeAssignment(businessId: string, principalId: string, roleId: string): Promise<void>;
  /** Only unexpired assignments, even if expired rows have not been reaped yet. */
  listAssignments(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<RoleAssignmentRecord[]>;
  /**
   * The principal-independent inverse of {@link listAssignments}: every principal a Role is
   * assigned to. Unexpired only.
   */
  listAssignees(businessId: string, roleId: string, now: Date): Promise<RoleAssignmentRecord[]>;
}

export interface GroupRepo {
  getGroup(businessId: string, id: string): Promise<GroupRecord | undefined>;
  listGroups(businessId: string): Promise<GroupRecord[]>;
  putGroup(record: GroupRecord): Promise<void>;
  /**
   * Removes a group and, via ON DELETE CASCADE, its memberships and group-held Roles. A no-op when
   * the group does not exist. Deleting a group only detaches its members from the Roles it held;
   * the principals and Roles themselves are untouched.
   */
  deleteGroup(businessId: string, id: string): Promise<void>;
  addMember(record: GroupMembershipRecord): Promise<void>;
  /** Removes one principal from a group; a no-op when the membership does not exist. */
  removeMember(businessId: string, groupId: string, principalId: string): Promise<void>;
  /** Only unexpired memberships, even if expired rows have not been reaped yet. */
  listMemberships(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<GroupMembershipRecord[]>;
  /** Every unexpired member of a group. */
  listMembers(businessId: string, groupId: string, now: Date): Promise<GroupMembershipRecord[]>;
  /** Grants a Role to a group; members inherit it. */
  assignRole(record: GroupRoleAssignmentRecord): Promise<void>;
  /** Removes one Role from a group; a no-op when it does not hold it. */
  revokeRole(businessId: string, groupId: string, roleId: string): Promise<void>;
  /** Only unexpired Roles a group holds. */
  listGroupRoles(
    businessId: string,
    groupId: string,
    now: Date
  ): Promise<GroupRoleAssignmentRecord[]>;
}

export const AUTHORIZATION_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS principals (
    business_id text NOT NULL CHECK (length(business_id) > 0),
    id          text NOT NULL CHECK (length(id) > 0),
    kind        text NOT NULL CHECK (
      kind IN ('user', 'agent', 'routine', 'integration_adapter', 'api', 'service')
    ),
    status      text NOT NULL CHECK (status IN ('active', 'disabled', 'expired')),
    expires_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS roles (
    business_id   text NOT NULL CHECK (length(business_id) > 0),
    id            text NOT NULL CHECK (length(id) > 0),
    assignable_to text[] NOT NULL CHECK (COALESCE(array_length(assignable_to, 1), 0) > 0),
    expires_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS role_parent_roles (
    business_id     text NOT NULL,
    role_id         text NOT NULL,
    parent_role_id  text NOT NULL CHECK (length(parent_role_id) > 0),
    parent_index    integer NOT NULL CHECK (parent_index >= 0),
    PRIMARY KEY (business_id, role_id, parent_role_id),
    UNIQUE (business_id, role_id, parent_index),
    FOREIGN KEY (business_id, role_id) REFERENCES roles(business_id, id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS role_grants (
    business_id      text NOT NULL,
    role_id          text NOT NULL,
    grant_index      integer NOT NULL CHECK (grant_index >= 0),
    action           text NOT NULL CHECK (length(action) > 0),
    resource_type    text NOT NULL CHECK (length(resource_type) > 0),
    domain           text,
    record_selector  text,
    field_selector   text[],
    data_class       text,
    destination      text,
    conditions       jsonb CHECK (conditions IS NULL OR jsonb_typeof(conditions) = 'object'),
    effect           text NOT NULL CHECK (effect IN ('allow', 'deny')),
    expires_at       timestamptz,
    PRIMARY KEY (business_id, role_id, grant_index),
    FOREIGN KEY (business_id, role_id) REFERENCES roles(business_id, id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS principal_groups (
    business_id text NOT NULL CHECK (length(business_id) > 0),
    id          text NOT NULL CHECK (length(id) > 0),
    expires_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS principal_group_members (
    business_id  text NOT NULL,
    group_id     text NOT NULL,
    principal_id text NOT NULL,
    expires_at   timestamptz,
    assigned_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, group_id, principal_id),
    FOREIGN KEY (business_id, group_id) REFERENCES principal_groups(business_id, id)
      ON DELETE CASCADE,
    FOREIGN KEY (business_id, principal_id) REFERENCES principals(business_id, id)
      ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS role_assignments (
    business_id  text NOT NULL,
    principal_id text NOT NULL,
    role_id      text NOT NULL,
    expires_at   timestamptz,
    assigned_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, principal_id, role_id),
    FOREIGN KEY (business_id, principal_id) REFERENCES principals(business_id, id)
      ON DELETE CASCADE,
    FOREIGN KEY (business_id, role_id) REFERENCES roles(business_id, id)
      ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS group_role_assignments (
    business_id  text NOT NULL,
    group_id     text NOT NULL,
    role_id      text NOT NULL,
    expires_at   timestamptz,
    assigned_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, group_id, role_id),
    FOREIGN KEY (business_id, group_id) REFERENCES principal_groups(business_id, id)
      ON DELETE CASCADE,
    FOREIGN KEY (business_id, role_id) REFERENCES roles(business_id, id)
      ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS role_assignments_principal_idx ON role_assignments (business_id, principal_id)",
  "CREATE INDEX IF NOT EXISTS principal_group_members_principal_idx ON principal_group_members (business_id, principal_id)",
  "CREATE INDEX IF NOT EXISTS group_role_assignments_group_idx ON group_role_assignments (business_id, group_id)",
];

/**
 * Process-local reference implementation for tests and single-process composition. A durable
 * PostgreSQL adapter implements the same {@link RoleRepo} contract.
 */
export class InMemoryRoleRepo implements RoleRepo {
  private readonly roles = new Map<string, RoleRecord>();
  private readonly assignments: RoleAssignmentRecord[] = [];

  private roleKey(businessId: string, id: string): string {
    return JSON.stringify([businessId, id]);
  }

  async getRole(businessId: string, id: string): Promise<RoleRecord | undefined> {
    return this.roles.get(this.roleKey(businessId, id));
  }

  async listRoles(businessId: string): Promise<RoleRecord[]> {
    return [...this.roles.values()].filter((role) => role.businessId === businessId);
  }

  async putRole(record: RoleRecord): Promise<void> {
    this.roles.set(this.roleKey(record.businessId, record.id), Object.freeze({ ...record }));
  }

  async deleteRole(businessId: string, id: string): Promise<void> {
    this.roles.delete(this.roleKey(businessId, id));
    // Mirror the ON DELETE CASCADE the Pg adapter relies on for assignments.
    for (let i = this.assignments.length - 1; i >= 0; i--) {
      const assignment = this.assignments[i];
      if (assignment.businessId === businessId && assignment.roleId === id) {
        this.assignments.splice(i, 1);
      }
    }
  }

  async assign(record: RoleAssignmentRecord): Promise<void> {
    await this.revokeAssignment(record.businessId, record.principalId, record.roleId);
    this.assignments.push(Object.freeze({ ...record }));
  }

  async revokeAssignment(businessId: string, principalId: string, roleId: string): Promise<void> {
    for (let i = this.assignments.length - 1; i >= 0; i--) {
      const assignment = this.assignments[i];
      if (
        assignment.businessId === businessId &&
        assignment.principalId === principalId &&
        assignment.roleId === roleId
      ) {
        this.assignments.splice(i, 1);
      }
    }
  }

  async listAssignments(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<RoleAssignmentRecord[]> {
    return this.assignments.filter(
      (assignment) =>
        assignment.businessId === businessId &&
        assignment.principalId === principalId &&
        (!assignment.expiresAt || assignment.expiresAt > now)
    );
  }

  async listAssignees(
    businessId: string,
    roleId: string,
    now: Date
  ): Promise<RoleAssignmentRecord[]> {
    return this.assignments.filter(
      (assignment) =>
        assignment.businessId === businessId &&
        assignment.roleId === roleId &&
        (!assignment.expiresAt || assignment.expiresAt > now)
    );
  }
}

export class InMemoryGroupRepo implements GroupRepo {
  private readonly groups = new Map<string, GroupRecord>();
  private readonly memberships: GroupMembershipRecord[] = [];
  private readonly groupRoles: GroupRoleAssignmentRecord[] = [];

  private groupKey(businessId: string, id: string): string {
    return JSON.stringify([businessId, id]);
  }

  async getGroup(businessId: string, id: string): Promise<GroupRecord | undefined> {
    return this.groups.get(this.groupKey(businessId, id));
  }

  async listGroups(businessId: string): Promise<GroupRecord[]> {
    return [...this.groups.values()].filter((group) => group.businessId === businessId);
  }

  async putGroup(record: GroupRecord): Promise<void> {
    this.groups.set(this.groupKey(record.businessId, record.id), Object.freeze({ ...record }));
  }

  async deleteGroup(businessId: string, id: string): Promise<void> {
    this.groups.delete(this.groupKey(businessId, id));
    for (let i = this.memberships.length - 1; i >= 0; i--) {
      const membership = this.memberships[i];
      if (membership.businessId === businessId && membership.groupId === id) {
        this.memberships.splice(i, 1);
      }
    }
    for (let i = this.groupRoles.length - 1; i >= 0; i--) {
      const held = this.groupRoles[i];
      if (held.businessId === businessId && held.groupId === id) {
        this.groupRoles.splice(i, 1);
      }
    }
  }

  async addMember(record: GroupMembershipRecord): Promise<void> {
    await this.removeMember(record.businessId, record.groupId, record.principalId);
    this.memberships.push(Object.freeze({ ...record }));
  }

  async removeMember(businessId: string, groupId: string, principalId: string): Promise<void> {
    for (let i = this.memberships.length - 1; i >= 0; i--) {
      const membership = this.memberships[i];
      if (
        membership.businessId === businessId &&
        membership.groupId === groupId &&
        membership.principalId === principalId
      ) {
        this.memberships.splice(i, 1);
      }
    }
  }

  async listMemberships(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<GroupMembershipRecord[]> {
    return this.memberships.filter(
      (membership) =>
        membership.businessId === businessId &&
        membership.principalId === principalId &&
        (!membership.expiresAt || membership.expiresAt > now)
    );
  }

  async listMembers(
    businessId: string,
    groupId: string,
    now: Date
  ): Promise<GroupMembershipRecord[]> {
    return this.memberships.filter(
      (membership) =>
        membership.businessId === businessId &&
        membership.groupId === groupId &&
        (!membership.expiresAt || membership.expiresAt > now)
    );
  }

  async assignRole(record: GroupRoleAssignmentRecord): Promise<void> {
    await this.revokeRole(record.businessId, record.groupId, record.roleId);
    this.groupRoles.push(Object.freeze({ ...record }));
  }

  async revokeRole(businessId: string, groupId: string, roleId: string): Promise<void> {
    for (let i = this.groupRoles.length - 1; i >= 0; i--) {
      const held = this.groupRoles[i];
      if (held.businessId === businessId && held.groupId === groupId && held.roleId === roleId) {
        this.groupRoles.splice(i, 1);
      }
    }
  }

  async listGroupRoles(
    businessId: string,
    groupId: string,
    now: Date
  ): Promise<GroupRoleAssignmentRecord[]> {
    return this.groupRoles.filter(
      (held) =>
        held.businessId === businessId &&
        held.groupId === groupId &&
        (!held.expiresAt || held.expiresAt > now)
    );
  }
}

interface RoleRow {
  id: string;
  business_id: string;
  assignable_to: PrincipalKind[];
  expires_at: Date | null;
}

interface ParentRoleRow {
  parent_role_id: string;
}

interface GrantRow {
  action: string;
  resource_type: string;
  domain: string | null;
  record_selector: string | null;
  field_selector: string[] | null;
  data_class: string | null;
  destination: string | null;
  conditions: unknown;
  effect: GrantEffect;
  expires_at: Date | null;
}

interface AssignmentRow {
  business_id: string;
  principal_id: string;
  role_id: string;
  expires_at: Date | null;
}

interface GroupRow {
  id: string;
  business_id: string;
  expires_at: Date | null;
}

interface MembershipRow {
  business_id: string;
  principal_id: string;
  group_id: string;
  expires_at: Date | null;
}

interface GroupRoleRow {
  business_id: string;
  group_id: string;
  role_id: string;
  expires_at: Date | null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function conditionsFromRow(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!isStringRecord(parsed)) {
    throw new Error("role grant conditions must be a string-valued object");
  }
  return parsed;
}

function roleFromRows(
  role: RoleRow,
  parents: readonly ParentRoleRow[],
  grants: readonly GrantRow[]
): RoleRecord {
  return {
    id: role.id,
    businessId: role.business_id,
    assignableTo: role.assignable_to,
    parentRoleIds: parents.map((parent) => parent.parent_role_id),
    grants: grants.map((grant) => ({
      action: grant.action,
      resourceType: grant.resource_type,
      ...(grant.domain === null ? {} : { domain: grant.domain }),
      ...(grant.record_selector === null ? {} : { recordSelector: grant.record_selector }),
      ...(grant.field_selector === null ? {} : { fieldSelector: grant.field_selector }),
      ...(grant.data_class === null ? {} : { dataClass: grant.data_class }),
      ...(grant.destination === null ? {} : { destination: grant.destination }),
      ...(grant.conditions === null ? {} : { conditions: conditionsFromRow(grant.conditions) }),
      effect: grant.effect,
      ...(grant.expires_at === null ? {} : { expiresAt: grant.expires_at }),
    })),
    ...(role.expires_at === null ? {} : { expiresAt: role.expires_at }),
  };
}

function assignmentFromRow(row: AssignmentRow): RoleAssignmentRecord {
  return {
    businessId: row.business_id,
    principalId: row.principal_id,
    roleId: row.role_id,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function groupFromRow(row: GroupRow): GroupRecord {
  return {
    businessId: row.business_id,
    id: row.id,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function membershipFromRow(row: MembershipRow): GroupMembershipRecord {
  return {
    businessId: row.business_id,
    principalId: row.principal_id,
    groupId: row.group_id,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function groupRoleFromRow(row: GroupRoleRow): GroupRoleAssignmentRecord {
  return {
    businessId: row.business_id,
    groupId: row.group_id,
    roleId: row.role_id,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

/**
 * PostgreSQL adapter for durable Role definitions and principal→Role assignments. It preserves the
 * exact `RoleRecord` grant shape column-by-column so grants remain queryable and auditable after a
 * restart instead of being hidden in one opaque JSON blob.
 */
export class PgRoleRepo implements RoleRepo {
  constructor(private readonly transactions: TransactionPort) {}

  async getRole(businessId: string, id: string): Promise<RoleRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const roles = await transaction.query<RoleRow>(
        `SELECT id, business_id, assignable_to, expires_at
           FROM roles
          WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
      const role = roles.rows[0];
      if (!role) return undefined;
      const [parents, grants] = await Promise.all([
        transaction.query<ParentRoleRow>(
          `SELECT parent_role_id
             FROM role_parent_roles
            WHERE business_id = $1 AND role_id = $2
            ORDER BY parent_index`,
          [businessId, id]
        ),
        transaction.query<GrantRow>(
          `SELECT action, resource_type, domain, record_selector, field_selector, data_class,
                  destination, conditions, effect, expires_at
             FROM role_grants
            WHERE business_id = $1 AND role_id = $2
            ORDER BY grant_index`,
          [businessId, id]
        ),
      ]);
      return roleFromRows(role, parents.rows, grants.rows);
    });
  }

  async listRoles(businessId: string): Promise<RoleRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const roles = await transaction.query<RoleRow>(
        `SELECT id, business_id, assignable_to, expires_at
           FROM roles
          WHERE business_id = $1
          ORDER BY id`,
        [businessId]
      );
      const records: RoleRecord[] = [];
      for (const role of roles.rows) {
        const [parents, grants] = await Promise.all([
          transaction.query<ParentRoleRow>(
            `SELECT parent_role_id
               FROM role_parent_roles
              WHERE business_id = $1 AND role_id = $2
              ORDER BY parent_index`,
            [role.business_id, role.id]
          ),
          transaction.query<GrantRow>(
            `SELECT action, resource_type, domain, record_selector, field_selector, data_class,
                    destination, conditions, effect, expires_at
               FROM role_grants
              WHERE business_id = $1 AND role_id = $2
              ORDER BY grant_index`,
            [role.business_id, role.id]
          ),
        ]);
        records.push(roleFromRows(role, parents.rows, grants.rows));
      }
      return records;
    });
  }

  async putRole(record: RoleRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO roles (business_id, id, assignable_to, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (business_id, id) DO UPDATE SET
           assignable_to = EXCLUDED.assignable_to,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
        [record.businessId, record.id, [...record.assignableTo], record.expiresAt ?? null]
      );
      await transaction.query(
        "DELETE FROM role_parent_roles WHERE business_id = $1 AND role_id = $2",
        [record.businessId, record.id]
      );
      await transaction.query("DELETE FROM role_grants WHERE business_id = $1 AND role_id = $2", [
        record.businessId,
        record.id,
      ]);
      for (const [index, parentRoleId] of record.parentRoleIds.entries()) {
        await transaction.query(
          `INSERT INTO role_parent_roles (business_id, role_id, parent_role_id, parent_index)
           VALUES ($1, $2, $3, $4)`,
          [record.businessId, record.id, parentRoleId, index]
        );
      }
      for (const [index, grant] of record.grants.entries()) {
        await transaction.query(
          `INSERT INTO role_grants (
             business_id, role_id, grant_index, action, resource_type, domain, record_selector,
             field_selector, data_class, destination, conditions, effect, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
          [
            record.businessId,
            record.id,
            index,
            grant.action,
            grant.resourceType,
            grant.domain ?? null,
            grant.recordSelector ?? null,
            grant.fieldSelector ? [...grant.fieldSelector] : null,
            grant.dataClass ?? null,
            grant.destination ?? null,
            grant.conditions ? JSON.stringify(grant.conditions) : null,
            grant.effect,
            grant.expiresAt ?? null,
          ]
        );
      }
    });
  }

  async assign(record: RoleAssignmentRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO role_assignments (business_id, principal_id, role_id, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, principal_id, role_id) DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           assigned_at = now()`,
        [record.businessId, record.principalId, record.roleId, record.expiresAt ?? null]
      );
    });
  }

  async deleteRole(businessId: string, id: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query("DELETE FROM roles WHERE business_id = $1 AND id = $2", [
        businessId,
        id,
      ]);
    });
  }

  async revokeAssignment(businessId: string, principalId: string, roleId: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `DELETE FROM role_assignments
          WHERE business_id = $1 AND principal_id = $2 AND role_id = $3`,
        [businessId, principalId, roleId]
      );
    });
  }

  async listAssignments(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<RoleAssignmentRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<AssignmentRow>(
        `SELECT business_id, principal_id, role_id, expires_at
           FROM role_assignments
          WHERE business_id = $1
            AND principal_id = $2
            AND (expires_at IS NULL OR expires_at > $3)
          ORDER BY role_id`,
        [businessId, principalId, now]
      );
      return result.rows.map(assignmentFromRow);
    });
  }

  async listAssignees(
    businessId: string,
    roleId: string,
    now: Date
  ): Promise<RoleAssignmentRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<AssignmentRow>(
        `SELECT business_id, principal_id, role_id, expires_at
           FROM role_assignments
          WHERE business_id = $1
            AND role_id = $2
            AND (expires_at IS NULL OR expires_at > $3)
          ORDER BY principal_id`,
        [businessId, roleId, now]
      );
      return result.rows.map(assignmentFromRow);
    });
  }
}

export class PgGroupRepo implements GroupRepo {
  constructor(private readonly transactions: TransactionPort) {}

  async getGroup(businessId: string, id: string): Promise<GroupRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<GroupRow>(
        `SELECT business_id, id, expires_at
           FROM principal_groups
          WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
      const row = result.rows[0];
      return row ? groupFromRow(row) : undefined;
    });
  }

  async listGroups(businessId: string): Promise<GroupRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<GroupRow>(
        `SELECT business_id, id, expires_at
           FROM principal_groups
          WHERE business_id = $1
          ORDER BY id`,
        [businessId]
      );
      return result.rows.map(groupFromRow);
    });
  }

  async putGroup(record: GroupRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO principal_groups (business_id, id, expires_at, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (business_id, id) DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
        [record.businessId, record.id, record.expiresAt ?? null]
      );
    });
  }

  async deleteGroup(businessId: string, id: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      // Memberships and group-held Roles reference principal_groups with ON DELETE CASCADE, so a
      // single delete removes the group and every relation that hung off it.
      await transaction.query(`DELETE FROM principal_groups WHERE business_id = $1 AND id = $2`, [
        businessId,
        id,
      ]);
    });
  }

  async addMember(record: GroupMembershipRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO principal_group_members (business_id, group_id, principal_id, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, group_id, principal_id) DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           assigned_at = now()`,
        [record.businessId, record.groupId, record.principalId, record.expiresAt ?? null]
      );
    });
  }

  async removeMember(businessId: string, groupId: string, principalId: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `DELETE FROM principal_group_members
          WHERE business_id = $1 AND group_id = $2 AND principal_id = $3`,
        [businessId, groupId, principalId]
      );
    });
  }

  async listMemberships(
    businessId: string,
    principalId: string,
    now: Date
  ): Promise<GroupMembershipRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `SELECT business_id, principal_id, group_id, expires_at
           FROM principal_group_members
          WHERE business_id = $1
            AND principal_id = $2
            AND (expires_at IS NULL OR expires_at > $3)
          ORDER BY group_id`,
        [businessId, principalId, now]
      );
      return result.rows.map(membershipFromRow);
    });
  }

  async listMembers(
    businessId: string,
    groupId: string,
    now: Date
  ): Promise<GroupMembershipRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `SELECT business_id, principal_id, group_id, expires_at
           FROM principal_group_members
          WHERE business_id = $1
            AND group_id = $2
            AND (expires_at IS NULL OR expires_at > $3)
          ORDER BY principal_id`,
        [businessId, groupId, now]
      );
      return result.rows.map(membershipFromRow);
    });
  }

  async assignRole(record: GroupRoleAssignmentRecord): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO group_role_assignments (business_id, group_id, role_id, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, group_id, role_id) DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           assigned_at = now()`,
        [record.businessId, record.groupId, record.roleId, record.expiresAt ?? null]
      );
    });
  }

  async revokeRole(businessId: string, groupId: string, roleId: string): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `DELETE FROM group_role_assignments
          WHERE business_id = $1 AND group_id = $2 AND role_id = $3`,
        [businessId, groupId, roleId]
      );
    });
  }

  async listGroupRoles(
    businessId: string,
    groupId: string,
    now: Date
  ): Promise<GroupRoleAssignmentRecord[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<GroupRoleRow>(
        `SELECT business_id, group_id, role_id, expires_at
           FROM group_role_assignments
          WHERE business_id = $1
            AND group_id = $2
            AND (expires_at IS NULL OR expires_at > $3)
          ORDER BY role_id`,
        [businessId, groupId, now]
      );
      return result.rows.map(groupRoleFromRow);
    });
  }
}
