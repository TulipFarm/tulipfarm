import type { TransactionPort } from "../ports";

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
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS polling_ingress_due_idx
     ON polling_ingress_state (next_poll_at, lease_expires_at)`,
];

/**
 * Durable cursor and lease state for one Connection's polling ingress.
 *
 * The lease token fences a late completion from a crashed poller, so it cannot overwrite the
 * cursor persisted by the poller that reclaimed the work.
 */
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
      const { rows } = await transaction.query<{ cursor: string | null }>(
        `INSERT INTO polling_ingress_state (
           business_id, connection_id, lease_token, lease_expires_at
         ) VALUES ($1, $2, $3, $4::timestamptz + make_interval(secs => $5))
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
      const row = rows[0];
      return row === undefined ? null : { cursor: row.cursor };
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
      const { rows } = await transaction.query(
        `UPDATE polling_ingress_state
            SET cursor = $4,
                next_poll_at = $6::timestamptz + make_interval(secs => $5),
                lease_token = NULL,
                lease_expires_at = NULL
          WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3
          RETURNING connection_id`,
        [businessId, connectionId, leaseToken, cursor, intervalSeconds, now]
      );
      return rows.length === 1;
    });
  }

  async release(
    businessId: string,
    connectionId: string,
    leaseToken: string,
    retryAfterSeconds: number,
    now = new Date()
  ): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `UPDATE polling_ingress_state
            SET next_poll_at = $5::timestamptz + make_interval(secs => $4),
                lease_token = NULL,
                lease_expires_at = NULL
          WHERE business_id = $1 AND connection_id = $2 AND lease_token = $3`,
        [businessId, connectionId, leaseToken, retryAfterSeconds, now]
      );
    });
  }
}
