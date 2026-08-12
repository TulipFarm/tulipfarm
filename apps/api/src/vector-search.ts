/**
 * ANN indexing for the embedding columns.
 *
 * Every embedding column is declared bare `vector`, deliberately: the dimension is not
 * configuration. It is whatever the active embedding provider returns, it is recorded per row in a
 * companion `dim` column, and it changes when the provider changes — which
 * `packages/llm/src/embeddings.ts` already detects and answers with a re-index.
 *
 * pgvector cannot index a bare `vector` column at all. Rather than pinning the column to one
 * dimension — which would break the moment a deployment switched embedding models, and would
 * outright exclude 3072-dimension models (see `MAX_VECTOR_HNSW_DIM`) — each supported dimension
 * gets a *partial expression* index over a cast of the column, and queries cast identically.
 *
 * The index expression and the query expression must match exactly or Postgres silently ignores
 * the index and falls back to a sequential scan. That is why both are generated here, from one
 * function, and nowhere else.
 */

/**
 * Dimensions that get an index: the output sizes of the embedding models in common use.
 * An unlisted dimension is not an error — it still returns correct results, just by scanning.
 */
export const INDEXED_EMBEDDING_DIMS = [768, 1024, 1536, 3072] as const;

/**
 * pgvector rejects an hnsw index above 2000 dimensions ("column cannot have more than 2000
 * dimensions for hnsw index"). `halfvec` stores the same vector as 16-bit floats and indexes up to
 * 4000, which is the only way to index 3072-dimension models such as `text-embedding-3-large`.
 * The cost is a small, well-documented recall loss; the alternative is no index at all.
 */
const MAX_VECTOR_HNSW_DIM = 2000;

type CastType = "vector" | "halfvec";

function castType(dim: number): CastType {
  return dim > MAX_VECTOR_HNSW_DIM ? "halfvec" : "vector";
}

function opClass(dim: number): string {
  return `${castType(dim)}_cosine_ops`;
}

export interface EmbeddingDistanceSql {
  /** Cosine-distance expression, e.g. `c.embedding::vector(1536) <=> $1::vector(1536)`. */
  readonly sql: string;
  /** False when the dimension has no index and the query will scan. */
  readonly indexed: boolean;
}

/**
 * Builds the cosine-distance expression for a vector search.
 *
 * `dim` is matched against `INDEXED_EMBEDDING_DIMS` and the *matched constant* is what gets
 * interpolated — never the caller's value — so this cannot be an injection point regardless of
 * where the dimension came from. The query vector stays a bind parameter either way; only the
 * dimension has to be literal, because a parameter cannot match an index expression.
 */
export function embeddingDistanceSql(
  column: string,
  vectorParam: string,
  dim: number
): EmbeddingDistanceSql {
  const indexed = INDEXED_EMBEDDING_DIMS.find((d) => d === dim);
  if (indexed === undefined) {
    return { sql: `${column} <=> ${vectorParam}::vector`, indexed: false };
  }
  const cast = `${castType(indexed)}(${indexed})`;
  return { sql: `${column}::${cast} <=> ${vectorParam}::${cast}`, indexed: true };
}

/**
 * `CREATE INDEX` statements for one embedding column — one partial index per supported dimension.
 *
 * Partial on `dim = N` so each index covers only the rows it can serve, which also means an
 * unused dimension costs nothing beyond an empty index. Built `CONCURRENTLY`, so the migration
 * declaring these must set `concurrent: true` (see `PgMigration`).
 */
export function embeddingIndexName(table: string, column: string, dim: number): string {
  return `${table}_${column}_${dim}_hnsw_idx`;
}

/** Every index name this module owns, across all tables and all indexed dimensions. */
export function allEmbeddingIndexNames(): string[] {
  return [
    ...EMBEDDING_COLUMNS.flatMap(({ table, column }) =>
      INDEXED_EMBEDDING_DIMS.map((dim) => embeddingIndexName(table, column, dim))
    ),
    // The backfill indexes are built `CONCURRENTLY` too, so they can be left invalid by the same
    // interrupted build — and would then be skipped by `IF NOT EXISTS` forever.
    ...EMBEDDING_COLUMNS.map(({ table, column }) => backfillIndexName(table, column)),
  ];
}

/**
 * Drops any of our HNSW indexes that Postgres has marked invalid.
 *
 * `CREATE INDEX CONCURRENTLY` is not atomic: if the build is interrupted — a statement timeout, a
 * deploy killing the pod, an OOM — it leaves the index in place with `indisvalid = false`. Such an
 * index is dead weight: the planner will not use it even with `enable_seqscan = off`, yet it is
 * still maintained on every write.
 *
 * The trap is that re-running the build does *not* repair it. `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS` matches on the name alone, sees the invalid index, and skips — so the migration reports
 * success forever while every vector query silently falls back to a sequential scan, which is the
 * exact failure this whole index set exists to remove. Verified against Postgres 17: after an
 * interrupted build, re-running the identical statement leaves `indisvalid = false`.
 *
 * So invalid ones must be dropped *before* the create. Only invalid ones — an unconditional
 * `DROP ... IF EXISTS` would discard a healthy index and rebuild the entire corpus on every boot.
 */
