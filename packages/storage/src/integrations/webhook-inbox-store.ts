import type { TransactionPort } from "../ports";

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
  readonly deduplicationKey: string | null;
  readonly bodySha256: string;
  readonly safeHeaders: Readonly<Record<string, string>>;
  readonly encryptedBody: string;
  readonly eventType: string | null;
  readonly verification: string;
  readonly replayOfId?: string | null;
}

export interface VerifiedWebhookDeliveryInput extends WebhookDeliveryInput {
  readonly connectionId: string;
  readonly authenticatedEvidenceDigest: string;
  readonly verification: "verified";
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
  readonly authenticatedEvidenceDigest: string | null;
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
  readonly accepted: boolean;
  readonly delivery: PersistedWebhookDelivery;
}

export class RawPayloadDiscardedError extends Error {
  constructor(id: string) {
    super(`Delivery ${id} can no longer be replayed: its raw payload has been discarded`);
    this.name = "RawPayloadDiscardedError";
  }
}

export class WebhookDeduplicationConflictError extends Error {
  constructor() {
    super("provider deduplication identity was reused for different authenticated content");
    this.name = "WebhookDeduplicationConflictError";
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
    authenticated_evidence_digest text CHECK (
      authenticated_evidence_digest IS NULL
      OR authenticated_evidence_digest ~ '^[0-9a-f]{64}$'
    ),
    state                      text NOT NULL
      CONSTRAINT webhook_deliveries_state_check
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
    FOREIGN KEY (
      business_id, connection_id, integration_id, integration_major_version
    ) REFERENCES connections (
      business_id, id, integration_id, integration_major_version
    ) ON DELETE CASCADE,
    CHECK (encrypted_body IS NOT NULL OR raw_deleted_at IS NOT NULL)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_dedup_idx
     ON webhook_deliveries (
       business_id,
       integration_id,
       integration_major_version,
       COALESCE(connection_id, ''),
       deduplication_key
     )
     WHERE deduplication_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_verified_evidence_idx
     ON webhook_deliveries (
       business_id,
       integration_id,
       integration_major_version,
       COALESCE(connection_id, ''),
       authenticated_evidence_digest
     )
     WHERE authenticated_evidence_digest IS NOT NULL`,
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
  authenticated_evidence_digest: string | null;
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
    authenticatedEvidenceDigest: row.authenticated_evidence_digest,
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

export class WebhookInboxStore {
  constructor(private readonly transactions: TransactionPort) {}

  async record(businessId: string, input: WebhookDeliveryInput): Promise<RecordedDelivery> {
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<DeliveryRow>(
        `INSERT INTO webhook_deliveries (
           business_id, id, integration_id, integration_major_version, connection_id,
           deduplication_key, body_sha256, safe_headers, encrypted_body, event_type,
           verification, state, replay_of_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, 'accepted', $12)
         ON CONFLICT (
           business_id,
           integration_id,
           integration_major_version,
           (COALESCE(connection_id, '')),
           deduplication_key
         ) WHERE deduplication_key IS NOT NULL
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
      const row = inserted.rows[0];
      if (row !== undefined) return { accepted: true, delivery: fromRow(row) };

      const existing = await transaction.query<DeliveryRow>(
        `${SELECT}
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id IS NOT DISTINCT FROM $4
            AND deduplication_key = $5`,
        [
          businessId,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.deduplicationKey,
        ]
      );
      const winner = existing.rows[0];
      if (winner === undefined) {
        throw new Error(`delivery ${input.id} was neither inserted nor found`);
      }
      return { accepted: false, delivery: fromRow(winner) };
    });
  }

  async recordVerified(
    businessId: string,
    input: VerifiedWebhookDeliveryInput
  ): Promise<RecordedDelivery> {
    if (
      input.connectionId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.authenticatedEvidenceDigest)
    ) {
      throw new Error("invalid_authenticated_webhook_evidence_digest");
    }
    return this.transactions.withTransaction(async (transaction) => {
      const inserted = await transaction.query<DeliveryRow>(
        `INSERT INTO webhook_deliveries (
           business_id, id, integration_id, integration_major_version, connection_id,
           deduplication_key, body_sha256, safe_headers, encrypted_body, event_type,
           verification, authenticated_evidence_digest, state, replay_of_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, 'accepted', $13
         )
         ON CONFLICT DO NOTHING
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
          input.authenticatedEvidenceDigest,
          input.replayOfId ?? null,
        ]
      );
      const row = inserted.rows[0];
      if (row !== undefined) return { accepted: true, delivery: fromRow(row) };

      const authenticated = await transaction.query<DeliveryRow>(
        `${SELECT}
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id IS NOT DISTINCT FROM $4
            AND authenticated_evidence_digest = $5`,
        [
          businessId,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.authenticatedEvidenceDigest,
        ]
      );
      const authenticatedWinner = authenticated.rows[0];
      if (authenticatedWinner !== undefined) {
        if (authenticatedWinner.body_sha256 !== input.bodySha256) {
          throw new WebhookDeduplicationConflictError();
        }
        return { accepted: false, delivery: fromRow(authenticatedWinner) };
      }

      if (input.deduplicationKey === null) {
        throw new Error("verified_webhook_conflict_without_matching_authenticated_evidence");
      }
      const providerIdentity = await transaction.query<DeliveryRow>(
        `${SELECT}
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id IS NOT DISTINCT FROM $4
            AND deduplication_key = $5`,
        [
          businessId,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.deduplicationKey,
        ]
      );
      const providerWinner = providerIdentity.rows[0];
      if (providerWinner === undefined) {
        throw new Error("verified_webhook_conflict_without_matching_authenticated_evidence");
      }
      if (providerWinner.body_sha256 !== input.bodySha256) {
        throw new WebhookDeduplicationConflictError();
      }
      if (providerWinner.authenticated_evidence_digest !== null) {
        return { accepted: false, delivery: fromRow(providerWinner) };
      }

      const upgraded = await transaction.query<DeliveryRow>(
        `UPDATE webhook_deliveries
            SET authenticated_evidence_digest = $3,
                verification = 'verified'
          WHERE business_id = $1
            AND id = $2
            AND authenticated_evidence_digest IS NULL
          RETURNING *`,
        [businessId, providerWinner.id, input.authenticatedEvidenceDigest]
      );
      const winner = upgraded.rows[0];
      if (winner !== undefined) {
        return { accepted: false, delivery: fromRow(winner) };
      }

      const concurrentEvidence = await transaction.query<DeliveryRow>(
        `${SELECT}
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id IS NOT DISTINCT FROM $4
            AND authenticated_evidence_digest = $5`,
        [
          businessId,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.authenticatedEvidenceDigest,
        ]
      );
      const concurrentProvider = await transaction.query<DeliveryRow>(
        `${SELECT}
          WHERE business_id = $1
            AND integration_id = $2
            AND integration_major_version = $3
            AND connection_id IS NOT DISTINCT FROM $4
            AND deduplication_key = $5`,
        [
          businessId,
          input.integrationId,
          input.integrationMajorVersion,
          input.connectionId,
          input.deduplicationKey,
        ]
      );
      const concurrentWinner = concurrentEvidence.rows[0] ?? concurrentProvider.rows[0];
      if (
        concurrentWinner === undefined ||
        concurrentWinner.authenticated_evidence_digest === null
      ) {
        throw new Error("verified_webhook_legacy_upgrade_lost");
      }
      if (concurrentWinner.body_sha256 !== input.bodySha256) {
        throw new WebhookDeduplicationConflictError();
      }
      return { accepted: false, delivery: fromRow(concurrentWinner) };
    });
  }

  async claim(
    limit: number,
    leaseSeconds: number,
    now = new Date()
  ): Promise<PersistedWebhookDelivery[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<DeliveryRow>(
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
      return result.rows.map(fromRow);
    });
  }

  async markNormalized(
    businessId: string,
    id: string,
    eventType: string,
    payload: unknown,
    options: WebhookClaimFence & { readonly now?: Date }
  ): Promise<boolean> {
    return this.fencedUpdate(
      businessId,
      id,
      options,
      `state = 'normalized',
       event_type = $6,
       normalized_payload = $7::jsonb,
       attempts = 0,
       last_error = NULL,
       lease_expires_at = NULL,
       next_attempt_at = $8`,
      [eventType, JSON.stringify(payload ?? null), options.now ?? new Date()]
    );
  }

  async markDispatched(businessId: string, id: string, fence: WebhookClaimFence): Promise<boolean> {
    return this.fencedUpdate(
      businessId,
      id,
      fence,
      "state = 'dispatched', last_error = NULL, lease_expires_at = NULL",
      []
    );
  }

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
      const result = await transaction.query<{ state: WebhookDeliveryState }>(
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
          options.now ?? new Date(),
          options.backoffSeconds,
          options.expectedState,
          options.expectedAttempts,
          options.expectedLeaseExpiresAt,
        ]
      );
      return result.rows[0]?.state ?? null;
    });
  }

  async findById(businessId: string, id: string): Promise<PersistedWebhookDelivery | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<DeliveryRow>(
        `${SELECT} WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
      return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
    });
  }

  async listDeadLettered(businessId: string, limit = 50): Promise<PersistedWebhookDelivery[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<DeliveryRow>(
        `${SELECT}
          WHERE business_id = $1 AND state = 'dead_letter'
          ORDER BY received_at DESC
          LIMIT $2`,
        [businessId, limit]
      );
      return result.rows.map(fromRow);
    });
  }

  async replay(
    businessId: string,
    id: string,
    newId: string
  ): Promise<PersistedWebhookDelivery | null> {
    return this.transactions.withTransaction(async (transaction) => {
      const originalResult = await transaction.query<DeliveryRow>(
        `${SELECT} WHERE business_id = $1 AND id = $2`,
        [businessId, id]
      );
      const original = originalResult.rows[0];
      if (original === undefined) return null;
      if (original.encrypted_body === null) throw new RawPayloadDiscardedError(id);
      const replayed = await transaction.query<DeliveryRow>(
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
      const row = replayed.rows[0];
      if (row === undefined) throw new Error(`replay of delivery ${id} produced no row`);
      return fromRow(row);
    });
  }

  async discardRawPayloadsBefore(before: Date): Promise<number> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE webhook_deliveries
            SET encrypted_body = NULL, raw_deleted_at = now()
          WHERE received_at < $1 AND encrypted_body IS NOT NULL
          RETURNING id`,
        [before]
      );
      return result.rows.length;
    });
  }

  private async fencedUpdate(
    businessId: string,
    id: string,
    fence: WebhookClaimFence,
    assignments: string,
    extraParams: readonly unknown[]
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE webhook_deliveries
            SET ${assignments}
          WHERE business_id = $1
            AND id = $2
            AND state = $3
            AND attempts = $4
            AND lease_expires_at = $5::timestamptz
          RETURNING id`,
        [
          businessId,
          id,
          fence.expectedState,
          fence.expectedAttempts,
          fence.expectedLeaseExpiresAt,
          ...extraParams,
        ]
      );
      return result.rows.length === 1;
    });
  }
}
