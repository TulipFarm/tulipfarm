import type { TransactionPort } from "../ports";
import type { WebhookRegistrationKey } from "./webhook-registration-store";

export const INGRESS_TEARDOWN_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS oim_ingress_teardowns (
    business_id text NOT NULL,
    connection_id text NOT NULL,
    requested_at timestamptz NOT NULL,
    PRIMARY KEY (business_id, connection_id),
    FOREIGN KEY (business_id, connection_id)
      REFERENCES connections(business_id, id) ON DELETE CASCADE
  )`,
] as const;

export class IngressTeardownStore {
  constructor(private readonly transactions: TransactionPort) {}

  async disable(key: WebhookRegistrationKey, now = new Date()): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const connection = await transaction.query(
        `SELECT id FROM connections
          WHERE business_id = $1 AND id = $2
            AND integration_id = $3 AND integration_major_version = $4
          FOR UPDATE`,
        [key.businessId, key.connectionId, key.integrationId, key.integrationMajorVersion]
      );
      if (connection.rows.length !== 1) return false;
      await transaction.query(
        `INSERT INTO oim_ingress_teardowns (business_id, connection_id, requested_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (business_id, connection_id) DO NOTHING`,
        [key.businessId, key.connectionId, now]
      );
      return true;
    });
  }

  async isDisabled(businessId: string, connectionId: string): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `SELECT 1 FROM oim_ingress_teardowns
          WHERE business_id = $1 AND connection_id = $2`,
        [businessId, connectionId]
      );
      return result.rows.length === 1;
    });
  }
}
