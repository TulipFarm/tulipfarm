import type { TransactionPort } from "../ports";

/**
 * A delivery's lifecycle. `normalized` is a durable dispatch intent; only `dispatched` means the
 * stable event id reached the idempotent event-to-Run seam.
 */
export type WebhookDeliveryState = "accepted" | "normalized" | "dispatched" | "dead_letter";

interface WebhookClaimFence {
  readonly expectedState: "accepted" | "normalized";
  readonly expectedAttempts: number;
  readonly expectedLeaseExpiresAt: Date;
}

export interface WebhookDeliveryInput {
  readonly id: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string | null;
  /** The provider's own idempotency key, or a digest of the exact bytes when it sent none. */
  readonly deduplicationKey: string | null;
  readonly bodySha256: string;
  readonly safeHeaders: Readonly<Record<string, string>>;
  /** Opaque ciphertext. This store never sees a raw payload. */
  readonly encryptedBody: string;
  readonly eventType: string | null;
  readonly verification: string;
  readonly replayOfId?: string | null;
}

export interface PersistedWebhookDelivery {
  readonly businessId: string;
  readonly id: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string | null;
  readonly deduplicationKey: string | null;
  readonly bodySha256: string;
  readonly safeHeaders: Record<string, string>;
  readonly encryptedBody: string | null;
  readonly eventType: string | null;
  readonly verification: string;
  readonly state: WebhookDeliveryState;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly normalizedPayload: unknown;
  readonly replayOfId: string | null;
  readonly receivedAt: Date;
  readonly nextAttemptAt: Date;
  readonly leaseExpiresAt: Date | null;
  readonly rawDeletedAt: Date | null;
}

export interface RecordedDelivery {
  /** False when the provider re-sent a delivery this instance has already durably accepted. */
  readonly accepted: boolean;
  readonly delivery: PersistedWebhookDelivery;
}

export class RawPayloadDiscardedError extends Error {
  constructor(id: string) {
    super(`Delivery ${id} can no longer be replayed: its raw payload has been discarded`);
    this.name = "RawPayloadDiscardedError";
  }
}

export const WEBHOOK_INBOX_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    business_id                text NOT NULL,
    id                         text NOT NULL,
    integration_id             text NOT NULL,
    integration_major_version  integer NOT NULL CHECK (integration_major_version >= 0),
    connection_id              text,
    deduplication_key          text,
    body_sha256                text NOT NULL,
    safe_headers               jsonb NOT NULL CHECK (jsonb_typeof(safe_headers) = 'object'),
    encrypted_body             text,
    event_type                 text,
    verification               text NOT NULL,
    state                      text NOT NULL
      CHECK (state IN ('accepted', 'normalized', 'dispatched', 'dead_letter')),
    attempts                   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error                 text,
    normalized_payload         jsonb,
    replay_of_id               text,
    received_at                timestamptz NOT NULL DEFAULT now(),
    next_attempt_at            timestamptz NOT NULL DEFAULT now(),
    lease_expires_at           timestamptz,
    raw_deleted_at             timestamptz,
    PRIMARY KEY (business_id, id),
    CHECK (encrypted_body IS NOT NULL OR raw_deleted_at IS NOT NULL)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_dedup_idx
     ON webhook_deliveries (business_id, integration_id, deduplication_key)
     WHERE deduplication_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_claim_idx
     ON webhook_deliveries (state, next_attempt_at)
     WHERE state IN ('accepted', 'normalized')`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_retention_idx
     ON webhook_deliveries (received_at)
     WHERE encrypted_body IS NOT NULL`,
];

interface DeliveryRow {
  business_id: string;
  id: string;
  integration_id: string;
  integration_major_version: number;
  connection_id: string | null;
  deduplication_key: string | null;
  body_sha256: string;
  safe_headers: Record<string, string>;
  encrypted_body: string | null;
  event_type: string | null;
  verification: string;
  state: WebhookDeliveryState;
  attempts: number;
  last_error: string | null;
  normalized_payload: unknown;
  replay_of_id: string | null;
  received_at: Date;
  next_attempt_at: Date;
  lease_expires_at: Date | null;
  raw_deleted_at: Date | null;
}

