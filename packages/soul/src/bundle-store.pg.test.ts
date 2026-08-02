import { PGlite } from "@electric-sql/pglite";
import type { Queryable, TransactionPort } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { computeBundleDigest, type ExecutionBundle, type SignedExecutionBundle } from "./bundle";
import { PgBundleStore, SOUL_BUNDLE_STORAGE_STATEMENTS } from "./bundle-store.pg";

function transactions(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function signed(signature = "signature-1"): SignedExecutionBundle {
  const bundle: ExecutionBundle = {
    bundleVersion: 1,
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "commit-1",
    definitions: [],
  };
  return {
    bundle,
    digest: computeBundleDigest(bundle),
    signature: { keyId: "key-1", value: signature },
  };
}

describe("PgBundleStore", () => {
  let database: PGlite;
  let store: PgBundleStore;

  beforeEach(async () => {
    database = new PGlite();
    for (const statement of SOUL_BUNDLE_STORAGE_STATEMENTS) await database.query(statement);
    store = new PgBundleStore(transactions(database));
  });

  it("round-trips one immutable signed bundle", async () => {
    const record = signed();

    await store.put(record);
    await store.put(record);

    expect(await store.get(record.digest)).toEqual(record);
  });

  it("rejects a conflicting signature for an existing digest", async () => {
    await store.put(signed());

    await expect(store.put(signed("different"))).rejects.toMatchObject({
      code: "DIGEST_CONFLICT",
    });
  });

  it("rejects a record whose digest does not cover its bundle", async () => {
    await expect(store.put({ ...signed(), digest: "tampered" })).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
    });
  });
});
