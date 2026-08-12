import type { Queryable, TransactionPort } from "../ports";

/**
 * Soul publication persistence (SPEC §8.2 steps 13–15).
 *
 * Storage owns the mechanics; `@tulipfarm/soul` owns the publication behaviour and is the only
 * writer of these rows. Three record families back one invariant: a digest becomes active only
 * after every earlier stage committed.
 *
 * - the publication record: which changeset/commit/digest is in flight and how far it got;
 * - the authored projection: rebuildable-from-Git metadata for the definitions of one digest;
 * - the outbox: the durable handoff to the job that finishes the publication.
 *
 * Rows carry only authored identifiers, digests, and stage names — never definition content,
 * secret material, or user data.
 */

/**
 * Publication progress, in order. Each stage is committed before the next begins, so a crash
 * resumes at the recorded stage and the previously active digest is never disturbed.
 */
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

/**
 * Raised when an activation is refused because a newer publication already holds the active slot.
 * Distinct from a genuine failure: being superseded is the monotonic guard working as designed, so
 * callers must retire the publication quietly rather than burn its retry budget and dead-letter it.
 */
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
  /**
   * Unconsumed messages, oldest first. Legacy read-only path: safe only inside the still-open
   * transaction because row locks vanish at commit. New drainers should call `claimOutbox`.
   */
  pendingOutbox(max: number): Promise<readonly SoulPublicationOutboxMessage[]>;
  /**
   * Atomically claims due, unconsumed, unleased rows. Expired leases are reclaimable, and
   * concurrent claimers skip each other's locked rows rather than double-processing them.
   */
  claimOutbox(input: SoulOutboxClaimInput): Promise<readonly SoulPublicationOutboxMessage[]>;
  /** Idempotent: a message already consumed keeps its original consumer. */
  markConsumed(id: string, consumer: string): Promise<void>;

  replaceProjection(
    businessId: string,
    definitions: readonly SoulDefinitionProjection[]
  ): Promise<void>;
  listProjection(businessId: string): Promise<readonly SoulDefinitionProjection[]>;

  /**
   * Auto-activate a publication only if its publication sequence is not older than the current
   * active publication. Throws when the bundle is missing or the activation is stale.
   */
  setActiveDigest(input: SoulBundleActivationInput): Promise<void>;
  /**
   * Explicitly activate a published digest, bypassing publication-order stale protection. Rollback
   * uses this path; it still refuses unpublished or unstored digests and appends activation
   * history in the same transaction as the active alias update.
   */
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

interface ActiveRecord {
  readonly digest: string;
  readonly activationSequence: number;
  readonly activatedAt: string;
  readonly activatedByPrincipalId: string;
}

interface State {
  publications: Map<string, SoulPublicationRecord>;
  nextPublicationSequence: number;
  nextActivationSequence: number;
  outbox: SoulPublicationOutboxMessage[];
  projections: Map<string, readonly SoulDefinitionProjection[]>;
  active: Map<string, ActiveRecord>;
  activations: SoulBundleActivationRecord[];
}

