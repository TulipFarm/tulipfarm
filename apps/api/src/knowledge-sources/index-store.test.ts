import type { PGlite } from "@electric-sql/pglite";
import type { KnowledgeIndexEntry } from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingPort } from "../knowledge/types";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgKnowledgeIndexStore } from "./index-store";

const BUSINESS = "11111111-1111-1111-1111-111111111111";
const OTHER_BUSINESS = "22222222-2222-2222-2222-222222222222";

function fakeEmbeddings(opts: { available: boolean; model?: string; dim?: number }): EmbeddingPort {
  const dim = opts.dim ?? 3;
  const model = opts.model ?? "fake-model";
  return {
    isAvailable: () => opts.available,
    embedMany: async (values) => ({
      embeddings: values.map(() => Array(dim).fill(0.1) as number[]),
      dimension: dim,
    }),
    getActive: () => (opts.available ? { provider: "fake", model, dimension: dim } : null),
    getDimension: () => (opts.available ? dim : null),
    consumePendingReindex: () => false,
  };
}

/** Records the number of embedMany calls so a test can assert reuse/skip behavior. */
function countingEmbeddings(model = "fake-model", dim = 3): { port: EmbeddingPort; calls: number } {
  const counter = { calls: 0 };
  const port: EmbeddingPort = {
    isAvailable: () => true,
    embedMany: async (values) => {
      counter.calls += 1;
      return { embeddings: values.map(() => Array(dim).fill(0.1) as number[]), dimension: dim };
    },
    getActive: () => ({ provider: "fake", model, dimension: dim }),
    getDimension: () => dim,
    consumePendingReindex: () => false,
  };
  return {
    port,
    get calls() {
      return counter.calls;
    },
  };
}

/** `knowledge_source_chunks` FKs to `knowledge_source_records`; seed a stub parent row per test. */
async function seedSource(db: PGlite, businessId: string, sourceId: string): Promise<void> {
  await db.query(
    `INSERT INTO knowledge_source_records
       (source_id, business_id, integration_id, provider, external_id, external_tenant_id,
        owner_external_id, revision, classification, status, verification,
        access_control_mode, access_control_max_age_seconds, provenance_captured_at,
        provenance_content_hash, last_synced_at, created_at, updated_at)
     VALUES ($1,$2,'slack','slack','C1','T1','U1','1.0','{internal}'::text[],'active','verified',
             'live',60,now(),'hash',now(),now(),now())
     ON CONFLICT (business_id, source_id) DO NOTHING`,
    [sourceId, businessId]
  );
}

function entry(overrides: Partial<KnowledgeIndexEntry> = {}): KnowledgeIndexEntry {
  return {
    businessId: BUSINESS,
    sourceId: "slack:T1:C1",
    chunkId: "slack:T1:C1#1.0",
    revision: "1.0",
    classification: ["internal"],
    digest: "digest-1",
    text: "the quick brown fox",
    ...overrides,
  };
}

