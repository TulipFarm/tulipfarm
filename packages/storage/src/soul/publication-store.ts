import type { Queryable, TransactionPort } from "../ports";
import {
  type ActivationRow,
  activation,
  type OutboxRow,
  outbox,
  outboxSelect,
  type ProjectionRow,
  type PublicationRow,
  projection,
  publication,
  publicationSelect,
} from "./publication-store-rows";

/** Soul publication stages activation with identifiers/digests only, never definitions or secrets. */

/** Ordered publication stages; crash resumes from the committed stage without disturbing active digest. */
export const SOUL_PUBLICATION_STAGES = ["committed", "projected", "stored", "active"] as const;

const SOUL_PUBLICATION_STAGE_SQL = SOUL_PUBLICATION_STAGES.map((stage) => `'${stage}'`).join(", ");

export const SOUL_PUBLICATION_STORAGE_STATEMENTS: readonly string[] = [
  "CREATE SEQUENCE IF NOT EXISTS soul_publication_sequence",
  "CREATE SEQUENCE IF NOT EXISTS soul_activation_sequence",
  `CREATE TABLE IF NOT EXISTS soul_publications (
    changeset_id          text PRIMARY KEY CHECK (length(changeset_id) > 0),
    business_id           text NOT NULL CHECK (length(business_id) > 0),
    commit_sha            text NOT NULL CHECK (length(commit_sha) > 0),
    digest                text NOT NULL CHECK (length(digest) > 0),
    stage                 text NOT NULL CHECK (stage IN (${SOUL_PUBLICATION_STAGE_SQL})),
    publication_sequence  bigint NOT NULL DEFAULT nextval('soul_publication_sequence'),
    actor_principal_id    text NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at       timestamptz NOT NULL DEFAULT now(),
    failure_code          text,
    dead_lettered_at      timestamptz,
    dead_letter_reason    text,
    UNIQUE (business_id, digest),
    CONSTRAINT soul_publications_business_publication_sequence_key
      UNIQUE (business_id, publication_sequence),
    CONSTRAINT soul_publications_publication_sequence_check CHECK (publication_sequence > 0),
    CONSTRAINT soul_publications_actor_principal_id_check CHECK (length(actor_principal_id) > 0),
    CONSTRAINT soul_publications_dead_letter_reason_check
      CHECK (dead_lettered_at IS NULL OR dead_letter_reason IS NOT NULL)
  )`,
  `CREATE INDEX IF NOT EXISTS soul_publications_retry_idx
    ON soul_publications (next_attempt_at, changeset_id) WHERE dead_lettered_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS soul_publication_outbox (
    id                      text PRIMARY KEY CHECK (length(id) > 0),
    business_id             text NOT NULL CHECK (length(business_id) > 0),
    changeset_id            text NOT NULL REFERENCES soul_publications(changeset_id),
    topic                   text NOT NULL CHECK (length(topic) > 0),
    consumed_by             text,
    consumed_at             timestamptz,
    claimed_by              text,
    claimed_at              timestamptz,
    claim_lease_expires_at  timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT soul_publication_outbox_claim_check CHECK (
      (claimed_by IS NULL AND claimed_at IS NULL AND claim_lease_expires_at IS NULL)
      OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND claim_lease_expires_at IS NOT NULL)
    ),
    CONSTRAINT soul_publication_outbox_consumed_check CHECK (
      (consumed_by IS NULL AND consumed_at IS NULL)
      OR (consumed_by IS NOT NULL AND consumed_at IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS soul_publication_outbox_pending_idx
    ON soul_publication_outbox (created_at, id) WHERE consumed_by IS NULL`,
  `CREATE INDEX IF NOT EXISTS soul_publication_outbox_claim_idx
    ON soul_publication_outbox (claim_lease_expires_at, created_at, id) WHERE consumed_by IS NULL`,
  `CREATE TABLE IF NOT EXISTS soul_definition_projections (
    business_id     text NOT NULL CHECK (length(business_id) > 0),
    digest          text NOT NULL CHECK (length(digest) > 0),
    kind            text NOT NULL CHECK (length(kind) > 0),
    definition_id   text NOT NULL CHECK (length(definition_id) > 0),
    slug            text NOT NULL CHECK (length(slug) > 0),
    authored_version integer NOT NULL CHECK (authored_version > 0),
    hash            text NOT NULL CHECK (length(hash) > 0),
    PRIMARY KEY (business_id, kind, definition_id),
    UNIQUE (business_id, kind, slug)
  )`,
  `CREATE TABLE IF NOT EXISTS soul_active_bundles (
    business_id                  text PRIMARY KEY CHECK (length(business_id) > 0),
    digest                       text NOT NULL CHECK (length(digest) > 0),
    activation_sequence          bigint NOT NULL,
    activated_at                 timestamptz NOT NULL DEFAULT now(),
    activated_by_principal_id    text NOT NULL,
    CONSTRAINT soul_active_bundles_activation_sequence_check CHECK (activation_sequence > 0),
    CONSTRAINT soul_active_bundles_activated_by_principal_id_check
      CHECK (length(activated_by_principal_id) > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS soul_bundle_activations (
    business_id                  text NOT NULL CHECK (length(business_id) > 0),
    activation_sequence          bigint NOT NULL CHECK (activation_sequence > 0),
    digest                       text NOT NULL CHECK (length(digest) > 0),
    changeset_id                 text NOT NULL REFERENCES soul_publications(changeset_id),
    activated_at                 timestamptz NOT NULL DEFAULT now(),
    activated_by_principal_id    text NOT NULL CHECK (length(activated_by_principal_id) > 0),
    PRIMARY KEY (business_id, activation_sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS soul_bundle_activations_time_idx
    ON soul_bundle_activations (business_id, activated_at DESC, activation_sequence DESC)`,
];

