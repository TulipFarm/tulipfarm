import type { Queryable, TransactionPort } from "../ports";

export interface EventEnvelope<T = unknown> {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  receivedAt: string;
  businessId: string;
  source: {
    provider: string;
    integrationId?: string;
    externalTenantId?: string;
    deliveryId?: string;
  };
  principal: { kind: string; internalId?: string; externalId?: string };
  record: { type?: string; id?: string; version?: string };
  deduplicationKey: string;
  correlationId?: string;
  causationId?: string;
  classification: string[];
  data: T;
  rawArtifactId?: string;
  rawPayloadHash?: string;
  verification: { status: "verified" | "unverified" | "failed"; method?: string };
}

export type StoreEventInput = EventEnvelope<Record<string, unknown>>;
export type EventInboxStatus = "pending" | "processed" | "quarantined";
export type OutboxStatus = "pending" | "leased" | "dispatched" | "quarantined";

export interface StoredEvent {
  id: string;
  businessId: string;
  sourceKey: string;
  deduplicationKey: string;
  status: EventInboxStatus;
  canonicalEvent: StoreEventInput;
}

export interface AcceptEventResult {
  /** `duplicate` returns the originally accepted logical event and never creates another outbox. */
  outcome: "accepted" | "duplicate";
  event: StoredEvent;
}

export interface ClaimedOutboxMessage {
  id: string;
  businessId: string;
  inboxId: string;
  topic: "event.accepted";
  payload: { inboxId: string; eventId: string };
  attempts: number;
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface ClaimOutboxOptions {
  businessId: string;
  owner: string;
  now: string;
  leaseDurationMs: number;
  limit: number;
}

export interface OutboxFailure {
  code: "handler_failed";
  evidenceRef?: string;
  maxAttempts: number;
  quarantineOwner: string;
  replayEligible: boolean;
}

export type OutboxLeaseDenialReason = "lease_not_owned";

export class OutboxLeaseError extends Error {
  readonly name = "OutboxLeaseError";