describe("PgKnowledgeIndexStore", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    await seedSource(db, BUSINESS, "slack:T1:C1");
  });

  afterEach(async () => {
    await db.close();
  });

  it("upserts and embeds a chunk when a provider is available", async () => {
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: true }));
    await store.upsert(entry());
    const { rows } = await db.query(
      "SELECT model, dim, embedding FROM knowledge_source_chunks WHERE chunk_id = $1",
      [entry().chunkId]
    );
    const row = rows[0] as { model: string; dim: number; embedding: unknown };
    expect(row.model).toBe("fake-model");
    expect(Number(row.dim)).toBe(3);
    expect(row.embedding).not.toBeNull();
  });

  it("stores lexical-only (NULL embedding) when no provider is available", async () => {
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: false }));
    await store.upsert(entry());
    const { rows } = await db.query(
      "SELECT model, dim, embedding FROM knowledge_source_chunks WHERE chunk_id = $1",
      [entry().chunkId]
    );
    const row = rows[0] as { model: string | null; embedding: unknown };
    expect(row.model).toBeNull();
    expect(row.embedding).toBeNull();
  });

  it("is idempotent — upserting the same chunk_id replaces rather than duplicates", async () => {
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: true }));
    await store.upsert(entry());
    await store.upsert(entry({ revision: "2.0", digest: "digest-2", text: "updated text" }));
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM knowledge_source_chunks WHERE chunk_id = $1",
      [entry().chunkId]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
    const found = await db.query(
      "SELECT revision, content FROM knowledge_source_chunks WHERE chunk_id = $1",
      [entry().chunkId]
    );
    expect((found.rows[0] as { revision: string }).revision).toBe("2.0");
    expect((found.rows[0] as { content: string }).content).toBe("updated text");
  });

  it("reuses the stored embedding when digest and model are unchanged (no re-embed call)", async () => {
    const e = countingEmbeddings();
    const store = new PgKnowledgeIndexStore(db, e.port);
    await store.upsert(entry());
    expect(e.calls).toBe(1);
    await store.upsert(entry());
    expect(e.calls).toBe(1); // unchanged digest + model -> reused, no second embed call
  });

  it("re-embeds when the digest changes", async () => {
    const e = countingEmbeddings();
    const store = new PgKnowledgeIndexStore(db, e.port);
    await store.upsert(entry());
    await store.upsert(entry({ digest: "digest-2", text: "changed" }));
    expect(e.calls).toBe(2);
  });

  it("re-embeds when the active model changes", async () => {
    const storeA = new PgKnowledgeIndexStore(db, countingEmbeddings("model-a").port);
    await storeA.upsert(entry());
    const b = countingEmbeddings("model-b");
    const storeB = new PgKnowledgeIndexStore(db, b.port);
    await storeB.upsert(entry());
    expect(b.calls).toBe(1);
    const { rows } = await db.query(
      "SELECT model FROM knowledge_source_chunks WHERE chunk_id = $1",
      [entry().chunkId]
    );
    expect((rows[0] as { model: string }).model).toBe("model-b");
  });

  it("removeSource deletes only that source's chunks and returns the count removed", async () => {
    await seedSource(db, BUSINESS, "slack:T1:C2");
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: true }));
    await store.upsert(entry({ chunkId: "slack:T1:C1#1.0" }));
    await store.upsert(entry({ chunkId: "slack:T1:C1#2.0" }));
    await store.upsert(entry({ sourceId: "slack:T1:C2", chunkId: "slack:T1:C2#1.0" }));

    const removed = await store.removeSource(BUSINESS, "slack:T1:C1");
    expect(removed).toBe(2);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM knowledge_source_chunks");
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("removeChunk deletes only that chunk, leaving siblings and other sources intact", async () => {
    await seedSource(db, BUSINESS, "slack:T1:C2");
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: true }));
    await store.upsert(entry({ chunkId: "slack:T1:C1#1.0" }));
    await store.upsert(entry({ chunkId: "slack:T1:C1#2.0" }));
    await store.upsert(entry({ sourceId: "slack:T1:C2", chunkId: "slack:T1:C2#1.0" }));

    await store.removeChunk(BUSINESS, "slack:T1:C1", "slack:T1:C1#1.0");
    const { rows } = await db.query(
      "SELECT chunk_id FROM knowledge_source_chunks ORDER BY chunk_id"
    );
    expect(rows).toEqual([{ chunk_id: "slack:T1:C1#2.0" }, { chunk_id: "slack:T1:C2#1.0" }]);
  });

  it("removeChunk is a no-op when the chunk does not exist", async () => {
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: true }));
    await store.upsert(entry());
    await store.removeChunk(BUSINESS, "slack:T1:C1", "slack:T1:C1#missing");
    const { rows } = await db.query("SELECT count(*)::int AS n FROM knowledge_source_chunks");
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("search returns [] immediately for an empty allowedSourceIds set", async () => {
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: true }));
    await store.upsert(entry());
    const results = await store.search({
      businessId: BUSINESS,
      query: "fox",
      limit: 10,
      allowedSourceIds: new Set(),
    });
    expect(results).toEqual([]);
  });

  it("search (vector path) only returns chunks whose sourceId is in allowedSourceIds", async () => {
    await seedSource(db, BUSINESS, "slack:T1:C2");
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: true }));
    await store.upsert(entry({ sourceId: "slack:T1:C1", chunkId: "slack:T1:C1#1.0" }));
    await store.upsert(entry({ sourceId: "slack:T1:C2", chunkId: "slack:T1:C2#1.0" }));

    const results = await store.search({
      businessId: BUSINESS,
      query: "fox",
      limit: 10,
      allowedSourceIds: new Set(["slack:T1:C1"]),
    });
    expect(results.map((r) => r.sourceId)).toEqual(["slack:T1:C1"]);
  });

  it("search never returns another business's chunks even when the sourceId collides", async () => {
    await seedSource(db, OTHER_BUSINESS, "slack:T1:C1");
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: true }));
    await store.upsert(entry({ businessId: BUSINESS, sourceId: "slack:T1:C1" }));
    await store.upsert(
      entry({ businessId: OTHER_BUSINESS, sourceId: "slack:T1:C1", chunkId: "slack:T1:C1#other" })
    );

    const results = await store.search({
      businessId: BUSINESS,
      query: "fox",
      limit: 10,
      allowedSourceIds: new Set(["slack:T1:C1"]),
    });
    expect(results).toHaveLength(1);
  });

  it("search falls back to lexical ranking when no embedding provider is available", async () => {
    const store = new PgKnowledgeIndexStore(db, fakeEmbeddings({ available: false }));
    await store.upsert(entry({ text: "the quick brown fox jumps" }));
    const results = await store.search({
      businessId: BUSINESS,
      query: "fox",
      limit: 10,
      allowedSourceIds: new Set(["slack:T1:C1"]),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toBe("the quick brown fox jumps");
  });
});
