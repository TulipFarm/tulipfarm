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
