import { generateKeyPairSync } from "node:crypto";
import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { InMemorySoulPublicationStore, type SoulPublicationTx } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BundleError,
  type BundleSignature,
  type BundleVerifier,
  computeBundleDigest,
  InMemoryBundleStore,
} from "./bundle";
import type { CommitActor } from "./commit-signing";
import { compileExecutionBundle } from "./compiler";
import {
  LruRuntimeBundleVerificationCache,
  SOUL_PUBLICATION_MAX_ATTEMPTS,
  SOUL_PUBLICATION_OUTBOX_LEASE_MS,
  SOUL_PUBLICATION_RETRY_BASE_DELAY_MS,
  SOUL_PUBLICATION_TOPIC,
  SoulPublicationCoordinator,
  type SoulPublicationOutcome,
  type SoulTreeReader,
} from "./publication";
import {
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  signExecutionBundle,
} from "./signatures";
import type { Logger } from "./types";

const API = "tulipfarm.ai/v1";
const BUSINESS = "biz-1";
const CONSUMER = "worker-1";
const ACTOR: CommitActor = {
  principalId: "principal-1",
  name: "Publisher",
  email: "publisher@example.com",
};

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer = createEd25519BundleSigner(
  "key-1",
  privateKey.export({ format: "pem", type: "pkcs8" }).toString()
);
const verifier = createEd25519BundleVerifier([
  {
    keyId: "key-1",
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  },
]);

