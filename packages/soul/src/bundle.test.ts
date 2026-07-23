import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  BundleError,
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

function bundleOf(spec: Record<string, unknown>): ExecutionBundle {
  return compileExecutionBundle({
    businessId: "biz-1",
    changesetId: "cs-1",
    commitSha: "c0ffee",
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
});

describe("InMemoryBundleStore", () => {
  it("stores and reloads a bundle by its content address", async () => {
    const store = new InMemoryBundleStore();
    const record = signed(bundleOf({ a: 1 }));
    await store.put(record);
    await expect(store.get(record.digest)).resolves.toEqual(record);
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

  it("refuses to overwrite a stored digest with a different signature", async () => {
    const store = new InMemoryBundleStore();
    const record = signed(bundleOf({ a: 1 }));
    await store.put(record);
    const rival = { ...record, signature: { keyId: "k2", value: "other" } };
    await expect(store.put(rival)).rejects.toBeInstanceOf(BundleError);
    await expect(store.get(record.digest)).resolves.toEqual(record);
  });
});
