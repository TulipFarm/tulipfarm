import type { TransactionPort } from "../ports";
import type { VerifiedWebhookDeliveryInput } from "./webhook-inbox-store";
import { recordVerifiedWebhookDelivery } from "./webhook-inbox-store";

export interface PollingIngressLease {
  readonly cursor: string | null;
}

export const POLLING_INGRESS_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS polling_ingress_state (
    business_id       text NOT NULL,
    connection_id     text NOT NULL,
    cursor            text,
    next_poll_at      timestamptz NOT NULL DEFAULT now(),
    lease_token       text,
    lease_expires_at  timestamptz,
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections (business_id, id) ON DELETE CASCADE,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS polling_ingress_due_idx
     ON polling_ingress_state (next_poll_at, lease_expires_at)`,
];

export class PollingIngressStore {
  constructor(private readonly transactions: TransactionPort) {}

  async claim(
    businessId: string,
    connectionId: string,
    leaseToken: string,
    leaseSeconds: number,
    now = new Date()
  ): Promise<PollingIngressLease | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
          FOR SHARE`,
        [businessId, connectionId]
      );
      if (connection.rows.length !== 1) return null;
      const result = await transaction.query<{ cursor: string | null }>(
        `INSERT INTO polling_ingress_state (
           business_id, connection_id, lease_token, lease_expires_at
         )
         SELECT $1, $2, $3, $4::timestamptz + make_interval(secs => $5)
           FROM connections
          WHERE business_id = $1 AND id = $2
            AND status = 'active' AND webhook_registration IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns
               WHERE business_id = $1 AND connection_id = $2
            )
         ON CONFLICT (business_id, connection_id) DO UPDATE
           SET lease_token = EXCLUDED.lease_token,
               lease_expires_at = EXCLUDED.lease_expires_at
         WHERE polling_ingress_state.next_poll_at <= $4
           AND (
             polling_ingress_state.lease_expires_at IS NULL
             OR polling_ingress_state.lease_expires_at <= $4
           )
         RETURNING cursor`,
        [businessId, connectionId, leaseToken, now, leaseSeconds]
      );
      return result.rows[0] ?? null;
    });
  }

  async complete(
    businessId: string,
    connectionId: string,
    leaseToken: string,
    cursor: string | null,
    intervalSeconds: number,
    now = new Date()
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE polling_ingress_state
            SET cursor = $4,
                next_poll_at = $6::timestamptz + make_interval(secs => $5),
                lease_token = NULL,
                lease_expires_at = NULL
          WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3
          RETURNING connection_id`,
        [businessId, connectionId, leaseToken, cursor, intervalSeconds, now]
      );
      return result.rows.length === 1;
    });
  }

  async release(
    businessId: string,
    connectionId: string,
    leaseToken: string,
    retryAfterSeconds: number,
    now = new Date()
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE polling_ingress_state
            SET next_poll_at = $5::timestamptz + make_interval(secs => $4),
                lease_token = NULL,
                lease_expires_at = NULL
          WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3
          RETURNING connection_id`,
        [businessId, connectionId, leaseToken, retryAfterSeconds, now]
      );
      return result.rows.length === 1;
    });
  }

  async remove(businessId: string, connectionId: string): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `DELETE FROM polling_ingress_state
          WHERE business_id = $1 AND connection_id = $2
          RETURNING connection_id`,
        [businessId, connectionId]
      );
      return result.rows.length === 1;
    });
  }

  async recordVerifiedIfActive(
    key: {
      readonly businessId: string;
      readonly connectionId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly externalTenantId: string;
      readonly externalAccountId: string;
    },
    input: VerifiedWebhookDeliveryInput
  ) {
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR SHARE`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      if (connection.rows.length !== 1) throw new Error("polling_ingress_inactive");
      const active = await transaction.query(
        `SELECT 1
           FROM connections connection
           JOIN connection_external_identities identity
             ON identity.business_id = connection.business_id
            AND identity.connection_id = connection.id
            AND identity.integration_id = connection.integration_id
            AND identity.integration_major_version = connection.integration_major_version
          WHERE connection.business_id = $1 AND connection.id = $2
            AND connection.integration_id = $3
            AND connection.integration_major_version = $4
            AND connection.status = 'active'
            AND connection.health_status IN ('healthy', 'expiring')
            AND (connection.expires_at IS NULL OR connection.expires_at > now())
            AND connection.webhook_registration IS NULL
            AND identity.external_tenant_id = $5 AND identity.external_account_id = $6
            AND NOT EXISTS (
              SELECT 1 FROM oim_ingress_teardowns teardown
               WHERE teardown.business_id = connection.business_id
                 AND teardown.connection_id = connection.id
            )`,
        [
          key.businessId,
          key.connectionId,
          key.integrationId,
          key.integrationMajorVersion,
          key.externalTenantId,
          key.externalAccountId,
        ]
      );
      if (active.rows.length !== 1) throw new Error("polling_ingress_inactive");
      if (
        input.integrationId !== key.integrationId ||
        input.integrationMajorVersion !== key.integrationMajorVersion ||
        input.connectionId !== key.connectionId ||
        input.externalTenantId !== key.externalTenantId ||
        input.externalAccountId !== key.externalAccountId
      ) {
        throw new Error("polling_ingress_binding_mismatch");
      }
      return recordVerifiedWebhookDelivery(transaction, key.businessId, input);
    });
  }
}