export type SoulPublicationStage = (typeof SOUL_PUBLICATION_STAGES)[number];

/** Stale activation means monotonic guard worked; retire quietly instead of retrying. */
export class StaleActivationError extends Error {
  constructor(readonly digest: string) {
    super(`stale_activation: ${digest} is older than the active bundle`);
    this.name = "StaleActivationError";
  }
}

export interface SoulPublicationRecord {
  readonly changesetId: string;
  readonly businessId: string;
  /** The signed Soul commit the bundle was compiled from. */
  readonly commitSha: string;
  readonly digest: string;
  readonly stage: SoulPublicationStage;
  /** Principal id of the actor whose authorized Soul write produced this publication. */
  readonly actorPrincipalId: string;
  /** Database-assigned order used to make activation monotonic. */
  readonly publicationSequence?: number;
  readonly createdAt?: string;
  /** Durable retry counter — never a process-memory counter. */
  readonly attempts: number;
  /** The earliest time this publication should be retried after a failure. */
  readonly nextAttemptAt?: string;
  /** Deterministic code of the last stage failure, for operator evidence. */
  readonly failureCode?: string;
  /** Terminal operator flag; stage still records how far the publication got. */
  readonly deadLetteredAt?: string;
  readonly deadLetterReason?: string;
}

/** One authored definition of one published digest, as projected for queries and rebuild. */
export interface SoulDefinitionProjection {
  readonly businessId: string;
  readonly digest: string;
  readonly kind: string;
  readonly id: string;
  readonly slug: string;
  readonly authoredVersion: number;
  /** Canonical hash of the authored document. */
  readonly hash: string;
}

export interface SoulPublicationOutboxMessage {
  readonly id: string;
  readonly businessId: string;
  readonly changesetId: string;
  readonly topic: string;
  /** Consumer identity, recorded before acknowledging (dependency-rules §"Data and event ownership"). */
  readonly consumedBy?: string;
  readonly consumedAt?: string;
  /** Current lease holder. A message is reclaimable after `claimLeaseExpiresAt`. */
  readonly claimedBy?: string;
  readonly claimedAt?: string;
  readonly claimLeaseExpiresAt?: string;
  readonly createdAt?: string;
}

export interface SoulOutboxClaimInput {
  readonly consumer: string;
  readonly max: number;
  /** Database-comparable ISO timestamp supplied by the coordinator for deterministic tests. */
  readonly now: string;
  /** The time after which another consumer may reclaim the row if this consumer crashes. */
  readonly leaseExpiresAt: string;
}

export interface SoulPublicationFailureInput {
  readonly changesetId: string;
  readonly failureCode: string;
  readonly nextAttemptAt: string;
  /** Set both fields to make the row terminal while preserving its last successful stage. */
  readonly deadLetteredAt?: string;
  readonly deadLetterReason?: string;
}

export interface SoulDeadLetterQuery {
  readonly businessId?: string;
  readonly max: number;
}

export interface SoulBundleActivationRecord {
  readonly businessId: string;
  readonly activationSequence: number;
  readonly digest: string;
  readonly changesetId: string;
  readonly activatedAt: string;
  readonly activatedByPrincipalId: string;
}

export interface SoulBundleActivationInput {
  readonly businessId: string;
  readonly digest: string;
  /** Principal who performed this activation event. */
  readonly activatedByPrincipalId: string;
}

