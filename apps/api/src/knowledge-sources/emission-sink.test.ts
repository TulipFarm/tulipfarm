import type { PGlite } from "@electric-sql/pglite";
import type { KnowledgeChunkEmission, KnowledgeSourceEmission } from "@tulipfarm/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingPort } from "../knowledge/types";
import { makeMigratedPglite } from "../test/pglite";
import { PgKnowledgeEmissionSink } from "./emission-sink";
import { PgKnowledgeIndexStore } from "./index-store";
import { PgKnowledgeSourceStore } from "./source-store";

const BUSINESS = "11111111-1111-1111-1111-111111111111";

function fakeEmbeddings(): EmbeddingPort {
  return {
    isAvailable: () => true,
    embedMany: async (values) => ({
      embeddings: values.map(() => [0.1, 0.1, 0.1]),
      dimension: 3,
    }),
    getActive: () => ({ provider: "fake", model: "fake-model", dimension: 3 }),
    getDimension: () => 3,
    consumePendingReindex: () => false,
  };
}

function sourceEmission(overrides: Partial<KnowledgeSourceEmission> = {}): KnowledgeSourceEmission {
  return {
    sourceId: "slack:T1:C1",
    businessId: BUSINESS,
    integrationId: "slack:app1:T1",
    provider: "slack",
    externalId: "C1",
    externalTenantId: "T1",
    ownerExternalId: "U1",
    revision: "1.0",
    classification: ["internal"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "live", maximumAgeSeconds: 60 },
    provenance: { capturedAt: "2026-01-01T00:00:00.000Z", contentHash: "hash-1" },
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function chunkEmission(overrides: Partial<KnowledgeChunkEmission> = {}): KnowledgeChunkEmission {
  return {
    businessId: BUSINESS,
    sourceId: "slack:T1:C1",
    chunkId: "slack:T1:C1#1700000000.000100",
    revision: "1.0",
    classification: ["internal"],
    digest: "digest-1",
    text: "hello from slack",
    ...overrides,
  };
}

describe("PgKnowledgeEmissionSink", () => {
  let db: PGlite;
  let sink: PgKnowledgeEmissionSink;
  let sources: PgKnowledgeSourceStore;
  let index: PgKnowledgeIndexStore;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    sources = new PgKnowledgeSourceStore(db);
    index = new PgKnowledgeIndexStore(db, fakeEmbeddings());
    sink = new PgKnowledgeEmissionSink(sources, index);
  });

  afterEach(async () => {
    await db.close();
  });

  it("emitSource writes a readable source record", async () => {
    await sink.emitSource(sourceEmission());
    const found = await sources.get(BUSINESS, "slack:T1:C1");
    expect(found?.sourceId).toBe("slack:T1:C1");
    expect(found?.provider).toBe("slack");
  });

  it("emitChunk writes an indexed chunk", async () => {
    await sink.emitSource(sourceEmission());
    await sink.emitChunk(chunkEmission());
    const { rows } = await db.query(
      "SELECT content FROM knowledge_source_chunks WHERE chunk_id = $1",
      [chunkEmission().chunkId]
    );
    expect((rows[0] as { content: string }).content).toBe("hello from slack");
  });

  it("removeSourceContent removes all of that source's chunks", async () => {
    await sink.emitSource(sourceEmission());
    await sink.emitChunk(chunkEmission());
    await sink.emitChunk(chunkEmission({ chunkId: "slack:T1:C1#1700000000.000200" }));
    await sink.removeSourceContent(BUSINESS, "slack:T1:C1");
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM knowledge_source_chunks WHERE source_id = $1",
      ["slack:T1:C1"]
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it("removeChunk removes only that message, leaving siblings and the source intact", async () => {
    await sink.emitSource(sourceEmission());
    await sink.emitChunk(chunkEmission());
    await sink.emitChunk(chunkEmission({ chunkId: "slack:T1:C1#1700000000.000200" }));
    await sink.removeChunk(BUSINESS, "slack:T1:C1", "slack:T1:C1#1700000000.000100");
    const { rows } = await db.query(
      "SELECT chunk_id FROM knowledge_source_chunks WHERE source_id = $1",
      ["slack:T1:C1"]
    );
    expect(rows).toEqual([{ chunk_id: "slack:T1:C1#1700000000.000200" }]);
    expect(await sources.get(BUSINESS, "slack:T1:C1")).toBeDefined();
  });
});
