import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { InMemorySoulPublicationStore, type SoulPublicationTx } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { BundleError, computeBundleDigest, InMemoryBundleStore } from "./bundle";
import { compileExecutionBundle } from "./compiler";
import {
  SoulPublicationCoordinator,
  SoulPublicationError,
  type SoulTreeReader,
} from "./publication";
import { createHmacBundleSigner, signExecutionBundle } from "./signatures";
import type { Logger } from "./types";

const API = "tulipfarm.ai/v1";
const BUSINESS = "biz-1";
const CONSUMER = "worker-1";

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
  const bundle = compileExecutionBundle({
    businessId: BUSINESS,
    changesetId,
    commitSha,
    documents,
  });
  return signExecutionBundle(bundle, signer);
}

const signer = createHmacBundleSigner("key-1", "secret");

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

  const docsV1 = [doc("fast", { provider: "anthropic" })];
  const docsV2 = [doc("fast", { provider: "anthropic", temperature: 0 })];

  beforeEach(() => {
    store = new InMemorySoulPublicationStore();
    bundles = new InMemoryBundleStore();
    logger = new RecordingLogger();
    coordinator = new SoulPublicationCoordinator(store, bundles, logger);
  });

  async function publishAndDrain(changesetId: string, commitSha: string, docs = docsV1) {
    const record = signedBundle(changesetId, commitSha, docs);
    await coordinator.publish({ bundle: record });
    await coordinator.drain(CONSUMER);
    return record;
  }

  it("does not activate a digest until every stage succeeded", async () => {
    const record = signedBundle("cs-1", "c0ffee", docsV1);

    await coordinator.publish({ bundle: record });
    expect(await coordinator.activeDigest(BUSINESS)).toBeUndefined();

    const outcomes = await coordinator.drain(CONSUMER);

    expect(outcomes).toEqual([{ changesetId: "cs-1", digest: record.digest, stage: "active" }]);
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
    await coordinator.publish({ bundle: second });
    failOnce(store, "replaceProjection");

    await expect(coordinator.drain(CONSUMER)).rejects.toThrow(SoulPublicationError);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(first.digest);

    // The outbox message stayed unconsumed, so the durable job resumes and completes it.
    const outcomes = await coordinator.drain(CONSUMER);
    expect(outcomes).toEqual([{ changesetId: "cs-2", digest: second.digest, stage: "active" }]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(second.digest);
  });

  it("keeps the previous active version when activation crashes, then resumes", async () => {
    const first = await publishAndDrain("cs-1", "c0ffee");

    const second = signedBundle("cs-2", "beef", docsV2);
    await coordinator.publish({ bundle: second });
    failOnce(store, "setActiveDigest");

    await expect(coordinator.drain(CONSUMER)).rejects.toThrow(SoulPublicationError);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(first.digest);

    await coordinator.drain(CONSUMER);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(second.digest);
  });

  it("fails closed and keeps the active version when the stored bundle is gone", async () => {
    const first = await publishAndDrain("cs-1", "c0ffee");

    const second = signedBundle("cs-2", "beef", docsV2);
    await coordinator.publish({ bundle: second });
    bundles = new InMemoryBundleStore();
    coordinator = new SoulPublicationCoordinator(store, bundles, logger);

    await expect(coordinator.drain(CONSUMER)).rejects.toMatchObject({
      code: "BUNDLE_UNAVAILABLE",
    });
    expect(await coordinator.activeDigest(BUSINESS)).toBe(first.digest);
  });

  it("is idempotent under duplicate publish and duplicate delivery", async () => {
    const record = signedBundle("cs-1", "c0ffee", docsV1);

    await coordinator.publish({ bundle: record });
    await coordinator.publish({ bundle: record });

    const first = await coordinator.drain(CONSUMER);
    const second = await coordinator.drain(CONSUMER);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(await coordinator.activeDigest(BUSINESS)).toBe(record.digest);
  });

  it("rejects a record whose digest does not cover its bundle", async () => {
    const record = signedBundle("cs-1", "c0ffee", docsV1);

    await expect(
      coordinator.publish({ bundle: { ...record, digest: "not-the-digest" } })
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });

    const stored = await store.withTransaction((tx) => tx.getPublication("cs-1"));
    expect(stored).toBeUndefined();
  });

  it("rejects a second publication that reuses a changeset id with another digest", async () => {
    await coordinator.publish({ bundle: signedBundle("cs-1", "c0ffee", docsV1) });

    await expect(
      coordinator.publish({ bundle: signedBundle("cs-1", "beef", docsV2) })
    ).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
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

    const runtime = await coordinator.activeBundle(BUSINESS, signer);
    expect(runtime?.digest).toBe(record.digest);
    expect(runtime?.get("ModelProfile", "fast")?.id).toBe("id-fast");

    const otherKey = createHmacBundleSigner("key-2", "other");
    await expect(coordinator.activeBundle(BUSINESS, otherKey)).rejects.toThrow(BundleError);
  });

  it("has no active bundle before the first publication completes", async () => {
    expect(await coordinator.activeBundle(BUSINESS, signer)).toBeUndefined();
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

    await expect(coordinator.publish({ bundle: record })).rejects.toMatchObject({
      code: "BUNDLE_STORE_FAILED",
    });
    expect(await coordinator.activeDigest("biz-1")).toBeUndefined();
    expect(await store.withTransaction((tx) => tx.getPublication("cs-1"))).toBeUndefined();
  });
});

it("computes the same digest the store addresses", () => {
  const record = signedBundle("cs-1", "c0ffee", [doc("fast", {})]);
  expect(computeBundleDigest(record.bundle)).toBe(record.digest);
});