/** Transaction-scoped writes. Every method here commits or rolls back with its enclosing unit. */
export interface SoulPublicationTx {
  putPublication(record: SoulPublicationRecord): Promise<void>;
  getPublication(changesetId: string): Promise<SoulPublicationRecord | undefined>;
  /** The publication that produced one digest — the commit lineage behind an active version. */
  findPublicationByDigest(
    businessId: string,
    digest: string
  ): Promise<SoulPublicationRecord | undefined>;

  enqueue(message: SoulPublicationOutboxMessage): Promise<void>;
  /** Legacy unconsumed read path; row locks are safe only inside the open transaction. */
  pendingOutbox(max: number): Promise<readonly SoulPublicationOutboxMessage[]>;
  /** Atomically claims due rows; expired leases are reclaimable and concurrent claimers skip locks. */
  claimOutbox(input: SoulOutboxClaimInput): Promise<readonly SoulPublicationOutboxMessage[]>;
  /** Idempotent: a message already consumed keeps its original consumer. */
  markConsumed(id: string, consumer: string): Promise<void>;

  replaceProjection(
    businessId: string,
    definitions: readonly SoulDefinitionProjection[]
  ): Promise<void>;
  listProjection(businessId: string): Promise<readonly SoulDefinitionProjection[]>;

  /** Auto-activates only when publication sequence is not older than the current active one. */
  setActiveDigest(input: SoulBundleActivationInput): Promise<void>;
  /** Rollback activation bypasses stale protection but still requires a published/stored digest. */
  forceActivateDigest(input: SoulBundleActivationInput): Promise<void>;
  getActiveDigest(businessId: string): Promise<string | undefined>;
  listActivationHistory(
    businessId: string,
    max: number
  ): Promise<readonly SoulBundleActivationRecord[]>;

  /** Increment attempts, set retry timing, and optionally terminally dead-letter the publication. */
  recordFailure(input: SoulPublicationFailureInput): Promise<void>;
  listDeadLetters(input: SoulDeadLetterQuery): Promise<readonly SoulPublicationRecord[]>;
}

export interface SoulPublicationStore {
  /** Run `fn` in one transaction: commit when it resolves, roll back every write if it throws. */
  withTransaction<T>(fn: (tx: SoulPublicationTx) => Promise<T>): Promise<T>;
}

export type {
  BundleExistsProbe,
  InMemorySoulPublicationStoreOptions,
} from "./publication-store-memory";
export { InMemorySoulPublicationStore } from "./publication-store-memory";

