import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import {
  type SoulDefinitionProjection,
  type SoulPublicationRecord,
  type SoulPublicationStage,
  type SoulPublicationStore,
  StaleActivationError,
} from "@tulipfarm/storage";
import {
  type BundleDefinition,
  type BundleStore,
  type BundleVerifier,
  computeBundleDigest,
  type RuntimeBundle,
  type SignedExecutionBundle,
} from "./bundle";
import type { CommitActor } from "./commit-signing";
import type { BundleSourceFile } from "./compiler";
import { compileExecutionBundle } from "./compiler";
import type { SoulPublicationErrorCode } from "./publication-error";
import { SoulPublicationError } from "./publication-error";
import {
  LruRuntimeBundleVerificationCache,
  type RuntimeBundleVerificationCache,
} from "./runtime-bundle-verification-cache";
import { verifyExecutionBundle } from "./signatures";
import type { Logger } from "./types";

/** Publication is staged and idempotent: committed -> projected -> stored -> active. */

export const SOUL_PUBLICATION_TOPIC = "soul.publication.requested";

export type { RuntimeBundleVerificationCache } from "./runtime-bundle-verification-cache";
export {
  LruRuntimeBundleVerificationCache,
  VERIFIED_RUNTIME_BUNDLE_CACHE_MAX_ENTRIES,
} from "./runtime-bundle-verification-cache";

/**
 * Publication stages are idempotent DB/blob steps, so a short lease prevents double-processing in
 * normal operation while letting a crash retry on the same cadence as the first backoff.
 */
export const SOUL_PUBLICATION_OUTBOX_LEASE_MS = 30 * 1000;

/**
 * Five tries separates transient infrastructure failures from poison content without consuming the
 * queue forever.
 */
export const SOUL_PUBLICATION_MAX_ATTEMPTS = 5;

/** Retry quickly first, then back off to avoid hammering a broken dependency. */
export const SOUL_PUBLICATION_RETRY_BASE_DELAY_MS = 30 * 1000;

/** Cap retries so operators see steady progress instead of hour-scale invisible sleeps. */
export const SOUL_PUBLICATION_RETRY_MAX_DELAY_MS = 15 * 60 * 1000;

export type { SoulPublicationErrorCode } from "./publication-error";
export { SoulPublicationError } from "./publication-error";

export interface SoulPublishRequest {
  /** The compiled, hashed, and signed bundle for the committed tree. */
  readonly bundle: SignedExecutionBundle;
  /** The principal whose authorized Soul write produced this publication. */
  readonly actor: CommitActor;
}

/** Reads the authored definitions of a Soul commit — the Git side of a projection rebuild. */
export interface SoulTreeReader {
  readDefinitions(commitSha: string): Promise<readonly VersionedSchemaDocument[]>;
  readFiles?(commitSha: string): Promise<readonly BundleSourceFile[]>;
}

export type SoulPublicationOutcomeStatus = "advanced" | "superseded" | "failed" | "dead_lettered";

export interface SoulPublicationOutcome {
  readonly changesetId: string;
  readonly digest: string;
  readonly status: SoulPublicationOutcomeStatus;
  readonly stage: SoulPublicationStage;
  readonly latencyMs?: number;
  readonly attempts?: number;
  readonly failureCode?: SoulPublicationErrorCode;
  readonly nextAttemptAt?: string;
  readonly deadLetteredAt?: string;
  readonly deadLetterReason?: string;
}

export interface SoulPublicationCoordinatorOptions {
  readonly verifiedBundleCache?: RuntimeBundleVerificationCache;
  readonly now?: () => Date;
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
  private readonly verifiedBundleCache: RuntimeBundleVerificationCache;
  private readonly now: () => Date;

  constructor(
    private readonly store: SoulPublicationStore,
    private readonly bundles: BundleStore,
    private readonly logger: Logger,
    options: SoulPublicationCoordinatorOptions = {}
  ) {
    this.verifiedBundleCache =
      options.verifiedBundleCache ?? new LruRuntimeBundleVerificationCache();
    this.now = options.now ?? (() => new Date());
  }

