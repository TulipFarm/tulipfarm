import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import type {
  SoulDefinitionProjection,
  SoulPublicationRecord,
  SoulPublicationStage,
  SoulPublicationStore,
} from "@tulipfarm/storage";
import {
  type BundleDefinition,
  type BundleStore,
  computeBundleDigest,
  type RuntimeBundle,
  type SignedExecutionBundle,
} from "./bundle";
import { compileExecutionBundle } from "./compiler";
import { type BundleSigner, verifyExecutionBundle } from "./signatures";
import type { Logger } from "./types";

/**
 * Publication projection and reconciliation (SPEC §8.2 steps 13–15).
 *
 * A signed bundle (AW-014) becomes the version the runtime executes only after every stage
 * committed, in this order:
 *
 * 1. `committed` — the immutable bundle is written to content-addressed storage (inert: addressed
 *    by digest, referenced by nothing), then the publication record and one outbox message commit
 *    in a single transaction. Nothing is active yet.
 * 2. `projected` — the authored metadata of that digest replaces the business projection.
 * 3. `stored`    — the bundle is confirmed present and digest-intact in bundle storage.
 * 4. `active`    — the digest becomes the one the runtime reads, and the outbox message is
 *    acknowledged with the consumer identity, in a single transaction.
 *
 * Every stage is idempotent and its own transaction, so an interruption anywhere leaves the
 * previously active digest untouched and the outbox message unconsumed: {@link
 * SoulPublicationCoordinator.drain} resumes at the recorded stage. Publication failure therefore
 * never leaves a partially active version.
 *
 * The authored projection is derived data. {@link SoulPublicationCoordinator.rebuildProjection}
 * recompiles it from the Git commit the active digest was published from and refuses to write when
 * Git no longer reproduces that digest.
 */

export const SOUL_PUBLICATION_TOPIC = "soul.publication.requested";

export type SoulPublicationErrorCode =
  | "DIGEST_MISMATCH"
  | "DIGEST_CONFLICT"
  | "BUNDLE_STORE_FAILED"
  | "BUNDLE_UNAVAILABLE"
  | "PROJECTION_FAILED"
  | "ACTIVATION_FAILED"
  | "NO_ACTIVE_VERSION"
  | "UNKNOWN_PUBLICATION";

/**
 * Deterministic, payload-safe publication failure. Carries changeset/digest identifiers only —
 * never authored content, secret references, or user data.
 */
export class SoulPublicationError extends Error {
  readonly code: SoulPublicationErrorCode;
  readonly changesetId?: string;

  constructor(
    code: SoulPublicationErrorCode,
    message: string,
    details: { changesetId?: string; cause?: unknown } = {}
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "SoulPublicationError";
    this.code = code;
    if (details.changesetId !== undefined) this.changesetId = details.changesetId;
  }
}

export interface SoulPublishRequest {
  /** The compiled, hashed, and signed bundle for the committed tree. */
  readonly bundle: SignedExecutionBundle;
}

/** Reads the authored definitions of a Soul commit — the Git side of a projection rebuild. */
export interface SoulTreeReader {
  readDefinitions(commitSha: string): Promise<readonly VersionedSchemaDocument[]>;
}

export interface SoulPublicationOutcome {
  readonly changesetId: string;
  readonly digest: string;
  readonly stage: SoulPublicationStage;
}

function projectionOf(
  businessId: string,
  digest: string,
  definitions: readonly BundleDefinition[]
): SoulDefinitionProjection[] {
  return definitions.map((definition) => ({
    businessId,
    digest,
    kind: definition.kind,
    id: definition.id,
    slug: definition.slug,
    authoredVersion: definition.authoredVersion,
    hash: definition.hash,
  }));
}

export class SoulPublicationCoordinator {
  constructor(
    private readonly store: SoulPublicationStore,
    private readonly bundles: BundleStore,
    private readonly logger: Logger
  ) {}