function doc(slug: string, spec: Record<string, unknown>): VersionedSchemaDocument {
  return {
    apiVersion: API,
    kind: "ModelProfile",
    metadata: {
      id: `id-${slug}`,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec,
  } as unknown as VersionedSchemaDocument;
}

function signedBundle(
  changesetId: string,
  commitSha: string,
  documents: VersionedSchemaDocument[]
) {
  return signedBundleForBusiness(BUSINESS, changesetId, commitSha, documents);
}

function signedBundleForBusiness(
  businessId: string,
  changesetId: string,
  commitSha: string,
  documents: VersionedSchemaDocument[]
) {
  const bundle = compileExecutionBundle({
    businessId,
    changesetId,
    commitSha,
    documents,
  });
  return signExecutionBundle(bundle, signer);
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info = (msg: string) => {
    this.lines.push(msg);
  };
  warn = (msg: string) => {
    this.lines.push(msg);
  };
  error = (msg: string) => {
    this.lines.push(msg);
  };
}

interface CountingVerifier extends BundleVerifier {
  calls(): number;
}

function countingVerifier(delegate: BundleVerifier): CountingVerifier {
  let calls = 0;
  return {
    trustedKeyIds: delegate.trustedKeyIds,
    verify(payload: string, signature: BundleSignature): boolean {
      calls += 1;
      return delegate.verify(payload, signature);
    },
    calls: () => calls,
  };
}

class MutableClock {
  private time: number;

  constructor(start: string) {
    this.time = new Date(start).getTime();
  }

  now = (): Date => new Date(this.time);

  advance(ms: number): void {
    this.time += ms;
  }
}

/** A store whose named transaction method fails once, simulating a crash mid-publication. */
function failOnce(store: InMemorySoulPublicationStore, method: keyof SoulPublicationTx): void {
  let fired = false;
  const original = store.withTransaction.bind(store);
  store.withTransaction = async <T>(fn: (tx: SoulPublicationTx) => Promise<T>): Promise<T> =>
    original(async (tx) => {
      const patched = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === method && !fired) {
            return async () => {
              fired = true;
              throw new Error("simulated crash");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return fn(patched as SoulPublicationTx);
    });
}

describe("SoulPublicationCoordinator", () => {
  let store: InMemorySoulPublicationStore;
  let bundles: InMemoryBundleStore;
  let logger: RecordingLogger;
  let coordinator: SoulPublicationCoordinator;
  let clock: MutableClock;

  const docsV1 = [doc("fast", { provider: "anthropic" })];
  const docsV2 = [doc("fast", { provider: "anthropic", temperature: 0 })];

  beforeEach(() => {
    bundles = new InMemoryBundleStore();
    // Model the PostgreSQL JOIN soul_execution_bundles that both activation paths perform, so the
    // double cannot activate a digest whose bundle was never stored. Wired to the real bundle
    // store rather than a second fake, so the two cannot drift apart.
    store = new InMemorySoulPublicationStore({
      bundleExists: async (_businessId, digest) => (await bundles.get(digest)) !== undefined,
    });
    logger = new RecordingLogger();
    clock = new MutableClock("2026-08-12T00:00:00.000Z");
    coordinator = new SoulPublicationCoordinator(store, bundles, logger, { now: clock.now });
  });

  async function publishAndDrain(changesetId: string, commitSha: string, docs = docsV1) {
    const record = signedBundle(changesetId, commitSha, docs);
    await coordinator.publish({ bundle: record, actor: ACTOR });
    await coordinator.drain(CONSUMER);
    return record;
  }

  it("does not activate a digest until every stage succeeded", async () => {
    const record = signedBundle("cs-1", "c0ffee", docsV1);

    await coordinator.publish({ bundle: record, actor: ACTOR });
    expect(await coordinator.activeDigest(BUSINESS)).toBeUndefined();

    const outcomes = await coordinator.drain(CONSUMER);

    expect(outcomes).toEqual([
      {
        changesetId: "cs-1",
        digest: record.digest,
        status: "advanced",
        stage: "active",
        latencyMs: expect.any(Number),
      },
    ]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(record.digest);
  });

  it("projects the bundle's definitions through the outbox", async () => {
    const record = await publishAndDrain("cs-1", "c0ffee");

    const projection = await store.withTransaction((tx) => tx.listProjection(BUSINESS));
    expect(projection).toEqual([
      {
        businessId: BUSINESS,
        digest: record.digest,
        kind: "ModelProfile",
        id: "id-fast",
        slug: "fast",
        authoredVersion: 1,
        hash: record.bundle.definitions[0].hash,
      },
    ]);
  });

  it("keeps the previous active version when projection crashes", async () => {
    const first = await publishAndDrain("cs-1", "c0ffee");

    const second = signedBundle("cs-2", "beef", docsV2);
    await coordinator.publish({ bundle: second, actor: ACTOR });
    failOnce(store, "replaceProjection");

    const failed = await coordinator.drain(CONSUMER);
    expect(failed).toMatchObject([
      {
        changesetId: "cs-2",
        digest: second.digest,
        status: "failed",
        stage: "committed",
        attempts: 1,
        failureCode: "PROJECTION_FAILED",
      },
    ]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(first.digest);

    // The outbox message stayed unconsumed but backs off before the durable job retries it.
    expect(await coordinator.drain(CONSUMER)).toEqual([]);
    clock.advance(SOUL_PUBLICATION_RETRY_BASE_DELAY_MS);
    const outcomes = await coordinator.drain(CONSUMER);
    expect(outcomes).toEqual([
      {
        changesetId: "cs-2",
        digest: second.digest,
        status: "advanced",
        stage: "active",
        latencyMs: expect.any(Number),
      },
    ]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(second.digest);
  });

  it("keeps the previous active version when activation crashes, then resumes", async () => {
    const first = await publishAndDrain("cs-1", "c0ffee");

    const second = signedBundle("cs-2", "beef", docsV2);
    await coordinator.publish({ bundle: second, actor: ACTOR });
    failOnce(store, "setActiveDigest");

    const failed = await coordinator.drain(CONSUMER);
    expect(failed).toMatchObject([
      {
        changesetId: "cs-2",
        digest: second.digest,
        status: "failed",
        stage: "stored",
        attempts: 1,
        failureCode: "ACTIVATION_FAILED",
      },
    ]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(first.digest);

    clock.advance(SOUL_PUBLICATION_RETRY_BASE_DELAY_MS);
    await coordinator.drain(CONSUMER);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(second.digest);
  });

  it("does not let a late older auto-publish overwrite a newer active bundle", async () => {
    const older = signedBundle("cs-1", "c0ffee", docsV1);
    const newer = signedBundle("cs-2", "beef", docsV2);
    await bundles.put(older);
    await bundles.put(newer);
    await store.withTransaction(async (tx) => {
      await tx.putPublication({
        changesetId: older.bundle.changesetId,
        businessId: BUSINESS,
        commitSha: older.bundle.commitSha,
        digest: older.digest,
        stage: "stored",
        publicationSequence: 1,
        actorPrincipalId: ACTOR.principalId,
        attempts: 0,
        nextAttemptAt: clock.now().toISOString(),
      });
      await tx.putPublication({
        changesetId: newer.bundle.changesetId,
        businessId: BUSINESS,
        commitSha: newer.bundle.commitSha,
        digest: newer.digest,
        stage: "active",
        publicationSequence: 2,
        actorPrincipalId: ACTOR.principalId,
        attempts: 0,
        nextAttemptAt: clock.now().toISOString(),
      });
      await tx.setActiveDigest({
        businessId: BUSINESS,
        digest: newer.digest,
        activatedByPrincipalId: ACTOR.principalId,
      });
      await tx.enqueue({
        id: `${older.bundle.changesetId}:publish`,
        businessId: BUSINESS,
        changesetId: older.bundle.changesetId,
        topic: SOUL_PUBLICATION_TOPIC,
      });
    });

    const outcomes = await coordinator.drain(CONSUMER);

    // Losing this race is the monotonic guard working, not a failure: every retry would lose it
    // again. It must retire as a benign terminal outcome so it never reaches the dead-letter queue.
    expect(outcomes).toEqual([
      expect.objectContaining({
        changesetId: older.bundle.changesetId,
        digest: older.digest,
        status: "superseded",
        stage: "stored",
      }),
    ]);
    expect(outcomes[0]).not.toHaveProperty("failureCode");
    expect(await coordinator.activeDigest(BUSINESS)).toBe(newer.digest);

    // The activation transaction rolled back, so the outbox row was NOT consumed by it. Unless
    // supersession consumes it explicitly the lease expires and the message is re-claimed forever.
    const stranded = await store.withTransaction(async (tx) => {
      const record = await tx.getPublication(older.bundle.changesetId);
      return {
        attempts: record?.attempts,
        deadLetteredAt: record?.deadLetteredAt,
        reclaimed: await tx.claimOutbox({
          consumer: CONSUMER,
          max: 10,
          now: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
          leaseExpiresAt: new Date(clock.now().getTime() + 61 * 60_000).toISOString(),
        }),
      };
    });
    expect(stranded.reclaimed).toEqual([]);
    expect(stranded.attempts).toBe(0);
    expect(stranded.deadLetteredAt).toBeUndefined();
  });

  // The double must be at least as strict as PostgreSQL. A weaker fake is how a revert bug hid
  // here before: it happily activated a digest that production could never have activated.
  it("refuses to activate a digest whose bundle was never stored", async () => {
    const orphan = signedBundle("cs-orphan", "commit-orphan", docsV2);
    await store.withTransaction(async (tx) => {
      await tx.putPublication({
        changesetId: orphan.bundle.changesetId,
        businessId: BUSINESS,
        commitSha: orphan.bundle.commitSha,
        digest: orphan.digest,
        stage: "stored",
        actorPrincipalId: ACTOR.principalId,
        attempts: 0,
        nextAttemptAt: clock.now().toISOString(),
      });
    });

    await expect(
      store.withTransaction((tx) =>
        tx.setActiveDigest({
          businessId: BUSINESS,
          digest: orphan.digest,
          activatedByPrincipalId: ACTOR.principalId,
        })
      )
    ).rejects.toThrow("missing_bundle_for_activation");
    await expect(
      store.withTransaction((tx) =>
        tx.forceActivateDigest({
          businessId: BUSINESS,
          digest: orphan.digest,
          activatedByPrincipalId: ACTOR.principalId,
        })
      )
    ).rejects.toThrow("missing_bundle_for_activation");
    expect(await coordinator.activeDigest(BUSINESS)).toBeUndefined();
  });

  it("fails closed and keeps the active version when the stored bundle is gone", async () => {
    const first = await publishAndDrain("cs-1", "c0ffee");

    const second = signedBundle("cs-2", "beef", docsV2);
    await coordinator.publish({ bundle: second, actor: ACTOR });
    bundles = new InMemoryBundleStore();
    coordinator = new SoulPublicationCoordinator(store, bundles, logger, { now: clock.now });

    const failed = await coordinator.drain(CONSUMER);
    expect(failed).toMatchObject([
      {
        changesetId: "cs-2",
        digest: second.digest,
        status: "failed",
        stage: "committed",
        attempts: 1,
        failureCode: "BUNDLE_UNAVAILABLE",
      },
    ]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(first.digest);
  });

  it("is idempotent under duplicate publish and duplicate delivery", async () => {
    const record = signedBundle("cs-1", "c0ffee", docsV1);

    await coordinator.publish({ bundle: record, actor: ACTOR });
    await coordinator.publish({ bundle: record, actor: ACTOR });

    const first = await coordinator.drain(CONSUMER);
    const second = await coordinator.drain(CONSUMER);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(record.digest);
  });

  it("rejects a record whose digest does not cover its bundle", async () => {
    const record = signedBundle("cs-1", "c0ffee", docsV1);

    await expect(
      coordinator.publish({ bundle: { ...record, digest: "not-the-digest" }, actor: ACTOR })
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });

    const stored = await store.withTransaction((tx) => tx.getPublication("cs-1"));
    expect(stored).toBeUndefined();
  });

  it("rejects a second publication that reuses a changeset id with another digest", async () => {
    await coordinator.publish({ bundle: signedBundle("cs-1", "c0ffee", docsV1), actor: ACTOR });

    await expect(
      coordinator.publish({ bundle: signedBundle("cs-1", "beef", docsV2), actor: ACTOR })
    ).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
  });

  it("re-activates a previously published digest when a revert reproduces it", async () => {
    // A git revert reproduces an earlier tree's exact content, so an earlier changeset already
    // published this digest. We seed that earlier publication directly — exactly the row the
    // production path would already hold — and drive the revert through the same `publish()` entry
    // point. Both seeded publications need their bundles stored, because activation joins
    // soul_execution_bundles in PostgreSQL and cannot reference a digest that was never stored.
    const reverted = signedBundle("cs-new", "commit-new", docsV1);
    const revertDigest = reverted.digest;
    const laterBundle = signedBundle("cs-b", "commit-b", docsV2);
    const activeDigest = laterBundle.digest;
    expect(activeDigest).not.toBe(revertDigest);
    await bundles.put(reverted);
    await bundles.put(laterBundle);
    await store.withTransaction(async (tx) => {
      await tx.putPublication({
        changesetId: "cs-old",
        businessId: BUSINESS,
        commitSha: "commit-old",
        digest: revertDigest,
        stage: "active",
        actorPrincipalId: ACTOR.principalId,
        attempts: 0,
        nextAttemptAt: clock.now().toISOString(),
      });
      await tx.putPublication({
        changesetId: "cs-b",
        businessId: BUSINESS,
        commitSha: "commit-b",
        digest: activeDigest,
        stage: "active",
        actorPrincipalId: ACTOR.principalId,
        attempts: 0,
        nextAttemptAt: clock.now().toISOString(),
      });
      await tx.forceActivateDigest({
        businessId: BUSINESS,
        digest: activeDigest,
        activatedByPrincipalId: ACTOR.principalId,
      });
    });
    expect(await coordinator.activeDigest(BUSINESS)).toBe(activeDigest);

    // The revert arrives under a brand-new changeset carrying the already-published digest.
    await coordinator.publish({ bundle: reverted, actor: ACTOR });

    expect(await coordinator.activeDigest(BUSINESS)).toBe(revertDigest);
    // One publication row per digest: the revert reuses cs-old's row, it does not clone it.
    const revertRow = await store.withTransaction((tx) => tx.getPublication("cs-new"));
    expect(revertRow).toBeUndefined();
    const history = await store.withTransaction((tx) => tx.listActivationHistory(BUSINESS, 10));
    expect(history[0]).toMatchObject({ digest: revertDigest, changesetId: "cs-old" });
  });

  it("refuses to activate an empty bundle over a non-empty active version", async () => {
    const first = await publishAndDrain("cs-1", "c0ffee", docsV1);

    const empty = signedBundle("cs-empty", "wiped", []);
    expect(empty.bundle.definitions).toHaveLength(0);
    await coordinator.publish({ bundle: empty, actor: ACTOR });
    const outcomes = await coordinator.drain(CONSUMER);

    expect(outcomes).toMatchObject([
      {
        changesetId: "cs-empty",
        status: "dead_lettered",
        failureCode: "EMPTY_ACTIVATION_REFUSED",
      },
    ]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(first.digest);
  });

  it("allows a first-ever empty publication on a fresh install", async () => {
    const empty = signedBundle("cs-empty", "fresh", []);
    await coordinator.publish({ bundle: empty, actor: ACTOR });
    await coordinator.drain(CONSUMER);

    expect(await coordinator.activeDigest(BUSINESS)).toBe(empty.digest);
  });

  it("recovers a dead-lettered publication when the same changeset is re-published", async () => {
    const record = signedBundle("cs-1", "c0ffee", docsV1);
    await coordinator.publish({ bundle: record, actor: ACTOR });

    // Drain against a bundle store that lacks the blob until the publication dead-letters.
    const missingBundles = new InMemoryBundleStore();
    const failing = new SoulPublicationCoordinator(store, missingBundles, logger, {
      now: clock.now,
    });
    for (let attempt = 1; attempt <= SOUL_PUBLICATION_MAX_ATTEMPTS; attempt += 1) {
      await failing.drain(CONSUMER);
      clock.advance(SOUL_PUBLICATION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
    expect(await store.withTransaction((tx) => tx.listDeadLetters({ max: 10 }))).toHaveLength(1);
    expect(await coordinator.activeDigest(BUSINESS)).toBeUndefined();

    // Re-publishing the same changeset+digest with a healthy bundle store must resurrect it.
    await coordinator.publish({ bundle: record, actor: ACTOR });
    await coordinator.drain(CONSUMER);

    expect(await coordinator.activeDigest(BUSINESS)).toBe(record.digest);
    expect(await store.withTransaction((tx) => tx.listDeadLetters({ max: 10 }))).toEqual([]);
  });

  it("rebuilds projections from Git for the active version", async () => {
    const record = await publishAndDrain("cs-1", "c0ffee");
    const before = await store.withTransaction((tx) => tx.listProjection(BUSINESS));

    // Projection rows are lost (restore from an older backup, failed migration, wiped table).
    await store.withTransaction((tx) => tx.replaceProjection(BUSINESS, []));
    expect(await store.withTransaction((tx) => tx.listProjection(BUSINESS))).toEqual([]);

    const reader: SoulTreeReader = { readDefinitions: async () => docsV1 };
    const digest = await coordinator.rebuildProjection(BUSINESS, reader);

    expect(digest).toBe(record.digest);
    expect(await store.withTransaction((tx) => tx.listProjection(BUSINESS))).toEqual(before);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(record.digest);
  });

  it("refuses to rebuild when Git no longer produces the active digest", async () => {
    await publishAndDrain("cs-1", "c0ffee");

    const reader: SoulTreeReader = { readDefinitions: async () => docsV2 };

    await expect(coordinator.rebuildProjection(BUSINESS, reader)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
    });
  });

  it("serves the active bundle only through signature verification", async () => {
    const record = await publishAndDrain("cs-1", "c0ffee");

    const runtime = await coordinator.activeBundle(BUSINESS, verifier);
    expect(runtime?.digest).toBe(record.digest);
    expect(runtime?.get("ModelProfile", "fast")?.id).toBe("id-fast");

    const otherKey = createEd25519BundleVerifier([
      {
        keyId: "key-2",
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      },
    ]);
    await expect(coordinator.activeBundle(BUSINESS, otherKey)).rejects.toThrow(BundleError);
  });

  it("has no active bundle before the first publication completes", async () => {
    expect(await coordinator.activeBundle(BUSINESS, verifier)).toBeUndefined();
  });

  it("logs stage evidence without authored content", async () => {
    await publishAndDrain("cs-1", "c0ffee", [doc("fast", { provider: "anthropic" })]);

    expect(logger.lines.length).toBeGreaterThan(0);
    for (const line of logger.lines) {
      expect(line).not.toContain("anthropic");
    }
    expect(logger.lines.join("\n")).toContain("cs-1");
  });
});

describe("digest activation ordering", () => {
  it("never exposes a digest whose bundle failed to store", async () => {
    const store = new InMemorySoulPublicationStore();
    const bundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const coordinator = new SoulPublicationCoordinator(store, bundles, logger);
    const record = signedBundle("cs-1", "c0ffee", [doc("fast", {})]);

    bundles.put = async () => {
      throw new Error("blob backend unavailable");
    };

    await expect(coordinator.publish({ bundle: record, actor: ACTOR })).rejects.toMatchObject({
      code: "BUNDLE_STORE_FAILED",
    });
    expect(await coordinator.activeDigest("biz-1")).toBeUndefined();
    expect(await store.withTransaction((tx) => tx.getPublication("cs-1"))).toBeUndefined();
  });
});

describe("verified runtime bundle cache", () => {
  it("serves a verified active digest from cache on the second read", async () => {
    const store = new InMemorySoulPublicationStore();
    const bundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const coordinator = new SoulPublicationCoordinator(store, bundles, logger);
    const record = signedBundle("cs-1", "c0ffee", [doc("fast", {})]);
    const checked = countingVerifier(verifier);

    await coordinator.publish({ bundle: record, actor: ACTOR });
    await coordinator.drain(CONSUMER);

    expect((await coordinator.activeBundle(BUSINESS, checked))?.digest).toBe(record.digest);
    expect((await coordinator.activeBundle(BUSINESS, checked))?.digest).toBe(record.digest);
    expect(checked.calls()).toBe(1);
  });

  it("misses the verified cache when the active digest changes", async () => {
    const store = new InMemorySoulPublicationStore();
    const bundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const coordinator = new SoulPublicationCoordinator(store, bundles, logger);
    const checked = countingVerifier(verifier);

    const first = signedBundle("cs-1", "c0ffee", [doc("fast", { version: 1 })]);
    await coordinator.publish({ bundle: first, actor: ACTOR });
    await coordinator.drain(CONSUMER);
    await coordinator.activeBundle(BUSINESS, checked);

    const second = signedBundle("cs-2", "beef", [doc("fast", { version: 2 })]);
    await coordinator.publish({ bundle: second, actor: ACTOR });
    await coordinator.drain(CONSUMER);
    await coordinator.activeBundle(BUSINESS, checked);

    expect(checked.calls()).toBe(2);
  });

  it("evicts the least recently used verified bundle at the configured bound", async () => {
    const store = new InMemorySoulPublicationStore();
    const bundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const coordinator = new SoulPublicationCoordinator(store, bundles, logger, {
      verifiedBundleCache: new LruRuntimeBundleVerificationCache(1),
    });
    const checked = countingVerifier(verifier);
    const first = signedBundleForBusiness("biz-1", "cs-1", "c0ffee", [doc("fast", { version: 1 })]);
    const second = signedBundleForBusiness("biz-2", "cs-2", "beef", [doc("fast", { version: 2 })]);

    await coordinator.publish({ bundle: first, actor: ACTOR });
    await coordinator.publish({ bundle: second, actor: ACTOR });
    await coordinator.drain(CONSUMER);

    await coordinator.activeBundle("biz-1", checked);
    await coordinator.activeBundle("biz-2", checked);
    await coordinator.activeBundle("biz-1", checked);

    expect(checked.calls()).toBe(3);
  });

  it("does not cache a failed verification", async () => {
    const store = new InMemorySoulPublicationStore();
    const bundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const coordinator = new SoulPublicationCoordinator(store, bundles, logger);
    const record = signedBundle("cs-1", "c0ffee", [doc("fast", {})]);
    let calls = 0;
    const failing: CountingVerifier = {
      trustedKeyIds: [record.signature.keyId],
      verify: () => {
        calls += 1;
        return false;
      },
      calls: () => calls,
    };

    await coordinator.publish({ bundle: record, actor: ACTOR });
    await coordinator.drain(CONSUMER);

    await expect(coordinator.activeBundle(BUSINESS, failing)).rejects.toThrow(BundleError);
    await expect(coordinator.activeBundle(BUSINESS, failing)).rejects.toThrow(BundleError);
    expect(failing.calls()).toBe(2);
  });
});

describe("publication outbox retries", () => {
  it("continues the claimed batch after one message fails", async () => {
    const store = new InMemorySoulPublicationStore();
    const firstBundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const clock = new MutableClock("2026-08-12T00:00:00.000Z");
    const publisher = new SoulPublicationCoordinator(store, firstBundles, logger, {
      now: clock.now,
    });
    const first = signedBundle("cs-1", "c0ffee", [doc("bad", {})]);
    const second = signedBundle("cs-2", "beef", [doc("good", {})]);

    await publisher.publish({ bundle: first, actor: ACTOR });
    await publisher.publish({ bundle: second, actor: ACTOR });
    const onlySecondBundle = new InMemoryBundleStore();
    await onlySecondBundle.put(second);
    const drainer = new SoulPublicationCoordinator(store, onlySecondBundle, logger, {
      now: clock.now,
    });

    const outcomes = await drainer.drain(CONSUMER, 2);

    expect(outcomes).toMatchObject([
      {
        changesetId: "cs-1",
        digest: first.digest,
        status: "failed",
        failureCode: "BUNDLE_UNAVAILABLE",
      },
      { changesetId: "cs-2", digest: second.digest, status: "advanced", stage: "active" },
    ]);
    expect(await drainer.activeDigest(BUSINESS)).toBe(second.digest);
  });

  it("backs off a failing message before retrying it", async () => {
    const store = new InMemorySoulPublicationStore();
    const bundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const clock = new MutableClock("2026-08-12T00:00:00.000Z");
    const coordinator = new SoulPublicationCoordinator(store, bundles, logger, { now: clock.now });
    const record = signedBundle("cs-1", "c0ffee", [doc("fast", {})]);
    await coordinator.publish({ bundle: record, actor: ACTOR });
    failOnce(store, "replaceProjection");

    const failed = await coordinator.drain(CONSUMER);
    expect(failed).toMatchObject([
      {
        changesetId: "cs-1",
        status: "failed",
        attempts: 1,
        nextAttemptAt: "2026-08-12T00:00:30.000Z",
      },
    ]);
    expect(await coordinator.drain(CONSUMER)).toEqual([]);

    clock.advance(SOUL_PUBLICATION_RETRY_BASE_DELAY_MS);
    const retried = await coordinator.drain(CONSUMER);

    expect(retried).toEqual([
      {
        changesetId: "cs-1",
        digest: record.digest,
        status: "advanced",
        stage: "active",
        latencyMs: expect.any(Number),
      },
    ]);
  });

  it("dead-letters a poison message after the bounded attempt count", async () => {
    const store = new InMemorySoulPublicationStore();
    const goodBundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const clock = new MutableClock("2026-08-12T00:00:00.000Z");
    const publisher = new SoulPublicationCoordinator(store, goodBundles, logger, {
      now: clock.now,
    });
    const record = signedBundle("cs-1", "c0ffee", [doc("fast", {})]);
    await publisher.publish({ bundle: record, actor: ACTOR });
    const missingBundles = new InMemoryBundleStore();
    const drainer = new SoulPublicationCoordinator(store, missingBundles, logger, {
      now: clock.now,
    });

    let finalOutcome: readonly SoulPublicationOutcome[] = [];
    for (let attempt = 1; attempt <= SOUL_PUBLICATION_MAX_ATTEMPTS; attempt += 1) {
      finalOutcome = await drainer.drain(CONSUMER);
      if (attempt < SOUL_PUBLICATION_MAX_ATTEMPTS) {
        expect(finalOutcome).toMatchObject([{ status: "failed", attempts: attempt }]);
        clock.advance(SOUL_PUBLICATION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }

    expect(finalOutcome).toMatchObject([
      {
        changesetId: "cs-1",
        digest: record.digest,
        status: "dead_lettered",
        attempts: SOUL_PUBLICATION_MAX_ATTEMPTS,
        failureCode: "BUNDLE_UNAVAILABLE",
      },
    ]);
    expect(await store.withTransaction((tx) => tx.listDeadLetters({ max: 10 }))).toHaveLength(1);
    clock.advance(SOUL_PUBLICATION_RETRY_BASE_DELAY_MS * 2 ** SOUL_PUBLICATION_MAX_ATTEMPTS);
    expect(await drainer.drain(CONSUMER)).toEqual([]);
  });

  it("reclaims an unconsumed message after its lease expires", async () => {
    const store = new InMemorySoulPublicationStore();
    const bundles = new InMemoryBundleStore();
    const logger = new RecordingLogger();
    const clock = new MutableClock("2026-08-12T00:00:00.000Z");
    const coordinator = new SoulPublicationCoordinator(store, bundles, logger, { now: clock.now });
    const record = signedBundle("cs-1", "c0ffee", [doc("fast", {})]);
    await coordinator.publish({ bundle: record, actor: ACTOR });
    await store.withTransaction((tx) =>
      tx.claimOutbox({
        consumer: "crashed-worker",
        max: 1,
        now: clock.now().toISOString(),
        leaseExpiresAt: new Date(
          clock.now().getTime() + SOUL_PUBLICATION_OUTBOX_LEASE_MS
        ).toISOString(),
      })
    );

    expect(await coordinator.drain(CONSUMER)).toEqual([]);

    clock.advance(SOUL_PUBLICATION_OUTBOX_LEASE_MS);
    expect(await coordinator.drain(CONSUMER)).toEqual([
      {
        changesetId: "cs-1",
        digest: record.digest,
        status: "advanced",
        stage: "active",
        latencyMs: expect.any(Number),
      },
    ]);
  });
});

it("computes the same digest the store addresses", () => {
  const record = signedBundle("cs-1", "c0ffee", [doc("fast", {})]);
  expect(computeBundleDigest(record.bundle)).toBe(record.digest);
});