  /** Store the inert bundle first, then atomically record publication plus outbox message. */
  async publish(request: SoulPublishRequest): Promise<void> {
    const record = request.bundle;
    const actorPrincipalId = request.actor.principalId;
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
        "BUNDLE_STORE_FAILED",
        `Soul publication: changeset ${changesetId} bundle could not be stored`,
        { changesetId, cause: error }
      );
    }

    // The re-activation below needs bundle-store reads, which own their own transactions. Deciding
    // inside this transaction and acting after it keeps those reads from taking a second connection
    // while this one is still held — the nesting that deadlocks a single-connection database.
    let reactivation: { businessId: string; changesetId: string; digest: string } | undefined;

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
        // Finding 3: a dead-lettered publication is filtered out of every drain claim, so the plain
        // idempotent no-op below would strand it forever. Re-publishing the same changeset is an
        // operator's explicit recovery signal: clear the terminal flag, restore a fresh retry
        // budget, and re-enqueue so drain resumes from the last stage it actually reached.
        if (existing.deadLetteredAt !== undefined) {
          await tx.putPublication({
            changesetId,
            businessId,
            commitSha,
            digest,
            stage: existing.stage,
            actorPrincipalId,
            attempts: 0,
            nextAttemptAt: this.now().toISOString(),
          });
          await tx.enqueue({
            id: `${changesetId}:publish`,
            businessId,
            changesetId,
            topic: SOUL_PUBLICATION_TOPIC,
          });
          this.logger.info(
            `Soul publication: changeset ${changesetId} re-published after dead-letter (resuming at ${existing.stage})`
          );
        }
        return;
      }

      // Finding 1: a revert reproduces an earlier tree exactly, so the compiler yields a digest
      // that a prior changeset already published. UNIQUE (business_id, digest) forbids a second
      // row, and the content-addressed bundle is unchanged — this is a re-activation of an
      // existing publication, not a new one. Reuse that row and append a forced activation event
      // (the reverted-to digest is older, so the monotonic activation guard would refuse it).
      const priorForDigest = await tx.findPublicationByDigest(businessId, digest);
      if (priorForDigest) {
        reactivation = { businessId, changesetId, digest };
        return;
      }

      await tx.putPublication({
        changesetId,
        businessId,
        commitSha,
        digest,
        stage: "committed",
        actorPrincipalId,
        attempts: 0,
        nextAttemptAt: this.now().toISOString(),
      });
      await tx.enqueue({
        id: `${changesetId}:publish`,
        businessId,
        changesetId,
        topic: SOUL_PUBLICATION_TOPIC,
      });
    });

    if (reactivation) {
      await this.ensureNonDestructiveActivation(reactivation);
      await this.store.withTransaction(async (tx) => {
        await tx.replaceProjection(
          businessId,
          projectionOf(businessId, digest, record.bundle.definitions)
        );
        await tx.forceActivateDigest({
          businessId,
          digest,
          activatedByPrincipalId: actorPrincipalId,
        });
      });
      this.logger.info(
        `Soul publication: changeset ${changesetId} re-activated existing digest ${digest}`
      );
      return;
    }

    this.logger.info(
      `Soul publication: changeset ${changesetId} committed at ${digest} (awaiting projection)`
    );
  }

  /** Durable drain: lease due outbox messages and record retries/dead letters per message. */
  async drain(consumer: string, max = 10): Promise<readonly SoulPublicationOutcome[]> {
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + SOUL_PUBLICATION_OUTBOX_LEASE_MS).toISOString();
    const messages = await this.store.withTransaction((tx) =>
      tx.claimOutbox({ consumer, max, now: nowIso, leaseExpiresAt })
    );
    const outcomes: SoulPublicationOutcome[] = [];
    for (const message of messages) {
      outcomes.push(await this.advance(message.changesetId, consumer));
    }
    return outcomes;
  }

  /**
   * Advance one publication to `active` now rather than leaving it for the background drain, and
   * report the stage reached — anything but `active` means the artifact is not live yet.
   *
   * A producer cannot wait: until the digest is active every surface still reads the previous
   * bundle. A failure leaves the outbox row alone, so an unsettled publication retries as usual.
   */
  async settle(changesetId: string, consumer: string): Promise<SoulPublicationStage> {
    const record = await this.store.withTransaction((tx) => tx.getPublication(changesetId));
    // A revert reproduces an earlier tree exactly, so `publish` re-activates that tree's existing
    // row rather than writing a second one under this changeset — there is no record to advance.
    if (record === undefined || record.stage === "active") return "active";
    return (await this.advance(changesetId, consumer)).stage;
  }

  /** Active digest for a business, or `undefined` before the first publication completes. */
  async activeDigest(businessId: string): Promise<string | undefined> {
    return this.store.withTransaction((tx) => tx.getActiveDigest(businessId));
  }

  /**
   * The verified bundle the runtime executes: the explicitly active digest, opened only through
   * signature verification. `undefined` when nothing is active yet.
   */
  async activeBundle(
    businessId: string,
    verifier: BundleVerifier
  ): Promise<RuntimeBundle | undefined> {
    const digest = await this.activeDigest(businessId);
    if (digest === undefined) return undefined;
    const cached = this.verifiedBundleCache.get(digest, verifier);
    if (cached !== undefined) return cached;
    const record = await this.bundles.get(digest);
    if (!record) {
      throw new SoulPublicationError(
        "BUNDLE_UNAVAILABLE",
        `Soul publication: active digest ${digest} is not present in bundle storage`
      );
    }
    const runtime = verifyExecutionBundle(record, verifier);
    this.verifiedBundleCache.set(digest, verifier, runtime);
    return runtime;
  }

  /** Rebuild active projection only when Git still reproduces the active digest. */
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
    const files = await reader.readFiles?.(record.commitSha);
    const bundle = compileExecutionBundle({
      businessId,
      changesetId: record.changesetId,
      commitSha: record.commitSha,
      documents,
      ...(files === undefined ? {} : { files }),
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
      if (error instanceof StaleActivationError) return this.recordSuperseded(record, consumer);
      return this.recordFailure(record, error);
    }
    return {
      changesetId,
      digest: record.digest,
      status: "advanced",
      stage: record.stage,
      ...(record.stage === "active" ? { latencyMs: publicationLatencyMs(record, this.now()) } : {}),
    };
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
      await this.ensureNonDestructiveActivation(record);
      await this.store.withTransaction(async (tx) => {
        await tx.setActiveDigest({
          businessId: record.businessId,
          digest: record.digest,
          activatedByPrincipalId: record.actorPrincipalId,
        });
        await tx.putPublication(next);
        await tx.markConsumed(`${record.changesetId}:publish`, consumer);
      });
    } catch (error) {
      if (error instanceof StaleActivationError) throw error;
      throw this.wrap("ACTIVATION_FAILED", record, "activation failed", error);
    }
    this.logger.info(
      `Soul publication: changeset ${record.changesetId} activated digest ${record.digest}`
    );
    return next;
  }

  /** Refuse replacing a non-empty active bundle with an empty one; read bundles outside tx. */
  private async ensureNonDestructiveActivation(target: {
    readonly businessId: string;
    readonly changesetId: string;
    readonly digest: string;
  }): Promise<void> {
    const incoming = await this.bundles.get(target.digest);
    if (!incoming) {
      throw new SoulPublicationError(
        "BUNDLE_UNAVAILABLE",
        `Soul publication: bundle ${target.digest} for changeset ${target.changesetId} is not in bundle storage`,
        { changesetId: target.changesetId }
      );
    }
    if (incoming.bundle.definitions.length > 0) return;
    const activeDigest = await this.store.withTransaction((tx) =>
      tx.getActiveDigest(target.businessId)
    );
    if (activeDigest === undefined) return;
    const active = await this.bundles.get(activeDigest);
    if (active && active.bundle.definitions.length === 0) return;
    throw new SoulPublicationError(
      "EMPTY_ACTIVATION_REFUSED",
      `Soul publication: changeset ${target.changesetId} would activate an empty bundle over a non-empty active version`,
      { changesetId: target.changesetId, fatal: true }
    );
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

  /** Superseded publications are consumed, not retried, after losing activation to a newer one. */
  private async recordSuperseded(
    record: SoulPublicationRecord,
    consumer: string
  ): Promise<SoulPublicationOutcome> {
    await this.store.withTransaction((tx) =>
      tx.markConsumed(`${record.changesetId}:publish`, consumer)
    );
    this.logger.info(
      `Soul publication: changeset ${record.changesetId} (digest ${record.digest}) was superseded by a newer publication; retiring without activation`
    );
    return {
      changesetId: record.changesetId,
      digest: record.digest,
      status: "superseded",
      stage: record.stage,
      attempts: record.attempts,
    };
  }

  private async recordFailure(
    record: SoulPublicationRecord,
    error: unknown
  ): Promise<SoulPublicationOutcome> {
    const failureCode = error instanceof SoulPublicationError ? error.code : "PROJECTION_FAILED";
    const attempts = record.attempts + 1;
    const now = this.now();
    // A fatal (content-deterministic) failure can never succeed on retry, so dead-letter it at once
    // instead of burning the whole attempt budget on identical failures.
    const fatal = error instanceof SoulPublicationError && error.fatal;
    const deadLettered = fatal || attempts >= SOUL_PUBLICATION_MAX_ATTEMPTS;
    const nextAttemptAt = deadLettered
      ? now.toISOString()
      : new Date(now.getTime() + retryDelayMs(attempts)).toISOString();
    const deadLetteredAt = deadLettered ? now.toISOString() : undefined;
    const deadLetterReason = deadLettered
      ? `Publication failed ${attempts} time(s) at stage ${record.stage} with ${failureCode}`
      : undefined;
    await this.store.withTransaction((tx) =>
      tx.recordFailure({
        changesetId: record.changesetId,
        failureCode,
        nextAttemptAt,
        ...(deadLetteredAt === undefined ? {} : { deadLetteredAt }),
        ...(deadLetterReason === undefined ? {} : { deadLetterReason }),
      })
    );
    this.logger.error(
      `Soul publication: changeset ${record.changesetId} stopped at stage ${record.stage} (${failureCode}); active version unchanged`
    );
    if (deadLettered) {
      return {
        changesetId: record.changesetId,
        digest: record.digest,
        status: "dead_lettered",
        stage: record.stage,
        attempts,
        failureCode,
        nextAttemptAt,
        deadLetteredAt,
        deadLetterReason,
      };
    }
    return {
      changesetId: record.changesetId,
      digest: record.digest,
      status: "failed",
      stage: record.stage,
      attempts,
      failureCode,
      nextAttemptAt,
    };
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

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    SOUL_PUBLICATION_RETRY_BASE_DELAY_MS * 2 ** exponent,
    SOUL_PUBLICATION_RETRY_MAX_DELAY_MS
  );
}

function publicationLatencyMs(record: SoulPublicationRecord, finishedAt: Date): number {
  const startedAt = record.createdAt === undefined ? Number.NaN : Date.parse(record.createdAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, finishedAt.getTime() - startedAt);
}
