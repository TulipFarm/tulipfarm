import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePglite } from "./test/pglite";
import {
  allEmbeddingIndexNames,
  backfillIndexName,
  backfillIndexStatements,
  dimLiteral,
  dropInvalidEmbeddingIndexes,
  EMBEDDING_COLUMNS,
  embeddingDistanceSql,
  embeddingIndexName,
  embeddingIndexStatements,
  INDEXED_EMBEDDING_DIMS,
} from "./vector-search";

function randomVector(dim: number): string {
  return `[${Array.from({ length: dim }, () => Math.random()).join(",")}]`;
}

/** Plan node names only — a full EXPLAIN of a 1536-dimension query is unreadable in a diff. */
async function planOf(db: PGlite, sql: string, probe: string): Promise<string> {
  const { rows } = await db.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, [probe]);
  return rows
    .map((r) => r["QUERY PLAN"].split("(cost=")[0]?.trim() ?? "")
    .filter((line) => !line.startsWith("Sort Key") && !line.startsWith("Filter"))
    .join("\n");
}

describe("embeddingDistanceSql", () => {
  it("casts both sides to the same type so the expression can match an index", () => {
    expect(embeddingDistanceSql("c.embedding", "$1", 1536)).toEqual({
      sql: "c.embedding::vector(1536) <=> $1::vector(1536)",
      indexed: true,
    });
  });

  it("uses halfvec above the 2000-dimension hnsw limit", () => {
    // pgvector refuses `vector` hnsw above 2000 dims, so 3072-dimension models would otherwise be
    // unindexable entirely.
    expect(embeddingDistanceSql("a.embedding", "$2", 3072)).toEqual({
      sql: "a.embedding::halfvec(3072) <=> $2::halfvec(3072)",
      indexed: true,
    });
  });

  it("falls back to an unindexed scan rather than failing on an unknown dimension", () => {
    // A model with an unusual output size must still return correct results.
    expect(embeddingDistanceSql("embedding", "$1", 999)).toEqual({
      sql: "embedding <=> $1::vector",
      indexed: false,
    });
  });

  it("interpolates the matched constant, never the caller's value", () => {
    // The dimension has to be inline for the planner to match the index, so the only defence is
    // that the emitted number comes from the allow-list.
    for (const dim of INDEXED_EMBEDDING_DIMS) {
      expect(embeddingDistanceSql("e", "$1", dim).sql).toContain(`(${dim})`);
    }
    expect(embeddingDistanceSql("e", "$1", Number.NaN).indexed).toBe(false);
  });
});

describe("dimLiteral", () => {
  it("emits digits for a real dimension", () => {
    expect(dimLiteral(1536)).toBe("1536");
  });

  it("rejects anything that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => dimLiteral(bad)).toThrow(/invalid embedding dimension/);
    }
  });
});

