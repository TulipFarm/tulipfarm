/** ANN indexes use generated cast expressions; query and index expressions must match exactly. */

/** Indexed embedding dimensions; unlisted dimensions are correct but scan. */
export const INDEXED_EMBEDDING_DIMS = [768, 1024, 1536, 3072] as const;

/** Use `halfvec` above 2000 dimensions; pgvector HNSW rejects larger `vector` indexes. */
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

/** Interpolate only matched dimension constants; keep the query vector as a bind parameter. */
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

/** Build one concurrent partial index per supported dimension; migrations must be concurrent. */
export function embeddingIndexName(table: string, column: string, dim: number): string {
  return `${table}_${column}_${dim}_hnsw_idx`;
}

/** Every index name this module owns, across all tables and all indexed dimensions. */
export function allEmbeddingIndexNames(): string[] {
  return [
    ...EMBEDDING_COLUMNS.flatMap(({ table, column }) =>
      INDEXED_EMBEDDING_DIMS.map((dim) => embeddingIndexName(table, column, dim))
    ),
    // Backfill indexes are concurrent too; invalid ones would be skipped by `IF NOT EXISTS`.
    ...EMBEDDING_COLUMNS.map(({ table, column }) => backfillIndexName(table, column)),
  ];
}

/** Drop invalid concurrent indexes before create; `IF NOT EXISTS` will not repair them. */
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

/** On every boot, sweep invalid ANN indexes before creating missing ones. */
export async function ensureEmbeddingIndexes(
  q: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  log?: (msg: string) => void
): Promise<string[]> {
  // Sweep first; `IF NOT EXISTS` matches invalid indexes by name and would skip repair.
  const swept = await dropInvalidEmbeddingIndexes(q, log);
  // Unconditional cheap no-op; the backfill sweep depends on it from boot.
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

/** Partial indexes for rows awaiting embeddings; the healthy case should not seq-scan. */
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
    // Both parentheses are required: index column list outside, expression cast inside.
    const target = `((${column}::${castType(dim)}(${dim})) ${opClass(dim)})`;
    return (
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${embeddingIndexName(table, column, dim)} ` +
      `ON ${table} USING hnsw ${target} WHERE ${dimColumn} = ${dim}`
    );
  });
}

/** SQL literal for `dim = N`; validate first because binds cannot select the partial index. */
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
];
