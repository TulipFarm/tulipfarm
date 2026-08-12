import { PGlite } from "@electric-sql/pglite";
import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import type { Queryable, TransactionPort } from "@tulipfarm/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeBundleDigest, type ExecutionBundle, type SignedExecutionBundle } from "./bundle";
import { PgBundleStore, SOUL_BUNDLE_STORAGE_STATEMENTS } from "./bundle-store.pg";
import { compileExecutionBundle } from "./compiler";

const API = "tulipfarm.ai/v1";

function transactions(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

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

function bundleWithDefinitions(): ExecutionBundle {
  return compileExecutionBundle({
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "commit-1",
    documents: [doc("fast", { provider: "test", modelId: "model-a", limits: { calls: 3 } })],
    files: [
      {
        path: "skills/send-email/handler.ts",
        content: "export async function run() { return 'sent'; }\n",
      },
    ],
  });
}

function emptyBundle(): ExecutionBundle {
  return {
    bundleVersion: 2,
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "commit-1",
    definitions: [],
    assets: [],
  };
}

// Lineage is outside the content-addressed digest, so distinct bundles must differ by content —
// each carries a unique marker asset to get a unique digest.
function markedBundle(marker: string): ExecutionBundle {
  return {
    ...emptyBundle(),
    changesetId: `changeset-${marker}`,
    assets: [
      {
        ownerDefinitionId: "marker",
        path: "marker.txt",
        digest: `digest-${marker}`,
        content: marker,
      },
    ],
  };
}

function signed(
  signature = "signature-1",
  bundle: ExecutionBundle = emptyBundle()
): SignedExecutionBundle {
  return {
    bundle,
    digest: computeBundleDigest(bundle),
    signature: { keyId: "key-1", value: signature },
  };
}

async function createRetentionReferenceTables(database: PGlite): Promise<void> {
  await database.query(`CREATE TABLE IF NOT EXISTS soul_active_bundles (
    business_id text PRIMARY KEY,
    digest text NOT NULL
  )`);
  await database.query(`CREATE TABLE IF NOT EXISTS soul_bundle_activations (
    business_id text NOT NULL,
    digest text NOT NULL
  )`);
  await database.query(`CREATE TABLE IF NOT EXISTS soul_publications (
    changeset_id text PRIMARY KEY,
    business_id text NOT NULL,
    digest text NOT NULL,
    dead_lettered_at timestamptz
  )`);
  await database.query(`CREATE TABLE IF NOT EXISTS runs (
    id text PRIMARY KEY,
    business_id text NOT NULL,
    bundle jsonb NOT NULL
  )`);
  await database.query(`CREATE TABLE IF NOT EXISTS audit_events (
    id text PRIMARY KEY,
    business_id text NOT NULL,
    bundle_digest text
  )`);
}

describe("PgBundleStore", () => {
  let database: PGlite;
  let store: PgBundleStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of SOUL_BUNDLE_STORAGE_STATEMENTS) await database.query(statement);
    await createRetentionReferenceTables(database);
    store = new PgBundleStore(transactions(database));
  }, 120_000);

  afterAll(async () => {
    await database.close();
  }, 30_000);

  beforeEach(async () => {
    await database.query(
      "TRUNCATE TABLE soul_execution_bundles, soul_active_bundles, soul_bundle_activations, soul_publications, runs, audit_events"
    );
  });

  it("round-trips one immutable signed bundle", async () => {
    const record = signed();

    await store.put(record);
    await store.put(record);

    expect(await store.get(record.digest)).toEqual(record);
  });

  it("keeps digest stability for real definitions and assets across a jsonb round trip", async () => {
    const record = signed("signature-1", bundleWithDefinitions());

    await store.put(record);
    const stored = await store.get(record.digest);

    expect(stored).toEqual(record);
    expect(stored ? computeBundleDigest(stored.bundle) : undefined).toBe(record.digest);
  });

  it("idempotently accepts a republish of identical content under a new signature, first wins", async () => {
    await store.put(signed());

    await store.put(signed("different"));

    expect(await store.get(signed().digest)).toEqual(signed());
  });

  it("rejects a record whose digest does not cover its bundle", async () => {
    await expect(store.put({ ...signed(), digest: "tampered" })).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
    });
  });

  it("rejects NUL bytes before PostgreSQL jsonb rejects the payload opaquely", async () => {
    const bundle = {
      ...emptyBundle(),
      assets: [
        {
          ownerDefinitionId: "skill-1",
          path: "handler.ts",
          digest: "digest-asset",
          content: "bad\u0000content",
        },
      ],
    } satisfies ExecutionBundle;

    await expect(store.put(signed("signature-1", bundle))).rejects.toMatchObject({
      code: "INVALID_DEFINITION",
      field: "/assets/0/content",
    });
  });

  it("deletes only old bundles that are not active, historical, run-pinned, audit-referenced, or in flight", async () => {
    const deletable = signed("signature-delete", markedBundle("delete"));
    const active = signed("signature-active", markedBundle("active"));
    const historical = signed("signature-history", markedBundle("history"));
    const pinned = signed("signature-pinned", markedBundle("pinned"));
    const audited = signed("signature-audit", markedBundle("audit"));
    const inFlight = signed("signature-flight", markedBundle("flight"));
    for (const record of [deletable, active, historical, pinned, audited, inFlight]) {
      await store.put(record);
    }

    await database.query("UPDATE soul_execution_bundles SET created_at = '2025-01-01T00:00:00Z'");
    await database.query("INSERT INTO soul_active_bundles (business_id, digest) VALUES ($1, $2)", [
      "business-1",
      active.digest,
    ]);
    await database.query(
      "INSERT INTO soul_bundle_activations (business_id, digest) VALUES ($1, $2)",
      ["business-1", historical.digest]
    );
    await database.query("INSERT INTO runs (id, business_id, bundle) VALUES ($1, $2, $3::jsonb)", [
      "run-1",
      "business-1",
      JSON.stringify({ digest: pinned.digest }),
    ]);
    await database.query(
      "INSERT INTO audit_events (id, business_id, bundle_digest) VALUES ($1, $2, $3)",
      ["audit-1", "business-1", audited.digest]
    );
    await database.query(
      `INSERT INTO soul_publications (changeset_id, business_id, digest)
       VALUES ($1, $2, $3)`,
      ["changeset-flight", "business-1", inFlight.digest]
    );

    await expect(
      store.deleteUnreferencedBundles({
        businessId: "business-1",
        olderThan: "2026-01-01T00:00:00.000Z",
        limit: 10,
      })
    ).resolves.toBe(1);

    await expect(store.get(deletable.digest)).resolves.toBeUndefined();
    await expect(store.get(active.digest)).resolves.toBeDefined();
    await expect(store.get(historical.digest)).resolves.toBeDefined();
    await expect(store.get(pinned.digest)).resolves.toBeDefined();
    await expect(store.get(audited.digest)).resolves.toBeDefined();
    await expect(store.get(inFlight.digest)).resolves.toBeDefined();
  });
});