describe("embeddingIndexStatements", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await db.query(
      "CREATE TABLE knowledge_chunks (id serial PRIMARY KEY, dim integer, embedding vector)"
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it("produces indexes Postgres accepts, for every supported dimension", async () => {
    for (const sql of embeddingIndexStatements("knowledge_chunks", "embedding", "dim")) {
      await db.query(sql);
    }
    const { rows } = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'knowledge_chunks' AND indexname LIKE '%hnsw%'"
    );
    expect(rows).toHaveLength(INDEXED_EMBEDDING_DIMS.length);
  });

  it("is reachable by the planner for the query shape the repos issue — and only with the cast", async () => {
    const dim = 1536;
    for (const sql of embeddingIndexStatements("knowledge_chunks", "embedding", "dim")) {
      await db.query(sql);
    }
    for (let i = 0; i < 200; i += 1) {
      await db.query("INSERT INTO knowledge_chunks (dim, embedding) VALUES ($1, $2::vector)", [
        dim,
        randomVector(dim),
      ]);
    }
    await db.query("ANALYZE knowledge_chunks");
    // At 200 rows a sequential scan is genuinely cheaper, and the cost model is not what is under
    // test — whether the index is *reachable* at all is. Forcing the choice isolates that.
    await db.query("SET enable_seqscan = off");
    const probe = randomVector(dim);

    const { sql: distance } = embeddingDistanceSql("c.embedding", "$1", dim);
    const withCast = await planOf(
      db,
      `SELECT c.id FROM knowledge_chunks c
        WHERE c.embedding IS NOT NULL AND c.dim = ${dimLiteral(dim)}
        ORDER BY ${distance} LIMIT 10`,
      probe
    );
    expect(withCast).toContain("Index Scan using knowledge_chunks_embedding_1536_hnsw_idx");

    // Negative control: the shape this migration replaced. It cannot reach the index no matter how
    // the planner is nudged — which is exactly why every vector search was scanning before.
    const withoutCast = await planOf(
      db,
      `SELECT c.id FROM knowledge_chunks c
        WHERE c.embedding IS NOT NULL AND c.dim = ${dimLiteral(dim)}
        ORDER BY c.embedding <=> $1::vector LIMIT 10`,
      probe
    );
    expect(withoutCast).not.toContain("hnsw");
  });

  it("returns the same top hits as an unindexed scan", async () => {
    const dim = 768;
    for (let i = 0; i < 150; i += 1) {
      await db.query("INSERT INTO knowledge_chunks (dim, embedding) VALUES ($1, $2::vector)", [
        dim,
        randomVector(dim),
      ]);
    }
    const probe = randomVector(dim);
    const scan = await db.query<{ id: number }>(
      "SELECT id FROM knowledge_chunks WHERE dim = 768 ORDER BY embedding <=> $1::vector LIMIT 5",
      [probe]
    );

    for (const sql of embeddingIndexStatements("knowledge_chunks", "embedding", "dim")) {
      await db.query(sql);
    }
    await db.query("ANALYZE knowledge_chunks");
    const { sql: distance } = embeddingDistanceSql("embedding", "$1", dim);
    const indexed = await db.query<{ id: number }>(
      `SELECT id FROM knowledge_chunks WHERE dim = ${dimLiteral(dim)}
        ORDER BY ${distance} LIMIT 5`,
      [probe]
    );

    expect(indexed.rows.map((r) => r.id)).toEqual(scan.rows.map((r) => r.id));
  });

  it("sweeps an invalid index so the rebuild is not skipped", async () => {
    // `CREATE INDEX CONCURRENTLY IF NOT EXISTS` matches on name alone. An index left invalid by an
    // interrupted build therefore survives every subsequent migration run, and the planner refuses
    // to use it — a silent, permanent fallback to sequential scans. Verified on Postgres 17.
    const name = embeddingIndexName("knowledge_chunks", "embedding", 768);
    expect(allEmbeddingIndexNames()).toContain(name);

    const calls: string[] = [];
    const q = {
      query: async (text: string, params?: unknown[]) => {
        calls.push(text);
        if (text.includes("indisvalid")) {
          expect(params?.[0]).toContain(name);
          return { rows: [{ relname: name }] };
        }
        return { rows: [] };
      },
    };

    expect(await dropInvalidEmbeddingIndexes(q)).toEqual([name]);
    expect(calls.some((c) => c === `DROP INDEX CONCURRENTLY IF EXISTS ${name}`)).toBe(true);
  });

  it("leaves a healthy index alone", async () => {
    // The drop must be conditional: an unconditional one would rebuild the whole corpus on every boot.
    const calls: string[] = [];
    const q = {
      query: async (text: string) => {
        calls.push(text);
        return { rows: [] };
      },
    };

    expect(await dropInvalidEmbeddingIndexes(q)).toEqual([]);
    expect(calls.some((c) => c.startsWith("DROP INDEX"))).toBe(false);
  });
});

/**
 * The backfill job asks "is there anything left to embed?" on every embedding table every five
 * minutes. Without a partial index that question is a sequential scan, and it is worst in the
 * healthy case: with nothing to do, Postgres must read every row to prove it.
 *
 * Measured on Postgres 17 with 200k embedded rows: `Seq Scan`, 1667 blocks, 5.24ms — versus
 * `Index Scan`, 1 block, 0.01ms with the index, which occupied 8192 bytes because it is empty.
 */
describe("backfillIndexStatements", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makePglite();
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    for (const { table, column } of EMBEDDING_COLUMNS) {
      await db.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, ${column} vector)`);
    }
  });

  afterEach(async () => {
    await db.close();
  });

  it("covers every embedding column, so no table is left to sequential scans", () => {
    const sql = backfillIndexStatements();
    expect(sql).toHaveLength(EMBEDDING_COLUMNS.length);
    for (const { table, column } of EMBEDDING_COLUMNS) {
      expect(sql.some((s) => s.includes(backfillIndexName(table, column)))).toBe(true);
    }
  });

  it("indexes only rows awaiting an embedding, which is what keeps it free", () => {
    for (const sql of backfillIndexStatements()) {
      expect(sql).toContain("WHERE embedding IS NULL");
      expect(sql).toContain("CONCURRENTLY");
    }
  });

  it("produces indexes Postgres accepts", async () => {
    for (const sql of backfillIndexStatements()) {
      // PGlite has no concurrent-build support; the shape is what is under test here.
      await db.query(sql.replace("CONCURRENTLY ", ""));
    }
  });

  /**
   * Built `CONCURRENTLY`, so an interrupted build leaves `indisvalid = false` — and
   * `IF NOT EXISTS` then skips it forever. Proven on Postgres 17: after simulating the interrupt,
   * an `IF NOT EXISTS` retry left `indisvalid=false`, while sweep-then-create restored it.
   */
  it("is swept when invalid, like the ANN indexes", () => {
    for (const { table, column } of EMBEDDING_COLUMNS) {
      expect(allEmbeddingIndexNames()).toContain(backfillIndexName(table, column));
    }
  });
});
