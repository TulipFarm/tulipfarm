import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  computeBundleDigest,
  type ExecutionBundle,
  InMemoryBundleStore,
  type SignedExecutionBundle,
} from "./bundle";
import { compileExecutionBundle } from "./compiler";

const API = "tulipfarm.ai/v1";

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

function bundleOf(
  spec: Record<string, unknown>,
  lineage: { changesetId?: string; commitSha?: string } = {}
): ExecutionBundle {
  return compileExecutionBundle({
    businessId: "biz-1",
    changesetId: lineage.changesetId ?? "cs-1",
    commitSha: lineage.commitSha ?? "c0ffee",
    documents: [doc("fast", spec)],
  });
}

function signed(bundle: ExecutionBundle, digest = computeBundleDigest(bundle)) {
  return {
    bundle,
    digest,
    signature: { keyId: "k1", value: "sig" },
  } satisfies SignedExecutionBundle;
}

describe("computeBundleDigest", () => {
  it("is independent of authored key order", () => {
    expect(computeBundleDigest(bundleOf({ a: 1, b: 2 }))).toBe(
      computeBundleDigest(bundleOf({ b: 2, a: 1 }))
    );
  });

  it("changes when any authored value changes", () => {
    expect(computeBundleDigest(bundleOf({ a: 1 }))).not.toBe(
      computeBundleDigest(bundleOf({ a: 2 }))
    );
  });

  it("is a content address: identical content under different lineage yields one digest", () => {
    const first = bundleOf({ a: 1 }, { changesetId: "cs-1", commitSha: "commit-a" });
    const second = bundleOf({ a: 1 }, { changesetId: "cs-2", commitSha: "commit-b" });
    expect(first.changesetId).not.toBe(second.changesetId);
    expect(first.commitSha).not.toBe(second.commitSha);
    expect(computeBundleDigest(first)).toBe(computeBundleDigest(second));
  });

  it("still separates tenants: same content under a different business differs", () => {
    const mine = bundleOf({ a: 1 });
    const theirs = { ...mine, businessId: "biz-2" } satisfies ExecutionBundle;
    expect(computeBundleDigest(mine)).not.toBe(computeBundleDigest(theirs));
  });
});

describe("InMemoryBundleStore", () => {
  it("stores and reloads a bundle by its content address", async () => {
    const store = new InMemoryBundleStore();
    const record = signed(bundleOf({ a: 1 }));
    await store.put(record);
    await expect(store.get(record.digest)).resolves.toEqual(record);
  });

  it("stores a detached, deeply immutable snapshot", async () => {
    const store = new InMemoryBundleStore();
    const record = structuredClone(signed(bundleOf({ nested: { value: 1 } })));
    await store.put(record);
    const stored = await store.get(record.digest);
    if (!stored) throw new Error("expected stored bundle");
    const document = record.bundle.definitions[0]?.document;
    if (!document) throw new Error("expected source document");

    (document.spec as Record<string, unknown>).nested = { value: 2 };

    expect(
      (stored.bundle.definitions[0]?.document.spec as Record<string, unknown>)?.nested
    ).toEqual({ value: 1 });
    expect(Object.isFrozen(stored.bundle.definitions[0]?.document.spec)).toBe(true);
  });

  it("returns undefined for an unknown digest", async () => {
    await expect(new InMemoryBundleStore().get("deadbeef")).resolves.toBeUndefined();
  });

  it("rejects a record whose digest does not cover its bundle", async () => {
    const store = new InMemoryBundleStore();
    await expect(store.put(signed(bundleOf({ a: 1 }), "deadbeef"))).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
    });
  });

  it("is idempotent for a duplicate delivery of the same record", async () => {
    const store = new InMemoryBundleStore();
    const record = signed(bundleOf({ a: 1 }));
    await store.put(record);
    await store.put(record);
    await expect(store.get(record.digest)).resolves.toEqual(record);
  });

  it("idempotently accepts a republish of identical content under a new signature, first wins", async () => {
    const store = new InMemoryBundleStore();
    const record = signed(bundleOf({ a: 1 }, { commitSha: "commit-a" }));
    await store.put(record);
    const republish = { ...record, signature: { keyId: "k2", value: "other" } };
    await store.put(republish);
    await expect(store.get(record.digest)).resolves.toEqual(record);
  });
});