function fromRow(row: DeliveryRow): PersistedWebhookDelivery {
  return {
    businessId: row.business_id,
    id: row.id,
    integrationId: row.integration_id,
    integrationMajorVersion: row.integration_major_version,
    connectionId: row.connection_id,
    deduplicationKey: row.deduplication_key,
    bodySha256: row.body_sha256,
    safeHeaders: row.safe_headers,
    encryptedBody: row.encrypted_body,
    eventType: row.event_type,
    verification: row.verification,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    normalizedPayload: row.normalized_payload ?? null,
    replayOfId: row.replay_of_id,
    receivedAt: row.received_at,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    rawDeletedAt: row.raw_deleted_at,
  };
}

const SELECT = "SELECT * FROM webhook_deliveries";

/**
 * The durable inbox. A delivery is written here before the provider is acknowledged, so an
 * acknowledgement is a promise this instance can keep across a crash.
 */
export class WebhookInboxStore {
  constructor(private readonly transactions: TransactionPort) {}

  /**
   * Persists a delivery, or returns the one already holding its deduplication key.
   *
   * The insert and the duplicate check are one statement on purpose: two concurrent copies of the
   * same provider retry must not both win a read-then-write race and run downstream work twice.
   */
  async record(businessId: string, input: WebhookDeliveryInput): Promise<RecordedDelivery> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<DeliveryRow>(
        `INSERT INTO webhook_deliveries (
           business_id, id, integration_id, integration_major_version, connection_id,
           deduplication_key, body_sha256, safe_headers, encrypted_body, event_type,
           verification, state, replay_of_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, 'accepted', $12)
         ON CONFLICT (business_id, integration_id, deduplication_key)
           WHERE deduplication_key IS NOT NULL
           DO NOTHING
         RETURNING *`,
        [
          businessId,
          input.id,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.deduplicationKey,
          input.bodySha256,
          JSON.stringify(input.safeHeaders),
          input.encryptedBody,
          input.eventType,
          input.verification,
          input.replayOfId ?? null,
        ]
      );
      const inserted = rows[0];
      if (inserted) return { accepted: true, delivery: fromRow(inserted) };