  constructor(readonly reason: OutboxLeaseDenialReason) {
    super(reason);
  }
}

export interface EventOutboxPort {
  /** Atomically lease pending or expired messages for one business. */
  claim(options: ClaimOutboxOptions): Promise<readonly ClaimedOutboxMessage[]>;
  /** Persist the consumer receipt and dispatched state in one transaction. */
  complete(
    businessId: string,
    messageId: string,
    owner: string,
    consumer: string
  ): Promise<"recorded" | "duplicate">;
  /** Release a retryable lease or create a visible quarantine record after exhaustion. */
  fail(
    businessId: string,
    messageId: string,
    owner: string,
    failure: OutboxFailure
  ): Promise<"released" | "quarantined">;
}

export type EventStorageIdSource = () => string;

export const EVENT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS events_inbox (
    id                    uuid PRIMARY KEY,
    business_id           text NOT NULL,
    source_key            text NOT NULL,
    deduplication_key     text NOT NULL,
    event_id              text NOT NULL,
    canonical_event       jsonb NOT NULL,
    raw_artifact_id       text,
    raw_payload_hash      text,
    verification_status   text NOT NULL
      CHECK (verification_status IN ('verified', 'unverified', 'failed')),
    status                text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processed', 'quarantined')),
    received_at           timestamptz NOT NULL,
    UNIQUE (business_id, id),
    UNIQUE (business_id, source_key, deduplication_key)
  )`,
  `CREATE TABLE IF NOT EXISTS outbox_messages (
    id                uuid PRIMARY KEY,
    business_id       text NOT NULL,
    inbox_id          uuid NOT NULL,
    topic             text NOT NULL CHECK (topic = 'event.accepted'),
    payload           jsonb NOT NULL,
    status            text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'leased', 'dispatched', 'quarantined')),
    attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_owner       text,
    lease_expires_at  timestamptz,
    created_at        timestamptz NOT NULL,
    dispatched_at     timestamptz,
    UNIQUE (business_id, id),
    UNIQUE (inbox_id, topic),
    FOREIGN KEY (business_id, inbox_id) REFERENCES events_inbox(business_id, id),
    CHECK (
      (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR status <> 'leased'
    )
  )`,
  `CREATE INDEX IF NOT EXISTS outbox_messages_claim_idx
    ON outbox_messages (business_id, status, lease_expires_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS consumer_receipts (
    id            uuid PRIMARY KEY,
    business_id   text NOT NULL,
    message_id    uuid NOT NULL,
    consumer      text NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, message_id, consumer),
    FOREIGN KEY (business_id, message_id) REFERENCES outbox_messages(business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS quarantine_records (
    id                uuid PRIMARY KEY,
    business_id       text NOT NULL,
    message_id        uuid NOT NULL UNIQUE,
    reason_code       text NOT NULL,
    evidence_ref      text,
    owner             text NOT NULL,
    replay_eligible   boolean NOT NULL,
    quarantined_at    timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (business_id, message_id) REFERENCES outbox_messages(business_id, id)
  )`,
];

interface InboxRow {
  id: string;
  business_id: string;
  source_key: string;
  deduplication_key: string;
  status: EventInboxStatus;
  canonical_event: StoreEventInput;
}

interface OutboxRow {
  id: string;
  business_id: string;
  inbox_id: string;
  topic: "event.accepted";
  payload: { inboxId: string; eventId: string };
  attempts: number;
  lease_owner: string;
  lease_expires_at: string | Date;
}

function sourceKey(source: StoreEventInput["source"]): string {
  return JSON.stringify([
    source.provider,
    source.integrationId ?? null,
    source.externalTenantId ?? null,
  ]);
}

function storedEvent(row: InboxRow): StoredEvent {
  return {
    id: row.id,
    businessId: row.business_id,
    sourceKey: row.source_key,
    deduplicationKey: row.deduplication_key,
    status: row.status,
    canonicalEvent: row.canonical_event,
  };
}

function claimedMessage(row: OutboxRow): ClaimedOutboxMessage {
  return {
    id: row.id,
    businessId: row.business_id,
    inboxId: row.inbox_id,
    topic: row.topic,
    payload: row.payload,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt:
      row.lease_expires_at instanceof Date
        ? row.lease_expires_at.toISOString()
        : row.lease_expires_at,
  };
}

async function existingInbox(
  transaction: Queryable,
  businessId: string,
  eventSourceKey: string,
  deduplicationKey: string
): Promise<InboxRow> {
  const result = await transaction.query<InboxRow>(
    `SELECT id, business_id, source_key, deduplication_key, status, canonical_event
       FROM events_inbox
      WHERE business_id = $1 AND source_key = $2 AND deduplication_key = $3`,
    [businessId, eventSourceKey, deduplicationKey]
  );
  const row = result.rows[0];
  if (!row) throw new Error("events_inbox_conflict_without_row");
  return row;
}

/** PostgreSQL-backed transactional intake and delivery-evidence repository. */
export class EventStore implements EventOutboxPort {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly nextId: EventStorageIdSource
  ) {}

  /** Return only after both the canonical inbox row and its outbox message commit. */
  async accept(input: StoreEventInput): Promise<AcceptEventResult> {
    return this.transactions.withTransaction(async (transaction) => {
      const id = this.nextId();
      const eventSourceKey = sourceKey(input.source);
      const inserted = await transaction.query<InboxRow>(
        `INSERT INTO events_inbox (
           id, business_id, source_key, deduplication_key, event_id, canonical_event,
           raw_artifact_id, raw_payload_hash, verification_status, received_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::timestamptz)
         ON CONFLICT (business_id, source_key, deduplication_key) DO NOTHING
         RETURNING id, business_id, source_key, deduplication_key, status, canonical_event`,
        [
          id,
          input.businessId,
          eventSourceKey,
          input.deduplicationKey,
          input.eventId,
          JSON.stringify(input),
          input.rawArtifactId ?? null,
          input.rawPayloadHash ?? null,
          input.verification.status,
          input.receivedAt,
        ]
      );
      const row = inserted.rows[0];
      if (!row) {
        return {
          outcome: "duplicate",
          event: storedEvent(
            await existingInbox(
              transaction,
              input.businessId,
              eventSourceKey,
              input.deduplicationKey
            )
          ),
        };
      }

      await transaction.query(
        `INSERT INTO outbox_messages (
           id, business_id, inbox_id, topic, payload, created_at
         ) VALUES ($1, $2, $3, 'event.accepted', $4::jsonb, $5::timestamptz)`,
        [
          this.nextId(),
          input.businessId,
          id,
          JSON.stringify({ inboxId: id, eventId: input.eventId }),
          input.receivedAt,
        ]
      );
      return { outcome: "accepted", event: storedEvent(row) };
    });
  }

  async claim(options: ClaimOutboxOptions): Promise<readonly ClaimedOutboxMessage[]> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<OutboxRow>(
        `WITH candidates AS (
           SELECT id
             FROM outbox_messages
            WHERE business_id = $1
              AND (
                status = 'pending'
                OR (status = 'leased' AND lease_expires_at <= $2::timestamptz)
              )
            ORDER BY created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $3
         )
         UPDATE outbox_messages AS messages
            SET status = 'leased',
                lease_owner = $4,
                lease_expires_at =
                  $2::timestamptz + ($5::integer * interval '1 millisecond'),
                attempts = attempts + 1
           FROM candidates
          WHERE messages.id = candidates.id
         RETURNING messages.id, messages.business_id, messages.inbox_id, messages.topic,
                   messages.payload, messages.attempts, messages.lease_owner,
                   messages.lease_expires_at`,
        [
          options.businessId,
          options.now,
          Math.max(0, options.limit),
          options.owner,
          Math.max(1, options.leaseDurationMs),
        ]
      );
      return result.rows.map(claimedMessage);
    });
  }

  async complete(
    businessId: string,
    messageId: string,
    owner: string,
    consumer: string
  ): Promise<"recorded" | "duplicate"> {
    return this.transactions.withTransaction(async (transaction) => {
      const updated = await transaction.query(
        `UPDATE outbox_messages
            SET status = 'dispatched', lease_owner = NULL, lease_expires_at = NULL,
                dispatched_at = now()
          WHERE id = $1 AND business_id = $2 AND status = 'leased' AND lease_owner = $3
          RETURNING id`,
        [messageId, businessId, owner]
      );
      if (updated.rows.length === 0) {
        const receipt = await transaction.query(
          `SELECT 1 FROM consumer_receipts
            WHERE business_id = $1 AND message_id = $2 AND consumer = $3`,
          [businessId, messageId, consumer]
        );
        if (receipt.rows.length > 0) return "duplicate";
        throw new OutboxLeaseError("lease_not_owned");
      }
      await transaction.query(
        `INSERT INTO consumer_receipts (id, business_id, message_id, consumer)
         VALUES ($1, $2, $3, $4)`,
        [this.nextId(), businessId, messageId, consumer]
      );
      return "recorded";
    });
  }

  async fail(
    businessId: string,
    messageId: string,
    owner: string,
    failure: OutboxFailure
  ): Promise<"released" | "quarantined"> {
    return this.transactions.withTransaction(async (transaction) => {
      const selected = await transaction.query<{ attempts: number }>(
        `SELECT attempts FROM outbox_messages
          WHERE id = $1 AND business_id = $2 AND status = 'leased' AND lease_owner = $3
          FOR UPDATE`,
        [messageId, businessId, owner]
      );
      const row = selected.rows[0];
      if (!row) throw new OutboxLeaseError("lease_not_owned");

      if (row.attempts < failure.maxAttempts) {
        await transaction.query(
          `UPDATE outbox_messages
              SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $1 AND business_id = $2`,
          [messageId, businessId]
        );
        return "released";
      }

      await transaction.query(
        `INSERT INTO quarantine_records (
           id, business_id, message_id, reason_code, evidence_ref, owner, replay_eligible
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          this.nextId(),
          businessId,
          messageId,
          failure.code,
          failure.evidenceRef ?? null,
          failure.quarantineOwner,
          failure.replayEligible,
        ]
      );
      await transaction.query(
        `UPDATE outbox_messages
            SET status = 'quarantined', lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1 AND business_id = $2`,
        [messageId, businessId]
      );
      return "quarantined";
    });
  }
}
