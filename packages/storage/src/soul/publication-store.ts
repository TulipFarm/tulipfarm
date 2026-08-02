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
  `CREATE TABLE IF NOT EXISTS soul_publications (
    changeset_id text PRIMARY KEY CHECK (length(changeset_id) > 0),
    business_id  text NOT NULL CHECK (length(business_id) > 0),
    commit_sha   text NOT NULL CHECK (length(commit_sha) > 0),
    digest       text NOT NULL CHECK (length(digest) > 0),
    stage        text NOT NULL CHECK (stage IN (${SOUL_PUBLICATION_STAGE_SQL})),
    attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    failure_code text,
    UNIQUE (business_id, digest)
  )`,
  `CREATE TABLE IF NOT EXISTS soul_publication_outbox (
    id           text PRIMARY KEY CHECK (length(id) > 0),
    business_id  text NOT NULL CHECK (length(business_id) > 0),
    changeset_id text NOT NULL REFERENCES soul_publications(changeset_id),
    topic        text NOT NULL CHECK (length(topic) > 0),
    consumed_by  text,
    created_at   timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS soul_publication_outbox_pending_idx
    ON soul_publication_outbox (created_at, id) WHERE consumed_by IS NULL`,
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
    business_id text PRIMARY KEY CHECK (length(business_id) > 0),
    digest      text NOT NULL CHECK (length(digest) > 0)
  )`,
];

export type SoulPublicationStage = (typeof SOUL_PUBLICATION_STAGES)[number];

export interface SoulPublicationRecord {
  readonly changesetId: string;
  readonly businessId: string;
  /** The signed Soul commit the bundle was compiled from. */
  readonly commitSha: string;
  readonly digest: string;
  readonly stage: SoulPublicationStage;
  /** Durable retry counter — never a process-memory counter. */
  readonly attempts: number;
  /** Deterministic code of the last stage failure, for operator evidence. */
  readonly failureCode?: string;
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
  /** Unconsumed messages, oldest first. */
  pendingOutbox(max: number): Promise<readonly SoulPublicationOutboxMessage[]>;
  /** Idempotent: a message already consumed keeps its original consumer. */
  markConsumed(id: string, consumer: string): Promise<void>;

  replaceProjection(
    businessId: string,
    definitions: readonly SoulDefinitionProjection[]
  ): Promise<void>;
  listProjection(businessId: string): Promise<readonly SoulDefinitionProjection[]>;

  setActiveDigest(businessId: string, digest: string): Promise<void>;
  getActiveDigest(businessId: string): Promise<string | undefined>;
}

export interface SoulPublicationStore {
  /** Run `fn` in one transaction: commit when it resolves, roll back every write if it throws. */
  withTransaction<T>(fn: (tx: SoulPublicationTx) => Promise<T>): Promise<T>;
}

interface State {
  publications: Map<string, SoulPublicationRecord>;
  outbox: SoulPublicationOutboxMessage[];
  projections: Map<string, readonly SoulDefinitionProjection[]>;
  active: Map<string, string>;
}

function snapshot(state: State): State {
  return {
    publications: new Map(state.publications),
    outbox: [...state.outbox],
    projections: new Map(state.projections),
    active: new Map(state.active),
  };
}

/**
 * Process-local store with real rollback, for tests and single-process composition. The durable
 * PostgreSQL adapter implements the same {@link SoulPublicationStore} contract; authoritative
 * publication state never lives only in process memory in production.
 */
export class InMemorySoulPublicationStore implements SoulPublicationStore {
  private state: State = {
    publications: new Map(),
    outbox: [],
    projections: new Map(),
    active: new Map(),
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
    return {
      async putPublication(record) {
        state.publications.set(record.changesetId, Object.freeze({ ...record }));
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
        state.outbox.push(Object.freeze({ ...message }));
      },
      async pendingOutbox(max) {
        return state.outbox.filter((message) => message.consumedBy === undefined).slice(0, max);
      },
      async markConsumed(id, consumer) {
        state.outbox = state.outbox.map((message) =>
          message.id === id && message.consumedBy === undefined
            ? Object.freeze({ ...message, consumedBy: consumer })
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
      async setActiveDigest(businessId, digest) {
        state.active.set(businessId, digest);
      },
      async getActiveDigest(businessId) {
        return state.active.get(businessId);
      },
    };
  }
}

interface PublicationRow {
  readonly changeset_id: string;
  readonly business_id: string;
  readonly commit_sha: string;
  readonly digest: string;
  readonly stage: SoulPublicationStage;
  readonly attempts: number;
  readonly failure_code: string | null;
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

function publication(row: PublicationRow): SoulPublicationRecord {
  return {
    changesetId: row.changeset_id,
    businessId: row.business_id,
    commitSha: row.commit_sha,
    digest: row.digest,
    stage: row.stage,
    attempts: Number(row.attempts),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
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

function pgTransaction(transaction: Queryable): SoulPublicationTx {
  return {
    async putPublication(record) {
      await transaction.query(
        `INSERT INTO soul_publications (
           changeset_id, business_id, commit_sha, digest, stage, attempts, failure_code
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (changeset_id) DO UPDATE SET
           business_id = EXCLUDED.business_id,
           commit_sha = EXCLUDED.commit_sha,
           digest = EXCLUDED.digest,
           stage = EXCLUDED.stage,
           attempts = EXCLUDED.attempts,
           failure_code = EXCLUDED.failure_code`,
        [
          record.changesetId,
          record.businessId,
          record.commitSha,
          record.digest,
          record.stage,
          record.attempts,
          record.failureCode ?? null,
        ]
      );
    },
    async getPublication(changesetId) {
      const result = await transaction.query<PublicationRow>(
        `SELECT changeset_id, business_id, commit_sha, digest, stage, attempts, failure_code
           FROM soul_publications WHERE changeset_id = $1`,
        [changesetId]
      );
      const row = result.rows[0];
      return row ? publication(row) : undefined;
    },
    async findPublicationByDigest(businessId, digest) {
      const result = await transaction.query<PublicationRow>(
        `SELECT changeset_id, business_id, commit_sha, digest, stage, attempts, failure_code
           FROM soul_publications WHERE business_id = $1 AND digest = $2`,
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
      const result = await transaction.query<{
        id: string;
        business_id: string;
        changeset_id: string;
        topic: string;
        consumed_by: string | null;
      }>(
        `SELECT id, business_id, changeset_id, topic, consumed_by
           FROM soul_publication_outbox
          WHERE consumed_by IS NULL
          ORDER BY created_at, id
          LIMIT $1`,
        [Math.max(0, Math.trunc(max))]
      );
      return result.rows.map((row) => ({
        id: row.id,
        businessId: row.business_id,
        changesetId: row.changeset_id,
        topic: row.topic,
      }));
    },
    async markConsumed(id, consumer) {
      await transaction.query(
        `UPDATE soul_publication_outbox
            SET consumed_by = $2
          WHERE id = $1 AND consumed_by IS NULL`,
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
    async setActiveDigest(businessId, digest) {
      await transaction.query(
        `INSERT INTO soul_active_bundles (business_id, digest)
         VALUES ($1, $2)
         ON CONFLICT (business_id) DO UPDATE SET digest = EXCLUDED.digest`,
        [businessId, digest]
      );
    },
    async getActiveDigest(businessId) {
      const result = await transaction.query<{ digest: string }>(
        "SELECT digest FROM soul_active_bundles WHERE business_id = $1",
        [businessId]
      );
      return result.rows[0]?.digest;
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
