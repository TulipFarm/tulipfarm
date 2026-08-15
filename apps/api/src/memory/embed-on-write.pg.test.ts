import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import type { MemoryEmbedder } from "./embedder";
import { EngineMemoryRepo } from "./engine-repo";
import { PgMemoryRecallIndex } from "./recall-index";

const USER = "44444444-4444-4444-4444-444444444444";

/** Deterministic stand-in: a fixed vector per value, so distance ordering is predictable. */
function fakeEmbedder(over: Partial<MemoryEmbedder> = {}): MemoryEmbedder {
  return {
    isAvailable: () => true,
    async embedMany(values) {
      return { embeddings: values.map(() => [1, 0, 0]), dimension: 3 };
    },
    getActive: () => ({ provider: "fake", model: "v1", dimension: 3 }),
    ...over,
  };
}

async function embeddingRow(
  db: PGlite,
  key: string
): Promise<{
  embedding: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
}> {
  const { rows } = await db.query(
    "SELECT embedding::text AS embedding, embedding_model, embedding_dim FROM memory_assertions WHERE subject = $1",
    [key]
  );
  return rows[0] as {
    embedding: string | null;
    embedding_model: string | null;
    embedding_dim: number | null;
  };
}

describe("embedding memory statements on write", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("indexes the statement into the dense arm when a provider is configured", async () => {
    const repo = new EngineMemoryRepo(db, () => new Date(), fakeEmbedder());
    await repo.upsert({
      _id: `${USER}:diet`,
      userId: USER,
      key: "diet",
      value: "allergic to shellfish",
      createdAt: new Date(),
      lastWrittenAt: new Date(),
    });

    const row = await embeddingRow(db, "diet");
    expect(row.embedding).not.toBeNull();
    expect(row.embedding_dim).toBe(3);
    expect(row.embedding_model).toBe("fake:v1");
  });

  it("makes the written memory reachable through the vector arm", async () => {
    const embedder = fakeEmbedder();
    const repo = new EngineMemoryRepo(db, () => new Date(), embedder);
    await repo.upsert({
      _id: `${USER}:diet`,
      userId: USER,
      key: "diet",
      value: "allergic to shellfish",
      createdAt: new Date(),
      lastWrittenAt: new Date(),
    });

    // A query with no lexical or entity overlap: a hit can only come from the dense arm, which
    // only has data because the write path populated it.
    const index = new PgMemoryRecallIndex(db, embedder);
    const signals = await index.search({
      businessId: DEPLOYMENT_BUSINESS_ID,
      query: "kayaking",
      limit: 10,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.vectorRank).toBe(0);
  });

  it("embeds the subject with the statement, not the statement alone", async () => {
    const seen: string[] = [];
    const repo = new EngineMemoryRepo(
      db,
      () => new Date(),
      fakeEmbedder({
        async embedMany(values) {
          seen.push(...values);
          return { embeddings: values.map(() => [1, 0, 0]), dimension: 3 };
        },
      })
    );
    await repo.upsert({
      _id: `${USER}:renewal`,
      userId: USER,
      key: "renewal",
      value: "moved to Q3",
      createdAt: new Date(),
      lastWrittenAt: new Date(),
    });
    expect(seen).toEqual(["renewal: moved to Q3"]);
  });

  it("re-embeds on edit so the vector cannot describe a superseded statement", async () => {
    const seen: string[] = [];
    const repo = new EngineMemoryRepo(
      db,
      () => new Date(),
      fakeEmbedder({
        async embedMany(values) {
          seen.push(...values);
          return { embeddings: values.map(() => [1, 0, 0]), dimension: 3 };
        },
      })
    );
    const base = {
      _id: `${USER}:diet`,
      userId: USER,
      key: "diet",
      createdAt: new Date(),
      lastWrittenAt: new Date(),
    };
    await repo.upsert({ ...base, value: "allergic to shellfish" });
    await repo.upsert({ ...base, value: "allergic to peanuts" });
    // Exactly twice: the superseded row is rewritten by the edit but not re-embedded, because it
    // is no longer recallable and its text did not change.
    expect(seen).toEqual(["diet: allergic to shellfish", "diet: allergic to peanuts"]);
  });

  it("still records the memory when the provider throws", async () => {
    const repo = new EngineMemoryRepo(
      db,
      () => new Date(),
      fakeEmbedder({
        async embedMany() {
          throw new Error("provider down");
        },
      })
    );
    await repo.upsert({
      _id: `${USER}:diet`,
      userId: USER,
      key: "diet",
      value: "allergic to shellfish",
      createdAt: new Date(),
      lastWrittenAt: new Date(),
    });

    expect(await repo.listByUser(USER)).toHaveLength(1);
    expect((await embeddingRow(db, "diet")).embedding).toBeNull();
  });

  it("writes no embedding when the provider is unavailable, and never calls it", async () => {
    let called = false;
    const repo = new EngineMemoryRepo(
      db,
      () => new Date(),
      fakeEmbedder({
        isAvailable: () => false,
        async embedMany(values) {
          called = true;
          return { embeddings: values.map(() => [1, 0, 0]), dimension: 3 };
        },
      })
    );
    await repo.upsert({
      _id: `${USER}:diet`,
      userId: USER,
      key: "diet",
      value: "allergic to shellfish",
      createdAt: new Date(),
      lastWrittenAt: new Date(),
    });

    expect(called).toBe(false);
    expect(await repo.listByUser(USER)).toHaveLength(1);
    expect((await embeddingRow(db, "diet")).embedding).toBeNull();
  });

  it("records the memory when no embedder is wired at all", async () => {
    const repo = new EngineMemoryRepo(db);
    await repo.upsert({
      _id: `${USER}:diet`,
      userId: USER,
      key: "diet",
      value: "allergic to shellfish",
      createdAt: new Date(),
      lastWrittenAt: new Date(),
    });
    expect(await repo.listByUser(USER)).toHaveLength(1);
    expect((await embeddingRow(db, "diet")).embedding).toBeNull();
  });
});