export async function dropInvalidEmbeddingIndexes(
  q: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  log?: (msg: string) => void
): Promise<string[]> {
  const { rows } = await q.query(
    `SELECT c.relname FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indisvalid = false AND c.relname = ANY($1::text[])`,
    [allEmbeddingIndexNames()]
  );
  const dropped = rows.map((r) => r.relname as string);
  for (const name of dropped) {
    log?.(`dropping invalid embedding index ${name}; it will be rebuilt`);
    // Concurrently, for the same reason the build is: no exclusive lock on a live table.
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  }
  return dropped;
}

/**
 * Brings every embedding ANN index into a valid state: sweeps invalid ones, then builds whatever
 * is missing.
 *
 * Runs on every boot, not only inside the migration that introduced these indexes. A migration
 * fires once, while `indisvalid = false` can happen at any later point — an interrupted `REINDEX`,
 * a manual rebuild, a cancelled maintenance window. Left unswept, the index stays in place, keeps
 * costing write amplification, and is silently ignored by the planner.
 *
 * Cheap when healthy: one catalog query, then `IF NOT EXISTS` no-ops. A rebuild only happens when
 * something is genuinely broken, which is exactly when it should.
 */
export async function ensureEmbeddingIndexes(
  q: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  log?: (msg: string) => void
): Promise<string[]> {
  // Sweep strictly first. These creates are `IF NOT EXISTS`, which matches on name alone and would
  // happily skip an index left `indisvalid = false` — and a sweep afterwards would then drop it
  // with nothing left to rebuild it until the next boot.
  const swept = await dropInvalidEmbeddingIndexes(q, log);
  // Unconditional: unlike the HNSW rebuild below this is a cheap no-op once present, and the
  // backfill sweep that depends on it runs every five minutes from boot.
  for (const sql of backfillIndexStatements()) {
    await q.query(sql);
  }
  if (swept.length === 0) return swept;
  for (const { table, column, dimColumn } of EMBEDDING_COLUMNS) {
    for (const sql of embeddingIndexStatements(table, column, dimColumn)) {
      await q.query(sql);
    }
  }
  log?.(`rebuilt ${swept.length} embedding index(es)`);
  return swept;
}

/** Index name for the un-embedded-rows sweep on one embedding column. */
export function backfillIndexName(table: string, column: string): string {
  return `${table}_${column}_null_idx`;
}

/**
 * Partial indexes over rows that still need an embedding.
 *
 * `embeddingBackfill` asks "is there anything left to embed?" on every table every five minutes.
 * Without these that question is a **sequential scan of the entire table**, and it is worst in the
 * healthy case: with zero un-embedded rows Postgres must read every row to prove the answer is
 * none. Measured on the dev database, the `LIMIT 100` probe planned as `Limit -> Seq Scan` on both
 * `knowledge_chunks` and `memory_chunks`.
 *
 * A partial index costs almost nothing precisely because of that same asymmetry: it only contains
 * rows awaiting an embedding, so in the steady state it is empty.
 */
export function backfillIndexStatements(): string[] {
  return EMBEDDING_COLUMNS.map(
    ({ table, column }) =>
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${backfillIndexName(table, column)} ` +
      `ON ${table} (${column}) WHERE ${column} IS NULL`
  );
}

export function embeddingIndexStatements(
  table: string,
  column: string,
  dimColumn: string
): string[] {
  return INDEXED_EMBEDDING_DIMS.map((dim) => {
    // Two sets of parentheses, both required: the outer pair is the index column list, the inner
    // pair marks the cast as an expression. `hnsw (expr opclass)` without them is a syntax error.
    const target = `((${column}::${castType(dim)}(${dim})) ${opClass(dim)})`;
    return (
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${embeddingIndexName(table, column, dim)} ` +
      `ON ${table} USING hnsw ${target} WHERE ${dimColumn} = ${dim}`
    );
  });
}

/**
 * The dimension as a SQL literal, for the `dim = N` predicate that selects a partial index.
 *
 * A bind parameter there would leave the planner unable to prove the partial index applies, so the
 * value has to be inline — which is why it is validated to be a plain positive integer first. The
 * result can only ever be digits.
 */
export function dimLiteral(dim: number): string {
  if (!Number.isSafeInteger(dim) || dim <= 0) {
    throw new Error(`invalid embedding dimension: ${String(dim)}`);
  }
  return String(dim);
}

/** Every embedding column in the schema, with the column recording each row's dimension. */
export const EMBEDDING_COLUMNS: readonly {
  table: string;
  column: string;
  dimColumn: string;
}[] = [
  { table: "knowledge_chunks", column: "embedding", dimColumn: "dim" },
  { table: "knowledge_source_chunks", column: "embedding", dimColumn: "dim" },
  { table: "memory_assertions", column: "embedding", dimColumn: "embedding_dim" },
  { table: "memory_chunks", column: "embedding", dimColumn: "embedding_dim" },
];
