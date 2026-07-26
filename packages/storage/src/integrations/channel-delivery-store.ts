import type { TransactionPort } from "../ports";

export type PersistedChannelDeliveryStatus =
  | "pending"
  | "confirmed"
  | "retry_wait"
  | "ambiguous"
  | "failed"
  | "revoked";

export interface PersistedChannelDeliveryAttempt {
  businessId: string;
  integrationId: string;
  routeId: string;
  idempotencyKey: string;
  provider: string;
  destination: string;
  agentId: string;
  principalId: string;
}

export interface PersistedChannelDeliveryRecord extends PersistedChannelDeliveryAttempt {
  status: PersistedChannelDeliveryStatus;
  attempts: number;
  providerMessageId?: string;
  errorCode?: string;
  nextAttemptAt?: string;
}

export interface PersistedChannelDeliveryFailure {
  status: "retry_wait" | "ambiguous" | "failed" | "revoked";
  code: string;
  retryAfterMs?: number;
}

export const CHANNEL_DELIVERY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS channel_delivery_attempts (
    business_id        text NOT NULL,
    integration_id     text NOT NULL,
    route_id           text NOT NULL,
    idempotency_key    text NOT NULL,
    provider           text NOT NULL,
    destination        text NOT NULL,
    agent_id           text NOT NULL,
    principal_id       text NOT NULL,
    status             text NOT NULL
      CHECK (status IN ('pending', 'confirmed', 'retry_wait', 'ambiguous', 'failed', 'revoked')),
    attempts           integer NOT NULL CHECK (attempts > 0),
    provider_message_id text,
    error_code         text,
    next_attempt_at    timestamptz,
    created_at         timestamptz NOT NULL,
    updated_at         timestamptz NOT NULL,
    PRIMARY KEY (business_id, integration_id, idempotency_key),
    FOREIGN KEY (business_id, integration_id) REFERENCES integrations(business_id, id),
    CHECK (
      (status = 'confirmed' AND provider_message_id IS NOT NULL)
      OR status <> 'confirmed'
    ),
    CHECK (
      (status = 'retry_wait' AND next_attempt_at IS NOT NULL)
      OR status <> 'retry_wait'
    )
  )`,
  `CREATE INDEX IF NOT EXISTS channel_delivery_retry_idx
    ON channel_delivery_attempts (business_id, status, next_attempt_at)
    WHERE status = 'retry_wait'`,
];

interface DeliveryRow {
  business_id: string;
  integration_id: string;
  route_id: string;
  idempotency_key: string;
  provider: string;
  destination: string;
  agent_id: string;
  principal_id: string;
  status: PersistedChannelDeliveryStatus;
  attempts: number;
  provider_message_id: string | null;
  error_code: string | null;
  next_attempt_at: Date | string | null;
}

const DELIVERY_COLUMNS = `business_id, integration_id, route_id, idempotency_key, provider,
  destination, agent_id, principal_id, status, attempts, provider_message_id, error_code,
  next_attempt_at`;

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function deliveryRecord(row: DeliveryRow): PersistedChannelDeliveryRecord {
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    routeId: row.route_id,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    destination: row.destination,
    agentId: row.agent_id,
    principalId: row.principal_id,
    status: row.status,
    attempts: row.attempts,
    ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.next_attempt_at === null ? {} : { nextAttemptAt: timestamp(row.next_attempt_at) }),
  };
}

/** PostgreSQL delivery ledger shared by maintained channel adapters. */
export class ChannelDeliveryStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly now: () => string
  ) {}

  async begin(attempt: PersistedChannelDeliveryAttempt): Promise<{
    outcome: "started" | "duplicate";
    record: PersistedChannelDeliveryRecord;
  }> {
    return this.transactions.withTransaction(async (transaction) => {
      const now = this.now();
      const existing = await transaction.query<DeliveryRow>(
        `SELECT ${DELIVERY_COLUMNS}
           FROM channel_delivery_attempts
          WHERE business_id = $1 AND integration_id = $2 AND idempotency_key = $3
          FOR UPDATE`,
        [attempt.businessId, attempt.integrationId, attempt.idempotencyKey]
      );
      const current = existing.rows[0];
      if (current === undefined) {
        const inserted = await transaction.query<DeliveryRow>(
          `INSERT INTO channel_delivery_attempts (
             business_id, integration_id, route_id, idempotency_key, provider, destination,
             agent_id, principal_id, status, attempts, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1,
                     $9::timestamptz, $9::timestamptz)
           RETURNING ${DELIVERY_COLUMNS}`,
          [
            attempt.businessId,
            attempt.integrationId,
            attempt.routeId,
            attempt.idempotencyKey,
            attempt.provider,
            attempt.destination,
            attempt.agentId,
            attempt.principalId,
            now,
          ]
        );
        return { outcome: "started", record: deliveryRecord(inserted.rows[0]) };
      }

      const retryDue =
        current.status === "retry_wait" &&
        current.next_attempt_at !== null &&
        new Date(timestamp(current.next_attempt_at)) <= new Date(now);
      if (!retryDue) return { outcome: "duplicate", record: deliveryRecord(current) };

      const retried = await transaction.query<DeliveryRow>(
        `UPDATE channel_delivery_attempts
            SET status = 'pending',
                attempts = attempts + 1,
                error_code = NULL,
                next_attempt_at = NULL,
                updated_at = $4::timestamptz
          WHERE business_id = $1 AND integration_id = $2 AND idempotency_key = $3
          RETURNING ${DELIVERY_COLUMNS}`,
        [attempt.businessId, attempt.integrationId, attempt.idempotencyKey, now]
      );
      return { outcome: "started", record: deliveryRecord(retried.rows[0]) };
    });
  }

  async complete(
    attempt: PersistedChannelDeliveryAttempt,
    providerMessageId: string
  ): Promise<PersistedChannelDeliveryRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<DeliveryRow>(
        `UPDATE channel_delivery_attempts
            SET status = 'confirmed',
                provider_message_id = $4,
                error_code = NULL,
                next_attempt_at = NULL,
                updated_at = $5::timestamptz
          WHERE business_id = $1
            AND integration_id = $2
            AND idempotency_key = $3
            AND status = 'pending'
          RETURNING ${DELIVERY_COLUMNS}`,
        [
          attempt.businessId,
          attempt.integrationId,
          attempt.idempotencyKey,
          providerMessageId,
          this.now(),
        ]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("channel_delivery_not_pending");
      return deliveryRecord(row);
    });
  }

  async fail(
    attempt: PersistedChannelDeliveryAttempt,
    failure: PersistedChannelDeliveryFailure
  ): Promise<PersistedChannelDeliveryRecord> {
    return this.transactions.withTransaction(async (transaction) => {
      const now = this.now();
      const nextAttemptAt =
        failure.status === "retry_wait"
          ? new Date(new Date(now).getTime() + (failure.retryAfterMs ?? 0)).toISOString()
          : null;
      const result = await transaction.query<DeliveryRow>(
        `UPDATE channel_delivery_attempts
            SET status = $4,
                error_code = $5,
                next_attempt_at = $6::timestamptz,
                updated_at = $7::timestamptz
          WHERE business_id = $1
            AND integration_id = $2
            AND idempotency_key = $3
            AND status = 'pending'
          RETURNING ${DELIVERY_COLUMNS}`,
        [
          attempt.businessId,
          attempt.integrationId,
          attempt.idempotencyKey,
          failure.status,
          failure.code,
          nextAttemptAt,
          now,
        ]
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("channel_delivery_not_pending");
      return deliveryRecord(row);
    });
  }
}
