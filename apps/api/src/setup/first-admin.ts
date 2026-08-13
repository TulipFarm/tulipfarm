import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { AdminAlreadyExistsError, EmailAlreadyExistsError, type UserDoc } from "../auth/users";
import type { Queryable } from "../db";
import { withTransaction } from "../db";

export interface SetupAdminCreator {
  create(user: UserDoc): Promise<void>;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

/**
 * Atomic first-admin creator for setup/headless bootstrap. The `setup_bootstrap` unique index
 * protects only the first-admin claim (#172); the same transaction then grants owner explicitly.
 */
export class PgSetupAdminCreator implements SetupAdminCreator {
  constructor(
    private readonly q: Queryable,
    private readonly businessId = DEPLOYMENT_BUSINESS_ID
  ) {}

  async create(user: UserDoc): Promise<void> {
    try {
      await withTransaction(this.q, async (transaction) => {
        await transaction.query(
          `INSERT INTO users (
             id, email, password_hash, name, role, status, created_at, setup_bootstrap
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
          [
            user._id,
            user.email,
            user.passwordHash,
            user.name,
            user.role,
            user.status,
            user.createdAt,
          ]
        );
        await transaction.query(
          `INSERT INTO principals (business_id, id, kind, status)
           VALUES ($1, $2, 'user', 'active')
           ON CONFLICT (business_id, id) DO UPDATE SET
             kind = EXCLUDED.kind,
             status = EXCLUDED.status,
             updated_at = now()`,
          [this.businessId, user._id]
        );
        await transaction.query(
          `INSERT INTO role_assignments (business_id, principal_id, role_id)
           VALUES ($1, $2, 'admin'), ($1, $2, 'owner')
           ON CONFLICT (business_id, principal_id, role_id) DO UPDATE SET
             expires_at = NULL,
             assigned_at = now()`,
          [this.businessId, user._id]
        );
        await transaction.query(
          `INSERT INTO principal_groups (business_id, id)
           VALUES ($1, 'owners')
           ON CONFLICT (business_id, id) DO NOTHING`,
          [this.businessId]
        );
        await transaction.query(
          `INSERT INTO principal_group_members (business_id, group_id, principal_id)
           VALUES ($1, 'owners', $2)
           ON CONFLICT (business_id, group_id, principal_id) DO UPDATE SET
             expires_at = NULL,
             assigned_at = now()`,
          [this.businessId, user._id]
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, "users_setup_bootstrap_admin_idx")) {
        throw new AdminAlreadyExistsError();
      }
      if (isUniqueViolation(error, "users_email_key")) {
        throw new EmailAlreadyExistsError();
      }
      throw error;
    }
  }
}