  /**
   * Stage 1. Store the immutable bundle, then record the publication and enqueue its outbox
   * message in one transaction. Returns without activating anything; {@link drain} finishes the
   * publication. A duplicate request for the same changeset and digest is a no-op.
   */
  async publish(request: SoulPublishRequest): Promise<void> {
    const record = request.bundle;
    const { businessId, changesetId, commitSha } = record.bundle;
    const digest = computeBundleDigest(record.bundle);
    if (digest !== record.digest) {
      throw new SoulPublicationError(
        "DIGEST_MISMATCH",
        `Soul publication: changeset ${changesetId} record digest does not cover its bundle`,
        { changesetId }
      );
    }

    // Written before the transaction on purpose: the blob is content-addressed and inert until a
    // publication record points at it, so a crash here leaves an unreachable blob, never a
    // publication that cannot find its bundle.
    try {
      await this.bundles.put(record);
    } catch (error) {
      throw new SoulPublicationError(
        `BUNDLE_STORE_FAILED`,
        `Soul publication: changeset ${changesetId} bundle could not be stored`,
        { changesetId, cause: error }
      );
    }

    await this.store.withTransaction(async (tx) => {
      const existing = await tx.getPublication(changesetId);
      if (existing) {
        if (existing.digest !== digest) {
          throw new SoulPublicationError(
            "DIGEST_CONFLICT",
            `Soul publication: changeset ${changesetId} is already published with another digest`,
            { changesetId }
          );
        }
        return;
      }
      await tx.putPublication({
        changesetId,
        businessId,
        commitSha,
        digest,
        stage: "committed",
        attempts: 0,
      });
      await tx.enqueue({
        id: `${changesetId}:publish`,
        businessId,
        changesetId,
        topic: SOUL_PUBLICATION_TOPIC,
      });
    });

    this.logger.info(
      `Soul publication: changeset ${changesetId} committed at ${digest} (awaiting projection)`
    );
  }

  /**
   * The durable job. Advances every unconsumed publication from its recorded stage to `active`.
   * Throws on the first failure with the previously active digest intact and the message still
   * unconsumed, so a later run resumes exactly where this one stopped.
   */
  async drain(consumer: string, max = 10): Promise<readonly SoulPublicationOutcome[]> {
    const messages = await this.store.withTransaction((tx) => tx.pendingOutbox(max));
    const outcomes: SoulPublicationOutcome[] = [];
    for (const message of messages) {
      outcomes.push(await this.advance(message.changesetId, consumer));
    }
    return outcomes;
  }

  /** Active digest for a business, or `undefined` before the first publication completes. */
  async activeDigest(businessId: string): Promise<string | undefined> {
    return this.store.withTransaction((tx) => tx.getActiveDigest(businessId));
  }

  /**
   * The verified bundle the runtime executes: the explicitly active digest, opened only through
   * signature verification. `undefined` when nothing is active yet.
   */
  async activeBundle(businessId: string, signer: BundleSigner): Promise<RuntimeBundle | undefined> {
    const digest = await this.activeDigest(businessId);
    if (digest === undefined) return undefined;
    const record = await this.bundles.get(digest);
    if (!record) {
      throw new SoulPublicationError(
        "BUNDLE_UNAVAILABLE",
        `Soul publication: active digest ${digest} is not present in bundle storage`
      );
    }
    return verifyExecutionBundle(record, signer);
  }

  /**
   * Rebuild the authored projection for the active version from Git. The definitions read at the
   * published commit are recompiled and must reproduce the active digest exactly; anything else
   * means Git and the active version disagree, and nothing is written.
   */
  async rebuildProjection(businessId: string, reader: SoulTreeReader): Promise<string> {
    const record = await this.store.withTransaction(async (tx) => {
      const digest = await tx.getActiveDigest(businessId);
      if (digest === undefined) {
        throw new SoulPublicationError(
          "NO_ACTIVE_VERSION",
          `Soul publication: business ${businessId} has no active version to rebuild`
        );
      }
      const found = await tx.findPublicationByDigest(businessId, digest);
      if (!found) {
        throw new SoulPublicationError(
          "UNKNOWN_PUBLICATION",
          `Soul publication: active digest ${digest} has no publication record`
        );
      }
      return found;
    });
    const documents = await reader.readDefinitions(record.commitSha);
    const bundle = compileExecutionBundle({
      businessId,
      changesetId: record.changesetId,
      commitSha: record.commitSha,
      documents,
    });
    const digest = computeBundleDigest(bundle);
    if (digest !== record.digest) {
      throw new SoulPublicationError(
        "DIGEST_MISMATCH",
        `Soul publication: commit ${record.commitSha} no longer compiles to the active digest`,
        { changesetId: record.changesetId }
      );
    }

    await this.store.withTransaction((tx) =>
      tx.replaceProjection(businessId, projectionOf(businessId, digest, bundle.definitions))
    );
    this.logger.info(
      `Soul publication: rebuilt projection for ${businessId} from commit ${record.commitSha}`
    );
    return digest;
  }

