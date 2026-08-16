/** Group persistence is business-scoped; storage enforces membership and held-role expiry. */

import type { TransactionPort } from "../ports";

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
 * Group-held Roles use their own relation because groups are not principals; expiry and
 * assignability still apply.
 */
export interface GroupRoleAssignmentRecord {
  readonly groupId: string;
  readonly roleId: string;
  readonly businessId: string;
  readonly expiresAt?: Date;
}

export interface GroupRepo {
  getGroup(businessId: string, id: string): Promise<GroupRecord | undefined>;
  listGroups(businessId: string): Promise<GroupRecord[]>;
  putGroup(record: GroupRecord): Promise<void>;
  /**
   * Deletes only group membership and held-role links via cascade; principals and Roles stay.
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