function pgTransaction(transaction: Queryable): SoulPublicationTx {
  return {
    async putPublication(record) {
      await transaction.query(
        `INSERT INTO soul_publications (
           changeset_id, business_id, commit_sha, digest, stage, actor_principal_id, attempts,
           next_attempt_at, failure_code, dead_lettered_at, dead_letter_reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()), $9, $10, $11)
         ON CONFLICT (changeset_id) DO UPDATE SET
           business_id = EXCLUDED.business_id,
           commit_sha = EXCLUDED.commit_sha,
           digest = EXCLUDED.digest,
           stage = EXCLUDED.stage,
           actor_principal_id = EXCLUDED.actor_principal_id,
           attempts = EXCLUDED.attempts,
           next_attempt_at = COALESCE($8::timestamptz, soul_publications.next_attempt_at),
           failure_code = EXCLUDED.failure_code,
           dead_lettered_at = EXCLUDED.dead_lettered_at,
           dead_letter_reason = EXCLUDED.dead_letter_reason`,
        [
          record.changesetId,
          record.businessId,
          record.commitSha,
          record.digest,
          record.stage,
          record.actorPrincipalId,
          record.attempts,
          record.nextAttemptAt ?? null,
          record.failureCode ?? null,
          record.deadLetteredAt ?? null,
          record.deadLetterReason ?? null,
        ]
      );
    },
    async getPublication(changesetId) {
      const result = await transaction.query<PublicationRow>(
        `${publicationSelect()} WHERE changeset_id = $1`,
        [changesetId]
      );
      const row = result.rows[0];
      return row ? publication(row) : undefined;
    },
    async findPublicationByDigest(businessId, digest) {
      const result = await transaction.query<PublicationRow>(
        `${publicationSelect()} WHERE business_id = $1 AND digest = $2`,
        [businessId, digest]
      );
      const row = result.rows[0];
      return row ? publication(row) : undefined;
    },
    async enqueue(message) {
      await transaction.query(
        `INSERT INTO soul_publication_outbox (id, business_id, changeset_id, topic)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [message.id, message.businessId, message.changesetId, message.topic]
      );
    },
    async pendingOutbox(max) {
      const result = await transaction.query<OutboxRow>(
        `${outboxSelect()}
          WHERE consumed_by IS NULL
            AND EXISTS (
              SELECT 1 FROM soul_publications p
               WHERE p.changeset_id = soul_publication_outbox.changeset_id
                 AND p.dead_lettered_at IS NULL
                 AND p.next_attempt_at <= now()
            )
          ORDER BY created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [Math.max(0, Math.trunc(max))]
      );
      return result.rows.map(outbox);
    },
    async claimOutbox(input) {
      const result = await transaction.query<OutboxRow>(
        `WITH claimable AS (
           SELECT o.id
             FROM soul_publication_outbox o
             JOIN soul_publications p ON p.changeset_id = o.changeset_id
            WHERE o.consumed_by IS NULL
              AND p.dead_lettered_at IS NULL
              AND p.next_attempt_at <= $2::timestamptz
              AND (o.claimed_by IS NULL OR o.claim_lease_expires_at <= $2::timestamptz)
            ORDER BY o.created_at, o.id
            LIMIT $1
            FOR UPDATE OF o SKIP LOCKED
         )
         UPDATE soul_publication_outbox o
            SET claimed_by = $3,
                claimed_at = $2::timestamptz,
                claim_lease_expires_at = $4::timestamptz
           FROM claimable
          WHERE o.id = claimable.id
          RETURNING o.id, o.business_id, o.changeset_id, o.topic, o.consumed_by, o.consumed_at,
                    o.claimed_by, o.claimed_at, o.claim_lease_expires_at, o.created_at`,
        [Math.max(0, Math.trunc(input.max)), input.now, input.consumer, input.leaseExpiresAt]
      );
      return result.rows.map(outbox);
    },
    async markConsumed(id, consumer) {
      await transaction.query(
        `UPDATE soul_publication_outbox
            SET consumed_by = $2,
                consumed_at = now()
          WHERE id = $1
            AND consumed_by IS NULL
            AND (claimed_by IS NULL OR claimed_by = $2)`,
        [id, consumer]
      );
    },
    async replaceProjection(businessId, definitions) {
      await transaction.query("DELETE FROM soul_definition_projections WHERE business_id = $1", [
        businessId,
      ]);
      for (const definition of definitions) {
        await transaction.query(
          `INSERT INTO soul_definition_projections (
             business_id, digest, kind, definition_id, slug, authored_version, hash
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            definition.businessId,
            definition.digest,
            definition.kind,
            definition.id,
            definition.slug,
            definition.authoredVersion,
            definition.hash,
          ]
        );
      }
    },
    async listProjection(businessId) {
      const result = await transaction.query<ProjectionRow>(
        `SELECT business_id, digest, kind, definition_id, slug, authored_version, hash
           FROM soul_definition_projections
          WHERE business_id = $1
          ORDER BY kind, slug`,
        [businessId]
      );
      return result.rows.map(projection);
    },
    async setActiveDigest(input) {
      const result = await transaction.query<{
        candidates: string | number;
        activated: string | number;
      }>(
        // MATERIALIZED is required so volatile nextval() allocates one activation sequence.
        `WITH candidate AS MATERIALIZED (
           SELECT p.business_id, p.digest, p.changeset_id,
                  p.publication_sequence,
                  nextval('soul_activation_sequence') AS activation_sequence,
                  $3::text AS activated_by_principal_id
             FROM soul_publications p
             JOIN soul_execution_bundles b
               ON b.business_id = p.business_id AND b.digest = p.digest
            WHERE p.business_id = $1 AND p.digest = $2
         ), upserted AS (
           INSERT INTO soul_active_bundles (
             business_id, digest, activation_sequence, activated_at, activated_by_principal_id
           )
           SELECT business_id, digest, activation_sequence, now(), activated_by_principal_id
             FROM candidate
           ON CONFLICT (business_id) DO UPDATE SET
             digest = EXCLUDED.digest,
             activation_sequence = EXCLUDED.activation_sequence,
             activated_at = EXCLUDED.activated_at,
             activated_by_principal_id = EXCLUDED.activated_by_principal_id
           WHERE COALESCE((
             SELECT p.publication_sequence
               FROM soul_publications p
              WHERE p.business_id = soul_active_bundles.business_id
                AND p.digest = soul_active_bundles.digest
           ), 0) <= (SELECT publication_sequence FROM candidate)
           RETURNING business_id, digest, activation_sequence, activated_at, activated_by_principal_id
         ), history AS (
           INSERT INTO soul_bundle_activations (
             business_id, activation_sequence, digest, changeset_id, activated_at,
             activated_by_principal_id
           )
           SELECT u.business_id, u.activation_sequence, u.digest, c.changeset_id, u.activated_at,
                  u.activated_by_principal_id
             FROM upserted u
             JOIN candidate c USING (business_id, digest)
         )
         SELECT
           (SELECT count(*) FROM candidate) AS candidates,
           (SELECT count(*) FROM upserted) AS activated`,
        [input.businessId, input.digest, input.activatedByPrincipalId]
      );
      // Distinguish absent candidates from benign stale-publication supersession.
      const row = result.rows[0];
      if (Number(row?.candidates ?? 0) === 0) throw new Error("missing_bundle_for_activation");
      if (Number(row?.activated ?? 0) === 0) throw new StaleActivationError(input.digest);
    },
    async forceActivateDigest(input) {
      const result = await transaction.query<{ activation_sequence: string | number }>(
        `WITH candidate AS (
           SELECT p.business_id, p.digest, p.changeset_id,
                  nextval('soul_activation_sequence') AS activation_sequence,
                  $3::text AS activated_by_principal_id
             FROM soul_publications p
             JOIN soul_execution_bundles b
               ON b.business_id = p.business_id AND b.digest = p.digest
            WHERE p.business_id = $1 AND p.digest = $2
         ), upserted AS (
           INSERT INTO soul_active_bundles (
             business_id, digest, activation_sequence, activated_at, activated_by_principal_id
           )
           SELECT business_id, digest, activation_sequence, now(), activated_by_principal_id
             FROM candidate
           ON CONFLICT (business_id) DO UPDATE SET
             digest = EXCLUDED.digest,
             activation_sequence = EXCLUDED.activation_sequence,
             activated_at = EXCLUDED.activated_at,
             activated_by_principal_id = EXCLUDED.activated_by_principal_id
           RETURNING business_id, digest, activation_sequence, activated_at, activated_by_principal_id
         ), history AS (
           INSERT INTO soul_bundle_activations (
             business_id, activation_sequence, digest, changeset_id, activated_at,
             activated_by_principal_id
           )
           SELECT u.business_id, u.activation_sequence, u.digest, c.changeset_id, u.activated_at,
                  u.activated_by_principal_id
             FROM upserted u
             JOIN candidate c USING (business_id, digest)
         )
         SELECT activation_sequence FROM upserted`,
        [input.businessId, input.digest, input.activatedByPrincipalId]
      );
      if (result.rows.length === 0) throw new Error("missing_bundle_activation");
    },
    async getActiveDigest(businessId) {
      const result = await transaction.query<{ digest: string }>(
        "SELECT digest FROM soul_active_bundles WHERE business_id = $1",
        [businessId]
      );
      return result.rows[0]?.digest;
    },
    async listActivationHistory(businessId, max) {
      const result = await transaction.query<ActivationRow>(
        `SELECT business_id, activation_sequence, digest, changeset_id, activated_at,
                activated_by_principal_id
           FROM soul_bundle_activations
          WHERE business_id = $1
          ORDER BY activation_sequence DESC
          LIMIT $2`,
        [businessId, Math.max(0, Math.trunc(max))]
      );
      return result.rows.map(activation);
    },
    async recordFailure(input) {
      await transaction.query(
        `UPDATE soul_publications
            SET attempts = attempts + 1,
                failure_code = $2,
                next_attempt_at = $3::timestamptz,
                dead_lettered_at = $4::timestamptz,
                dead_letter_reason = $5
          WHERE changeset_id = $1`,
        [
          input.changesetId,
          input.failureCode,
          input.nextAttemptAt,
          input.deadLetteredAt ?? null,
          input.deadLetterReason ?? null,
        ]
      );
    },
    async listDeadLetters(input) {
      const result = await transaction.query<PublicationRow>(
        `${publicationSelect()}
          WHERE dead_lettered_at IS NOT NULL
            AND ($1::text IS NULL OR business_id = $1)
          ORDER BY dead_lettered_at DESC, changeset_id
          LIMIT $2`,
        [input.businessId ?? null, Math.max(0, Math.trunc(input.max))]
      );
      return result.rows.map(publication);
    },
  };
}

/** PostgreSQL publication adapter with transactional stages and outbox writes. */
export class PgSoulPublicationStore implements SoulPublicationStore {
  constructor(private readonly transactions: TransactionPort) {}

  withTransaction<T>(fn: (tx: SoulPublicationTx) => Promise<T>): Promise<T> {
    return this.transactions.withTransaction((transaction) => fn(pgTransaction(transaction)));
  }
}