      const { rows: existing } = await transaction.query<DeliveryRow>(
        `${SELECT}
          WHERE business_id = $1 AND integration_id = $2 AND deduplication_key = $3`,
        [businessId, input.integrationId, input.deduplicationKey]
      );
      const winner = existing[0];
      if (!winner) throw new Error(`delivery ${input.id} was neither inserted nor found`);
      return { accepted: false, delivery: fromRow(winner) };
    });
  }

  /**
   * Leases up to `limit` deliveries that are due. A lease is a deadline rather than a lock, so a
   * worker that dies mid-normalization or dispatch releases its work instead of stranding it.
   */
  async claim(
    limit: number,
    leaseSeconds: number,
    now: Date = new Date()
  ): Promise<PersistedWebhookDelivery[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<DeliveryRow>(
        `UPDATE webhook_deliveries
            SET lease_expires_at = $1::timestamptz + make_interval(secs => $2),
                attempts = attempts + 1
          WHERE (business_id, id) IN (
            SELECT business_id, id FROM webhook_deliveries
             WHERE state IN ('accepted', 'normalized')
               AND next_attempt_at <= $1
               AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
             ORDER BY received_at
             LIMIT $3
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [now, leaseSeconds, limit]
      );
      return rows.map(fromRow);
    });
  }

  async markNormalized(
    businessId: string,
    id: string,
    eventType: string,
    payload: unknown,
    options: WebhookClaimFence & { readonly now?: Date }
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<{ id: string }>(
        `UPDATE webhook_deliveries
            SET state = 'normalized',
                event_type = $3,
                normalized_payload = $4::jsonb,
                attempts = 0,
                last_error = NULL,
                lease_expires_at = NULL,
                next_attempt_at = $5
          WHERE business_id = $1
            AND id = $2
            AND state = $6
            AND attempts = $7
            AND lease_expires_at = $8::timestamptz
          RETURNING id`,
        [
          businessId,
          id,
          eventType,
          JSON.stringify(payload ?? null),
          options.now ?? new Date(),
          options.expectedState,
          options.expectedAttempts,
          options.expectedLeaseExpiresAt,
        ]
      );
      return rows.length === 1;
    });
  }

  async markDispatched(businessId: string, id: string, fence: WebhookClaimFence): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<{ id: string }>(
        `UPDATE webhook_deliveries
            SET state = 'dispatched',
                last_error = NULL,
                lease_expires_at = NULL
          WHERE business_id = $1
            AND id = $2
            AND state = $3
            AND attempts = $4
            AND lease_expires_at = $5::timestamptz
          RETURNING id`,
        [businessId, id, fence.expectedState, fence.expectedAttempts, fence.expectedLeaseExpiresAt]
      );
      return rows.length === 1;
    });
  }

  /**
   * Records a failed normalization or dispatch attempt without moving it back to an earlier phase.
   * Past `maxAttempts` the delivery dead-letters rather than retrying forever.
   */
  async markFailed(
    businessId: string,
    id: string,
    error: string,
    options: WebhookClaimFence & {
      readonly maxAttempts: number;
      readonly backoffSeconds: number;
      readonly now?: Date;
    }
  ): Promise<WebhookDeliveryState | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const now = options.now ?? new Date();
      const { rows } = await transaction.query<{ state: WebhookDeliveryState }>(
        `UPDATE webhook_deliveries
            SET state = CASE WHEN attempts >= $4 THEN 'dead_letter' ELSE state END,
                last_error = $3,
                lease_expires_at = NULL,
                next_attempt_at = $5::timestamptz + make_interval(secs => $6)
          WHERE business_id = $1
            AND id = $2
            AND state = $7
            AND attempts = $8
            AND lease_expires_at = $9::timestamptz
          RETURNING state`,
        [
          businessId,
          id,
          error.slice(0, 2000),
          options.maxAttempts,
          now,
          options.backoffSeconds,
          options.expectedState,
          options.expectedAttempts,
          options.expectedLeaseExpiresAt,
        ]
      );
      return rows[0]?.state ?? null;
    });
  }

  async findById(businessId: string, id: string): Promise<PersistedWebhookDelivery | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<DeliveryRow>(
        `${SELECT} WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
      return rows[0] ? fromRow(rows[0]) : null;
    });
  }

  async listDeadLettered(businessId: string, limit = 50): Promise<PersistedWebhookDelivery[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<DeliveryRow>(
        `${SELECT}
          WHERE business_id = $1 AND state = 'dead_letter'
          ORDER BY received_at DESC
          LIMIT $2`,
        [businessId, limit]
      );
      return rows.map(fromRow);
    });
  }

  /**
   * Replays a delivery as a new one that names the original.
   *
   * It is a new row rather than a reset of the old one because the audit trail has to keep saying
   * that the provider sent this once and a person chose to run it again.
   */
  async replay(
    businessId: string,
    id: string,
    newId: string
  ): Promise<PersistedWebhookDelivery | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<DeliveryRow>(
        `${SELECT} WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
      const original = rows[0];
      if (!original) return null;
      if (original.encrypted_body === null) throw new RawPayloadDiscardedError(id);

      const { rows: replayed } = await transaction.query<DeliveryRow>(
        `INSERT INTO webhook_deliveries (
           business_id, id, integration_id, integration_major_version, connection_id,
           deduplication_key, body_sha256, safe_headers, encrypted_body, event_type,
           verification, state, replay_of_id
         ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::jsonb, $8, $9, $10, 'accepted', $11)
         RETURNING *`,
        [
          businessId,
          newId,
          original.integration_id,
          original.integration_major_version,
          original.connection_id,
          original.body_sha256,
          JSON.stringify(original.safe_headers),
          original.encrypted_body,
          original.event_type,
          original.verification,
          original.replay_of_id ?? original.id,
        ]
      );
      const row = replayed[0];
      if (!row) throw new Error(`replay of delivery ${id} produced no row`);
      return fromRow(row);
    });
  }

  /**
   * Drops raw payloads older than the retention window, keeping every hash and safe header.
   *
   * Retention has to remove the payload without removing the evidence that it arrived — otherwise
   * expiry would silently erase the audit trail along with the business data.
   */
  async discardRawPayloadsBefore(before: Date): Promise<number> {
    return this.transactions.withTransaction(async (transaction) => {
      const { rows } = await transaction.query<{ id: string }>(
        `UPDATE webhook_deliveries
            SET encrypted_body = NULL, raw_deleted_at = now()
          WHERE received_at < $1 AND encrypted_body IS NOT NULL
          RETURNING id`,
        [before]
      );
      return rows.length;
    });
  }
}