  /** Run the remaining stages for one publication. Each stage commits before the next begins. */
  private async advance(changesetId: string, consumer: string): Promise<SoulPublicationOutcome> {
    let record = await this.require(changesetId);
    try {
      if (record.stage === "committed") {
        record = await this.project(record);
      }
      if (record.stage === "projected") {
        record = await this.confirmStored(record);
      }
      if (record.stage === "stored") {
        record = await this.activate(record, consumer);
      }
    } catch (error) {
      await this.recordFailure(record, error);
      throw error;
    }
    return { changesetId, digest: record.digest, stage: record.stage };
  }

  private async project(record: SoulPublicationRecord): Promise<SoulPublicationRecord> {
    const stored = await this.bundles.get(record.digest);
    if (!stored) throw this.missingBundle(record);
    const next: SoulPublicationRecord = {
      ...record,
      stage: "projected",
      attempts: record.attempts,
    };
    try {
      await this.store.withTransaction(async (tx) => {
        await tx.replaceProjection(
          record.businessId,
          projectionOf(record.businessId, record.digest, stored.bundle.definitions)
        );
        await tx.putPublication(next);
      });
    } catch (error) {
      throw this.wrap("PROJECTION_FAILED", record, "authored projection failed", error);
    }
    this.logger.info(
      `Soul publication: changeset ${record.changesetId} projected ${stored.bundle.definitions.length} definition(s)`
    );
    return next;
  }

  /** Confirm the bundle is retrievable and intact before any digest is allowed to go active. */
  private async confirmStored(record: SoulPublicationRecord): Promise<SoulPublicationRecord> {
    const stored = await this.bundles.get(record.digest);
    if (!stored) throw this.missingBundle(record);
    if (computeBundleDigest(stored.bundle) !== record.digest) {
      throw new SoulPublicationError(
        "DIGEST_MISMATCH",
        `Soul publication: stored bundle for changeset ${record.changesetId} does not match its digest`,
        { changesetId: record.changesetId }
      );
    }
    const next: SoulPublicationRecord = { ...record, stage: "stored" };
    await this.persist(next);
    return next;
  }

  private async activate(
    record: SoulPublicationRecord,
    consumer: string
  ): Promise<SoulPublicationRecord> {
    const next: SoulPublicationRecord = { ...record, stage: "active" };
    try {
      await this.store.withTransaction(async (tx) => {
        await tx.setActiveDigest(record.businessId, record.digest);
        await tx.putPublication(next);
        await tx.markConsumed(`${record.changesetId}:publish`, consumer);
      });
    } catch (error) {
      throw this.wrap("ACTIVATION_FAILED", record, "activation failed", error);
    }
    this.logger.info(
      `Soul publication: changeset ${record.changesetId} activated digest ${record.digest}`
    );
    return next;
  }

  private async persist(record: SoulPublicationRecord): Promise<void> {
    await this.store.withTransaction((tx) => tx.putPublication(record));
  }

  private async require(changesetId: string): Promise<SoulPublicationRecord> {
    const record = await this.store.withTransaction((tx) => tx.getPublication(changesetId));
    if (!record) {
      throw new SoulPublicationError(
        "UNKNOWN_PUBLICATION",
        `Soul publication: no publication record for changeset ${changesetId}`,
        { changesetId }
      );
    }
    return record;
  }

  private async recordFailure(record: SoulPublicationRecord, error: unknown): Promise<void> {
    const failureCode = error instanceof SoulPublicationError ? error.code : "PROJECTION_FAILED";
    await this.persist({
      ...record,
      attempts: record.attempts + 1,
      failureCode,
    });
    this.logger.error(
      `Soul publication: changeset ${record.changesetId} stopped at stage ${record.stage} (${failureCode}); active version unchanged`
    );
  }

  private missingBundle(record: SoulPublicationRecord): SoulPublicationError {
    return new SoulPublicationError(
      "BUNDLE_UNAVAILABLE",
      `Soul publication: bundle ${record.digest} for changeset ${record.changesetId} is not in bundle storage`,
      { changesetId: record.changesetId }
    );
  }

  private wrap(
    code: SoulPublicationErrorCode,
    record: SoulPublicationRecord,
    what: string,
    error: unknown
  ): SoulPublicationError {
    if (error instanceof SoulPublicationError) return error;
    return new SoulPublicationError(
      code,
      `Soul publication: changeset ${record.changesetId} ${what}`,
      { changesetId: record.changesetId, cause: error }
    );
  }
}
