import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import {
  ARTIFACT_STORAGE_STATEMENTS,
  ArtifactPersistenceError,
  ArtifactStore,
  type PutArtifactInput,
} from "./artifact-store";

const CREATED_AT = "2026-07-24T10:00:00.000Z";
const RUN_ID = "00000000-0000-4000-8000-000000000001";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function artifact(overrides: Partial<PutArtifactInput> = {}): PutArtifactInput {
  return {
    id: "artifact-1",
    businessId: "business-1",
    schemaRef: "routine-1/classify/output/v1",
    content: { label: "billing" },
    blob: null,
    contentHash: "hash-1",
    classification: ["internal"],
    acl: { readers: ["agent:agent-1"] },
    retention: { policy: "standard", expiresAt: null },
    redaction: { redactedPaths: [] },
    producer: { runId: RUN_ID, stateKey: "classify", attempt: 1 },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("ArtifactStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: ArtifactStore;

  beforeAll(async () => {
    database = await PGlite.create();
    for (const statement of ARTIFACT_STORAGE_STATEMENTS) {
      await database.query(statement);
    }
  }, 60_000);

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE artifacts CASCADE");
    store = new ArtifactStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  it("persists typed inline content with classification, ACL, hash, and retention", async () => {
    const result = await store.put(artifact());

    expect(result.outcome).toBe("created");
    const found = await store.find("business-1", "artifact-1");
    expect(found).toEqual({
      id: "artifact-1",
      businessId: "business-1",
      schemaRef: "routine-1/classify/output/v1",
      contentKind: "inline",
      content: { label: "billing" },
      blob: null,
      contentHash: "hash-1",
      classification: ["internal"],
      acl: { readers: ["agent:agent-1"] },
      retention: { policy: "standard", expiresAt: null },
      redaction: { redactedPaths: [] },
      producer: { runId: RUN_ID, stateKey: "classify", attempt: 1 },
      createdAt: CREATED_AT,
    });
  });

  it("persists a blob reference without inline content", async () => {
    await store.put(
      artifact({
        id: "artifact-blob",
        content: null,
        blob: { key: "blob-key-1", hash: "blob-hash-1" },
        contentHash: "blob-hash-1",
      })
    );

    const found = await store.find("business-1", "artifact-blob");
    expect(found?.contentKind).toBe("blob");
    expect(found?.content).toBeNull();
    expect(found?.blob).toEqual({ key: "blob-key-1", hash: "blob-hash-1" });
  });

  it("rejects a record that carries both inline content and a blob reference", async () => {
    await expect(
      store.put(artifact({ id: "artifact-both", blob: { key: "k", hash: "h" } }))
    ).rejects.toThrow();
  });

  it("treats a replayed identical put as a duplicate and a changed one as a conflict", async () => {
    await store.put(artifact());

    const replay = await store.put(artifact());
    expect(replay.outcome).toBe("duplicate");

    await expect(store.put(artifact({ contentHash: "hash-2" }))).rejects.toBeInstanceOf(
      ArtifactPersistenceError
    );
  });

  it("refuses to mutate or delete a stored Artifact", async () => {
    await store.put(artifact());

    await expect(
      database.query('UPDATE artifacts SET content = \'{"label":"other"}\'::jsonb')
    ).rejects.toThrow(/artifact_immutable/);
    await expect(database.query("DELETE FROM artifacts")).rejects.toThrow(/artifact_immutable/);
  });

  it("isolates lookups by business", async () => {
    await store.put(artifact());

    expect(await store.find("business-2", "artifact-1")).toBeNull();
  });

  it("binds immutable named State outputs and resolves them", async () => {
    await store.put(artifact());
    const bound = await store.bindOutput({
      businessId: "business-1",
      runId: RUN_ID,
      stateKey: "classify",
      outputName: "classification",
      artifactId: "artifact-1",
      createdAt: CREATED_AT,
    });
    expect(bound.outcome).toBe("bound");

    const resolved = await store.resolveOutput("business-1", RUN_ID, "classify", "classification");
    expect(resolved?.id).toBe("artifact-1");
    expect(await store.resolveOutput("business-1", RUN_ID, "classify", "missing")).toBeNull();
  });

  it("rejects rebinding a named output to a different Artifact", async () => {
    await store.put(artifact());
    await store.put(artifact({ id: "artifact-2" }));
    const binding = {
      businessId: "business-1",
      runId: RUN_ID,
      stateKey: "classify",
      outputName: "classification",
      artifactId: "artifact-1",
      createdAt: CREATED_AT,
    };
    await store.bindOutput(binding);

    expect((await store.bindOutput(binding)).outcome).toBe("duplicate");
    await expect(store.bindOutput({ ...binding, artifactId: "artifact-2" })).rejects.toBeInstanceOf(
      ArtifactPersistenceError
    );
  });

  it("appends idempotent lineage edges between Artifacts", async () => {
    await store.put(artifact());
    await store.put(artifact({ id: "artifact-2" }));

    await store.appendLineage({
      businessId: "business-1",
      artifactId: "artifact-2",
      sourceArtifactId: "artifact-1",
      relation: "derived_from",
      createdAt: CREATED_AT,
    });
    await store.appendLineage({
      businessId: "business-1",
      artifactId: "artifact-2",
      sourceArtifactId: "artifact-1",
      relation: "derived_from",
      createdAt: CREATED_AT,
    });

    expect(await store.listLineage("business-1", "artifact-2")).toEqual([
      {
        businessId: "business-1",
        artifactId: "artifact-2",
        sourceArtifactId: "artifact-1",
        relation: "derived_from",
        createdAt: CREATED_AT,
      },
    ]);
  });

  it("refuses lineage that points at an Artifact of another business", async () => {
    await store.put(artifact());
    await store.put(artifact({ id: "artifact-2", businessId: "business-2" }));

    await expect(
      store.appendLineage({
        businessId: "business-2",
        artifactId: "artifact-2",
        sourceArtifactId: "artifact-1",
        relation: "derived_from",
        createdAt: CREATED_AT,
      })
    ).rejects.toThrow();
  });
});