function snapshot(state: State): State {
  return {
    publications: new Map(state.publications),
    nextPublicationSequence: state.nextPublicationSequence,
    nextActivationSequence: state.nextActivationSequence,
    outbox: [...state.outbox],
    projections: new Map(state.projections),
    active: new Map(state.active),
    activations: [...state.activations],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function publicationSequence(record: SoulPublicationRecord): number {
  const sequence = record.publicationSequence;
  if (sequence === undefined) throw new Error("publication_sequence_missing");
  return sequence;
}

/**
 * Probe for the one PostgreSQL constraint this store cannot hold itself: both activation paths
 * join `soul_execution_bundles`, so a digest with no stored bundle can never become active.
 *
 * Bundle rows live in a different table owned by a different port, so the in-memory double has to
 * be told. Wire it wherever activation behaviour is under test; leaving it unset makes the double
 * strictly weaker than production, which is how a revert bug hid here before.
 */
export type BundleExistsProbe = (businessId: string, digest: string) => Promise<boolean>;

export interface InMemorySoulPublicationStoreOptions {
  readonly bundleExists?: BundleExistsProbe;
}

/**
 * Process-local store with real rollback, for tests and single-process composition. The durable
 * PostgreSQL adapter implements the same {@link SoulPublicationStore} contract; authoritative
 * publication state never lives only in process memory in production.
 */
export class InMemorySoulPublicationStore implements SoulPublicationStore {
  private readonly bundleExists: BundleExistsProbe | undefined;

  constructor(options: InMemorySoulPublicationStoreOptions = {}) {
    this.bundleExists = options.bundleExists;
  }

  private state: State = {
    publications: new Map(),
    nextPublicationSequence: 1,
    nextActivationSequence: 1,
    outbox: [],
    projections: new Map(),
    active: new Map(),
    activations: [],
  };

  async withTransaction<T>(fn: (tx: SoulPublicationTx) => Promise<T>): Promise<T> {
    const rollback = snapshot(this.state);
    const staged = snapshot(this.state);
    try {
      const result = await fn(this.tx(staged));
      this.state = staged;
      return result;
    } catch (error) {
      this.state = rollback;
      throw error;
    }
  }

  private tx(state: State): SoulPublicationTx {
    const bundleExists = this.bundleExists;
    // Mirrors the JOIN soul_execution_bundles both activation paths perform in PostgreSQL.
    const requireStoredBundle = async (businessId: string, digest: string): Promise<void> => {
      if (bundleExists && !(await bundleExists(businessId, digest))) {
        throw new Error("missing_bundle_for_activation");
      }
    };
    return {
      async putPublication(record) {
        const existing = state.publications.get(record.changesetId);
        if (!existing) {
          // Mirror Postgres UNIQUE (business_id, digest): a new changeset cannot claim a digest
          // another publication already owns. Modelling this here is what stops a revert bug from
          // passing in memory while raising a unique violation in production.
          for (const other of state.publications.values()) {
            if (other.businessId === record.businessId && other.digest === record.digest) {
              throw new Error("soul_publications_business_id_digest_key");
            }
          }
        }
        const stored: SoulPublicationRecord = Object.freeze({
          ...record,
          publicationSequence:
            existing?.publicationSequence ??
            record.publicationSequence ??
            state.nextPublicationSequence,
          createdAt: existing?.createdAt ?? record.createdAt ?? nowIso(),
          nextAttemptAt: record.nextAttemptAt ?? existing?.nextAttemptAt ?? nowIso(),
        });
        if (!existing && record.publicationSequence === undefined)
          state.nextPublicationSequence += 1;
        state.publications.set(record.changesetId, stored);
      },
      async getPublication(changesetId) {
        return state.publications.get(changesetId);
      },
      async findPublicationByDigest(businessId, digest) {
        return [...state.publications.values()].find(
          (record) => record.businessId === businessId && record.digest === digest
        );
      },
      async enqueue(message) {
        if (state.outbox.some((existing) => existing.id === message.id)) return;
        state.outbox.push(Object.freeze({ ...message, createdAt: message.createdAt ?? nowIso() }));
      },
      async pendingOutbox(max) {
        return state.outbox
          .filter((message) => {
            const publication = state.publications.get(message.changesetId);
            return (
              message.consumedBy === undefined &&
              publication?.deadLetteredAt === undefined &&
              (publication?.nextAttemptAt === undefined || publication.nextAttemptAt <= nowIso())
            );
          })
          .slice(0, Math.max(0, Math.trunc(max)));
      },
      async claimOutbox(input) {
        const max = Math.max(0, Math.trunc(input.max));
        const claimed: SoulPublicationOutboxMessage[] = [];
        state.outbox = state.outbox.map((message) => {
          if (claimed.length >= max || message.consumedBy !== undefined) return message;
          const publication = state.publications.get(message.changesetId);
          if (publication?.deadLetteredAt !== undefined) return message;
          if (publication?.nextAttemptAt !== undefined && publication.nextAttemptAt > input.now) {
            return message;
          }
          if (
            message.claimedBy !== undefined &&
            message.claimLeaseExpiresAt !== undefined &&
            message.claimLeaseExpiresAt > input.now
          ) {
            return message;
          }
          const next = Object.freeze({
            ...message,
            claimedBy: input.consumer,
            claimedAt: input.now,
            claimLeaseExpiresAt: input.leaseExpiresAt,
          });
          claimed.push(next);
          return next;
        });
        return claimed;
      },
      async markConsumed(id, consumer) {
        state.outbox = state.outbox.map((message) =>
          message.id === id &&
          message.consumedBy === undefined &&
          (message.claimedBy === undefined || message.claimedBy === consumer)
            ? Object.freeze({ ...message, consumedBy: consumer, consumedAt: nowIso() })
            : message
        );
      },
      async replaceProjection(businessId, definitions) {
        state.projections.set(
          businessId,
          Object.freeze(definitions.map((definition) => Object.freeze({ ...definition })))
        );
      },
      async listProjection(businessId) {
        return state.projections.get(businessId) ?? [];
      },
      async setActiveDigest(input) {
        const publication = [...state.publications.values()].find(
          (record) => record.businessId === input.businessId && record.digest === input.digest
        );
        if (!publication) throw new Error("publication_not_found_for_activation");
        await requireStoredBundle(input.businessId, input.digest);
        const candidatePublicationSequence = publicationSequence(publication);
        const current = state.active.get(input.businessId);
        const currentPublication = current
          ? [...state.publications.values()].find(
              (record) => record.businessId === input.businessId && record.digest === current.digest
            )
          : undefined;
        const currentPublicationSequence = currentPublication
          ? publicationSequence(currentPublication)
          : undefined;
        if (
          currentPublicationSequence !== undefined &&
          currentPublicationSequence > candidatePublicationSequence
        ) {
          throw new StaleActivationError(input.digest);
        }
        activateInMemory(state, publication, input.activatedByPrincipalId);
      },
      async forceActivateDigest(input) {
        const publication = [...state.publications.values()].find(
          (record) => record.businessId === input.businessId && record.digest === input.digest
        );
        if (!publication) throw new Error("publication_not_found_for_activation");
        await requireStoredBundle(input.businessId, input.digest);
        activateInMemory(state, publication, input.activatedByPrincipalId);
      },
      async getActiveDigest(businessId) {
        return state.active.get(businessId)?.digest;
      },
      async listActivationHistory(businessId, max) {
        return state.activations
          .filter((activation) => activation.businessId === businessId)
          .sort((left, right) => right.activationSequence - left.activationSequence)
          .slice(0, Math.max(0, Math.trunc(max)));
      },
      async recordFailure(input) {
        const existing = state.publications.get(input.changesetId);
        if (!existing) return;
        state.publications.set(
          input.changesetId,
          Object.freeze({
            ...existing,
            attempts: existing.attempts + 1,
            failureCode: input.failureCode,
            nextAttemptAt: input.nextAttemptAt,
            ...(input.deadLetteredAt === undefined ? {} : { deadLetteredAt: input.deadLetteredAt }),
            ...(input.deadLetterReason === undefined
              ? {}
              : { deadLetterReason: input.deadLetterReason }),
          })
        );
      },
      async listDeadLetters(input) {
        return [...state.publications.values()]
          .filter(
            (record) =>
              record.deadLetteredAt !== undefined &&
              (input.businessId === undefined || record.businessId === input.businessId)
          )
          .sort((left, right) =>
            (right.deadLetteredAt ?? "").localeCompare(left.deadLetteredAt ?? "")
          )
          .slice(0, Math.max(0, Math.trunc(input.max)));
      },
    };
  }
}

function activateInMemory(
  state: State,
  publication: SoulPublicationRecord,
  activatedByPrincipalId: string
): void {
  const activationSequence = state.nextActivationSequence;
  state.nextActivationSequence += 1;
  const activatedAt = nowIso();
  state.active.set(publication.businessId, {
    digest: publication.digest,
    activationSequence,
    activatedAt,
    activatedByPrincipalId,
  });
  state.activations.push(
    Object.freeze({
      businessId: publication.businessId,
      activationSequence,
      digest: publication.digest,
      changesetId: publication.changesetId,
      activatedAt,
      activatedByPrincipalId,
    })
  );
}

interface PublicationRow {
  readonly changeset_id: string;
  readonly business_id: string;
  readonly commit_sha: string;
  readonly digest: string;
  readonly stage: SoulPublicationStage;
  readonly publication_sequence: string | number;
  readonly actor_principal_id: string;
  readonly created_at: string | Date;
  readonly attempts: number;
  readonly next_attempt_at: string | Date;
  readonly failure_code: string | null;
  readonly dead_lettered_at: string | Date | null;
  readonly dead_letter_reason: string | null;
}

interface ProjectionRow {
  readonly business_id: string;
  readonly digest: string;
  readonly kind: string;
  readonly definition_id: string;
  readonly slug: string;
  readonly authored_version: number;
  readonly hash: string;
}

interface OutboxRow {
  readonly id: string;
  readonly business_id: string;
  readonly changeset_id: string;
  readonly topic: string;
  readonly consumed_by: string | null;
  readonly consumed_at: string | Date | null;
  readonly claimed_by: string | null;
  readonly claimed_at: string | Date | null;
  readonly claim_lease_expires_at: string | Date | null;
  readonly created_at: string | Date;
}

interface ActivationRow {
  readonly business_id: string;
  readonly activation_sequence: string | number;
  readonly digest: string;
  readonly changeset_id: string;
  readonly activated_at: string | Date;
  readonly activated_by_principal_id: string;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function publication(row: PublicationRow): SoulPublicationRecord {
  return {
    changesetId: row.changeset_id,
    businessId: row.business_id,
    commitSha: row.commit_sha,
    digest: row.digest,
    stage: row.stage,
    publicationSequence: Number(row.publication_sequence),
    actorPrincipalId: row.actor_principal_id,
    createdAt: iso(row.created_at),
    attempts: Number(row.attempts),
    nextAttemptAt: iso(row.next_attempt_at),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.dead_lettered_at === null ? {} : { deadLetteredAt: iso(row.dead_lettered_at) }),
    ...(row.dead_letter_reason === null ? {} : { deadLetterReason: row.dead_letter_reason }),
  };
}

function projection(row: ProjectionRow): SoulDefinitionProjection {
  return {
    businessId: row.business_id,
    digest: row.digest,
    kind: row.kind,
    id: row.definition_id,
    slug: row.slug,
    authoredVersion: Number(row.authored_version),
    hash: row.hash,
  };
}

function outbox(row: OutboxRow): SoulPublicationOutboxMessage {
  return {
    id: row.id,
    businessId: row.business_id,
    changesetId: row.changeset_id,
    topic: row.topic,
    createdAt: iso(row.created_at),
    ...(row.consumed_by === null ? {} : { consumedBy: row.consumed_by }),
    ...(row.consumed_at === null ? {} : { consumedAt: iso(row.consumed_at) }),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.claimed_at === null ? {} : { claimedAt: iso(row.claimed_at) }),
    ...(row.claim_lease_expires_at === null
      ? {}
      : { claimLeaseExpiresAt: iso(row.claim_lease_expires_at) }),
  };
}

function activation(row: ActivationRow): SoulBundleActivationRecord {
  return {
    businessId: row.business_id,
    activationSequence: Number(row.activation_sequence),
    digest: row.digest,
    changesetId: row.changeset_id,
    activatedAt: iso(row.activated_at),
    activatedByPrincipalId: row.activated_by_principal_id,
  };
}

function publicationSelect(): string {
  return `SELECT changeset_id, business_id, commit_sha, digest, stage, publication_sequence,
                 actor_principal_id, created_at, attempts, next_attempt_at, failure_code,
                 dead_lettered_at, dead_letter_reason
            FROM soul_publications`;
}

function outboxSelect(): string {
  return `SELECT id, business_id, changeset_id, topic, consumed_by, consumed_at, claimed_by,
                 claimed_at, claim_lease_expires_at, created_at
            FROM soul_publication_outbox`;
}

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
        // MATERIALIZED is load-bearing: `candidate` calls the volatile nextval() and is referenced
        // three times below. Without it a planner that inlined the CTE would allocate a different
        // activation sequence per reference, desynchronising soul_active_bundles from its history.
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
      // Separating these two zero-row cases matters: no candidate means the publication or its
      // signed bundle is genuinely absent (a real failure), while a candidate that did not activate
      // means a newer publication won the monotonic guard (benign supersession).
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

/** PostgreSQL publication adapter with real transactional stage transitions and outbox writes. */
export class PgSoulPublicationStore implements SoulPublicationStore {
  constructor(private readonly transactions: TransactionPort) {}

  withTransaction<T>(fn: (tx: SoulPublicationTx) => Promise<T>): Promise<T> {
    return this.transactions.withTransaction((transaction) => fn(pgTransaction(transaction)));
  }
}
