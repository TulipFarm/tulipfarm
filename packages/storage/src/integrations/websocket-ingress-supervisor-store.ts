import type { TransactionPort } from "../ports";
import type { VerifiedWebhookDeliveryInput } from "./webhook-inbox-store";
import { recordVerifiedWebhookDelivery } from "./webhook-inbox-store";

/**
 * Single-holder lease that lets exactly one worker supervise a Connection's WebSocket at a time.
 *
 * The lease is keyed by Connection, not by worker: a claim succeeds only when no live lease exists,
 * and heartbeat renewal keeps it while the socket stays open. A crashed supervisor's lease simply
 * expires, so the next worker can take over without a human unwinding a stuck row.
 */
export const WEBSOCKET_INGRESS_SUPERVISOR_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS websocket_ingress_supervisor (
    business_id       text NOT NULL,
    connection_id     text NOT NULL,
    holder_token      text NOT NULL,
    lease_expires_at  timestamptz NOT NULL,
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections (business_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS websocket_ingress_supervisor_expiry_idx
     ON websocket_ingress_supervisor (lease_expires_at)`,
];

export class WebsocketIngressSupervisorStore {
  constructor(private readonly transactions: TransactionPort) {}

  async acquire(
    businessId: string,
    connectionId: string,
    holderToken: string,
    leaseSeconds: number,
    now = new Date()
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `INSERT INTO websocket_ingress_supervisor (
           business_id, connection_id, holder_token, lease_expires_at
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
           SET holder_token = EXCLUDED.holder_token,
               lease_expires_at = EXCLUDED.lease_expires_at
         WHERE websocket_ingress_supervisor.lease_expires_at <= $4
         RETURNING connection_id`,
        [businessId, connectionId, holderToken, now, leaseSeconds]
      );
      return result.rows.length === 1;
    });
  }

  async renew(
    businessId: string,
    connectionId: string,
    holderToken: string,
    leaseSeconds: number,
    now = new Date()
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE websocket_ingress_supervisor
            SET lease_expires_at = $4::timestamptz + make_interval(secs => $5)
          WHERE business_id = $1 AND connection_id = $2 AND holder_token = $3
            AND lease_expires_at > $4
          RETURNING connection_id`,
        [businessId, connectionId, holderToken, now, leaseSeconds]
      );
      return result.rows.length === 1;
    });
  }

  async release(businessId: string, connectionId: string, holderToken: string): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `DELETE FROM websocket_ingress_supervisor
          WHERE business_id = $1 AND connection_id = $2 AND holder_token = $3
          RETURNING connection_id`,
        [businessId, connectionId, holderToken]
      );
      return result.rows.length === 1;
    });
  }

  async remove(businessId: string, connectionId: string): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `DELETE FROM websocket_ingress_supervisor
          WHERE business_id = $1 AND connection_id = $2
          RETURNING connection_id`,
        [businessId, connectionId]
      );
      return result.rows.length === 1;
    });
  }

  /** Persist one accepted frame to the durable inbox, but only while the Connection is active. */
  async recordFrameIfActive(
    key: {
      readonly businessId: string;
      readonly connectionId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly externalTenantId: string;
      readonly externalAccountId: string;
    },
    input: VerifiedWebhookDeliveryInput,
    fence: { readonly holderToken: string; readonly now?: Date }
  ) {
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR SHARE`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      if (connection.rows.length !== 1) throw new Error("websocket_ingress_inactive");
      const lease = await transaction.query(
        `SELECT 1 FROM websocket_ingress_supervisor
          WHERE business_id = $1 AND connection_id = $2 AND holder_token = $3
            AND lease_expires_at > $4`,
        [key.businessId, key.connectionId, fence.holderToken, fence.now ?? new Date()]
      );
      if (lease.rows.length !== 1) throw new Error("websocket_ingress_lease_lost");
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
      if (active.rows.length !== 1) throw new Error("websocket_ingress_inactive");
      if (
        input.integrationId !== key.integrationId ||
        input.integrationMajorVersion !== key.integrationMajorVersion ||
        input.connectionId !== key.connectionId ||
        input.externalTenantId !== key.externalTenantId ||
        input.externalAccountId !== key.externalAccountId
      ) {
        throw new Error("websocket_ingress_binding_mismatch");
      }
      return recordVerifiedWebhookDelivery(transaction, key.businessId, input);
    });
  }
}
