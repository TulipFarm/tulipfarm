import type {
  SoulBundleActivationRecord,
  SoulDefinitionProjection,
  SoulPublicationOutboxMessage,
  SoulPublicationRecord,
  SoulPublicationStore,
  SoulPublicationTx,
} from "./publication-store";
import { StaleActivationError } from "./publication-store";

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

/** In-memory bundle-existence probe mirrors Postgres activation joins; wire it in activation tests. */
export type BundleExistsProbe = (businessId: string, digest: string) => Promise<boolean>;

export interface InMemorySoulPublicationStoreOptions {
  readonly bundleExists?: BundleExistsProbe;
}

/** Process-local store with rollback; production state must live in the durable adapter. */
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
