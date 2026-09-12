import type { TransactionPort } from "../ports";

export type ConnectionAuthStepStatus =
  | "pending"
  | "active"
  | "expired"
  | "action_required"
  | "revoked";

export interface ConnectionAuthStep {
  readonly businessId: string;
  readonly connectionId: string;
  readonly stepId: string;
  readonly status: ConnectionAuthStepStatus;
  readonly accessSlot: string | null;
  readonly accessSecretRef: string | null;
  readonly refreshSlot: string | null;
  readonly refreshSecretRef: string | null;
  readonly externalIdentity: Readonly<Record<string, unknown>> | null;
  readonly expiresAt: string | null;
  readonly healthCheckedAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PutConnectionAuthStep {
  readonly businessId: string;
  readonly connectionId: string;
  readonly stepId: string;
  readonly status: ConnectionAuthStepStatus;
  readonly accessSlot: string | null;
  readonly accessSecretRef: string | null;
  readonly refreshSlot: string | null;
  readonly refreshSecretRef: string | null;
  readonly externalIdentity: Readonly<Record<string, unknown>> | null;
  readonly expiresAt: string | null;
  readonly healthCheckedAt: string | null;
}

export interface UpdateConnectionAuthStepHealth {
  readonly businessId: string;
  readonly connectionId: string;
  readonly stepId: string;
  readonly expectedRevision: number;
  readonly status: ConnectionAuthStepStatus;
  readonly expiresAt: string | null;
  readonly healthCheckedAt: string;
}

export const CONNECTION_AUTH_STEP_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connection_auth_steps (
    business_id        text NOT NULL,
    connection_id      text NOT NULL,
    step_id            text NOT NULL,
    status             text NOT NULL
      CHECK (status IN ('pending', 'active', 'expired', 'action_required', 'revoked')),
    access_slot        text,
    access_secret_ref  text,
    refresh_slot       text,
    refresh_secret_ref text,
    external_identity  jsonb
      CHECK (external_identity IS NULL OR jsonb_typeof(external_identity) = 'object'),
    expires_at         timestamptz,
    health_checked_at  timestamptz,
    revision           bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, connection_id, step_id),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections (business_id, id) ON DELETE CASCADE,
    CHECK (access_secret_ref IS NULL OR access_secret_ref LIKE 'secret://%'),
    CHECK (refresh_secret_ref IS NULL OR refresh_secret_ref LIKE 'secret://%'),
    CHECK (
      (access_slot IS NULL AND access_secret_ref IS NULL)
      OR (access_slot IS NOT NULL AND access_secret_ref IS NOT NULL)
    ),
    CHECK (
      (refresh_slot IS NULL AND refresh_secret_ref IS NULL)
      OR (refresh_slot IS NOT NULL AND refresh_secret_ref IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS connection_auth_steps_expiry_idx
     ON connection_auth_steps (business_id, status, expires_at)
     WHERE expires_at IS NOT NULL`,
];

interface AuthStepRow {
  business_id: string;
  connection_id: string;
  step_id: string;
  status: ConnectionAuthStepStatus;
  access_slot: string | null;
  access_secret_ref: string | null;
  refresh_slot: string | null;
  refresh_secret_ref: string | null;
  external_identity: Record<string, unknown> | null;
  expires_at: Date | string | null;
  health_checked_at: Date | string | null;
  revision: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function fromRow(row: AuthStepRow): ConnectionAuthStep {
  return {
    businessId: row.business_id,
    connectionId: row.connection_id,
    stepId: row.step_id,
    status: row.status,
    accessSlot: row.access_slot,
    accessSecretRef: row.access_secret_ref,
    refreshSlot: row.refresh_slot,
    refreshSecretRef: row.refresh_secret_ref,
    externalIdentity: row.external_identity,
    expiresAt: row.expires_at === null ? null : timestamp(row.expires_at),
    healthCheckedAt: row.health_checked_at === null ? null : timestamp(row.health_checked_at),
    revision: Number(row.revision),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

export class ConnectionAuthStepStore {
  constructor(private readonly transactions: TransactionPort) {}

  async put(input: PutConnectionAuthStep): Promise<ConnectionAuthStep> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<AuthStepRow>(
        `INSERT INTO connection_auth_steps (
           business_id, connection_id, step_id, status, access_slot, access_secret_ref,
           refresh_slot, refresh_secret_ref, external_identity, expires_at, health_checked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         ON CONFLICT (business_id, connection_id, step_id) DO UPDATE SET
           status = EXCLUDED.status,
           access_slot = EXCLUDED.access_slot,
           access_secret_ref = EXCLUDED.access_secret_ref,
           refresh_slot = EXCLUDED.refresh_slot,
           refresh_secret_ref = EXCLUDED.refresh_secret_ref,
           external_identity = EXCLUDED.external_identity,
           expires_at = EXCLUDED.expires_at,
           health_checked_at = EXCLUDED.health_checked_at,
           revision = connection_auth_steps.revision + 1,
           updated_at = now()
         RETURNING *`,
        [
          input.businessId,
          input.connectionId,
          input.stepId,
          input.status,
          input.accessSlot,
          input.accessSecretRef,
          input.refreshSlot,
          input.refreshSecretRef,
          input.externalIdentity === null ? null : JSON.stringify(input.externalIdentity),
          input.expiresAt,
          input.healthCheckedAt,
        ]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("connection_auth_step_not_persisted");
      return fromRow(row);
    });
  }

  async find(
    businessId: string,
    connectionId: string,
    stepId: string
  ): Promise<ConnectionAuthStep | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<AuthStepRow>(
        `SELECT * FROM connection_auth_steps
          WHERE business_id = $1 AND connection_id = $2 AND step_id = $3`,
        [businessId, connectionId, stepId]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }

  async list(businessId: string, connectionId: string): Promise<readonly ConnectionAuthStep[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<AuthStepRow>(
        `SELECT * FROM connection_auth_steps
          WHERE business_id = $1 AND connection_id = $2
          ORDER BY step_id`,
        [businessId, connectionId]
      );
      return result.rows.map(fromRow);
    });
  }

  async updateHealth(input: UpdateConnectionAuthStepHealth): Promise<ConnectionAuthStep | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<AuthStepRow>(
        `UPDATE connection_auth_steps
            SET status = $5,
                expires_at = $6,
                health_checked_at = $7,
                revision = revision + 1,
                updated_at = now()
          WHERE business_id = $1
            AND connection_id = $2
            AND step_id = $3
            AND revision = $4
          RETURNING *`,
        [
          input.businessId,
          input.connectionId,
          input.stepId,
          input.expectedRevision,
          input.status,
          input.expiresAt,
          input.healthCheckedAt,
        ]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }
}
