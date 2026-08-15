import { randomUUID } from "node:crypto";
import {
  dimLiteral,
  embeddingDistanceSql,
  type Queryable,
  withTransaction,
} from "@tulipfarm/storage";
import type {
  ChunkInput,
  ExistingChunk,
  IndexingStatus,
  IndexStats,
  KnowledgeSource,
  SearchFilters,
  SearchHit,
} from "./types";

/** Parse a pgvector value (returned as a `"[1,2,3]"` string) back into a number[] for reuse. */
function parseVector(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value as number[];
  const text = String(value).trim();
  // An empty/degenerate vector string means "no usable embedding" → null, so the reuse check
  // (`prior.embedding !== null`) correctly treats it as not reusable.
  if (text.length === 0 || text === "[]") return null;
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((n) => Number(n));
}

/** Push `p.*` filter conditions onto `params` and return the SQL fragments. */
export function pageFilterConditions(filters: SearchFilters, params: unknown[]): string[] {
  const conds: string[] = [];
  if (filters.domain !== undefined) {
    params.push(filters.domain);
    conds.push(`p.domain = $${params.length}`);
  }
  if (filters.source !== undefined) {
    params.push(filters.source);
    conds.push(`p.source = $${params.length}`);
  }
  if (filters.tags && filters.tags.length > 0) {
    params.push(filters.tags);
    conds.push(`p.tags @> $${params.length}::text[]`);
  }
  // Scope to one space. Rides the existing `JOIN knowledge_pages p`, so no chunk-level
  // space_id column is needed — both the vector and lexical paths inherit this predicate.
  if (filters.spaceId !== undefined) {
    params.push(filters.spaceId);
    conds.push(`p.space_id = $${params.length}`);
  }
  if (filters.type !== undefined) {
    params.push(filters.type);
    conds.push(`p.type = $${params.length}`);
  }
  return conds;
}

function rowToHit(row: Record<string, unknown>, score: number): SearchHit {
  return {
    pageId: row.page_id as string,
    chunkId: row.chunk_id as string,
    title: row.title as string,
    content: row.content as string,
    source: row.source as KnowledgeSource,
    score,
  };
}

export interface KnowledgeChunkRepo {
  deleteByPage(pageId: string): Promise<void>;
  insertMany(pageId: string, chunks: ChunkInput[]): Promise<void>;
  /** Atomically replace one page's complete chunk generation. */
  replaceForPage(pageId: string, chunks: ChunkInput[]): Promise<void>;
  /** Existing chunks (ordered by chunk_index) projected for the re-index content-hash diff. */
  listByPageForDiff(pageId: string): Promise<ExistingChunk[]>;
  /** Cosine exact-scan over chunks whose stored dim matches the active model. */
  searchVector(
    queryEmbedding: number[],
    dim: number,
    limit: number,
    filters: SearchFilters
  ): Promise<SearchHit[]>;
  /** Lexical fallback via `websearch_to_tsquery` + `ts_rank`. */
  searchLexical(query: string, limit: number, filters: SearchFilters): Promise<SearchHit[]>;
  /** Derived per-page index state: pending (no chunks) | lexical-only (chunks, null embeddings) | indexed. */
  getIndexingStatus(pageId: string): Promise<IndexingStatus>;
  /** Batch variant — one grouped query; ids absent from the result default to "pending". */
  getIndexingStatuses(pageIds: string[]): Promise<Map<string, IndexingStatus>>;
  /**
   * Active pages with a chunk that is unembedded, embedded under a stale model, or embedded at a
   * width other than the active one — backfill targets.
   */
  listPageIdsNeedingEmbedding(activeModel: string, activeDim?: number | null): Promise<string[]>;
  /**
   * How many stored vectors are at a width other than `dim`. `searchVector` matches on exact
   * width, so every such chunk is unreachable by vector search until it is re-embedded — and the
   * in-memory dimension-change flag cannot see a change that happened across a restart.
   */
  countStaleDimension(dim: number): Promise<number>;
  /** Aggregate index health (counts + max lag), all from our own tables. */
  indexStats(): Promise<IndexStats>;
}

export class PgKnowledgeChunkRepo implements KnowledgeChunkRepo {
  constructor(private readonly q: Queryable) {}

  async deleteByPage(pageId: string): Promise<void> {
    await this.q.query("DELETE FROM knowledge_chunks WHERE page_id = $1", [pageId]);
  }

  async insertMany(pageId: string, chunks: ChunkInput[]): Promise<void> {
    await this.insertManyWith(this.q, pageId, chunks);
  }

  async replaceForPage(pageId: string, chunks: ChunkInput[]): Promise<void> {
    await withTransaction(this.q, async (tx) => {
      // Lock the parent so concurrent reindexes for this page cannot interleave generations.
      await tx.query("SELECT id FROM knowledge_pages WHERE id = $1 FOR UPDATE", [pageId]);
      await tx.query("DELETE FROM knowledge_chunks WHERE page_id = $1", [pageId]);
      await this.insertManyWith(tx, pageId, chunks);
    });
  }

  private async insertManyWith(q: Queryable, pageId: string, chunks: ChunkInput[]): Promise<void> {
    for (const chunk of chunks) {
      await q.query(
        `INSERT INTO knowledge_chunks
           (id, page_id, chunk_index, content, content_hash, embedding, tsv, model, dim, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::vector, to_tsvector('english', $4), $7, $8, now())`,
        [
          randomUUID(),
          pageId,
          chunk.chunkIndex,
          chunk.content,
          chunk.contentHash,
          chunk.embedding === null ? null : JSON.stringify(chunk.embedding),
          chunk.model,
          chunk.dim,
        ]
      );
    }
  }

  async listByPageForDiff(pageId: string): Promise<ExistingChunk[]> {
    const { rows } = await this.q.query(
      `SELECT chunk_index, content_hash, embedding, model, dim
       FROM knowledge_chunks WHERE page_id = $1 ORDER BY chunk_index`,
      [pageId]
    );
    return (
      rows as Array<{
        chunk_index: number;
        content_hash: string | null;
        embedding: unknown;
        model: string | null;
        dim: number | null;
      }>
    ).map((r) => ({
      chunkIndex: Number(r.chunk_index),
      contentHash: r.content_hash,
      embedding: parseVector(r.embedding),
      model: r.model,
      dim: r.dim === null ? null : Number(r.dim),
    }));
  }

  async searchVector(
    queryEmbedding: number[],
    dim: number,
    limit: number,
    filters: SearchFilters
  ): Promise<SearchHit[]> {
    const params: unknown[] = [JSON.stringify(queryEmbedding)];
    const conds = pageFilterConditions(filters, params);
    const filterSql = conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "";
    params.push(limit);
    // Must be byte-identical to the indexed expression, or Postgres quietly scans instead.
    const { sql: distance } = embeddingDistanceSql("c.embedding", "$1", dim);
    const { rows } = await this.q.query(
      `SELECT c.id AS chunk_id, c.page_id, c.content, p.title, p.source,
              (${distance}) AS distance
       FROM knowledge_chunks c JOIN knowledge_pages p ON p.id = c.page_id
       WHERE c.embedding IS NOT NULL AND c.dim = ${dimLiteral(dim)} AND p.active = true${filterSql}
       ORDER BY ${distance}
       LIMIT $${params.length}`,
      params
    );
    // cosine distance ∈ [0,2] → similarity score = 1 - distance.
    return rows.map((r) => rowToHit(r, 1 - Number((r as { distance: number }).distance)));
  }

  async searchLexical(query: string, limit: number, filters: SearchFilters): Promise<SearchHit[]> {
    const params: unknown[] = [query];
    const conds = pageFilterConditions(filters, params);
    const filterSql = conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "";
    params.push(limit);
    const { rows } = await this.q.query(
      `SELECT c.id AS chunk_id, c.page_id, c.content, p.title, p.source,
              ts_rank(c.tsv, websearch_to_tsquery('english', $1)) AS rank
       FROM knowledge_chunks c JOIN knowledge_pages p ON p.id = c.page_id
       WHERE c.tsv @@ websearch_to_tsquery('english', $1) AND p.active = true${filterSql}
       ORDER BY rank DESC
       LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => rowToHit(r, Number((r as { rank: number }).rank)));
  }

  async getIndexingStatuses(pageIds: string[]): Promise<Map<string, IndexingStatus>> {
    const result = new Map<string, IndexingStatus>();
    if (pageIds.length === 0) return result;
    for (const id of pageIds) result.set(id, "pending");
    const { rows } = await this.q.query(
      `SELECT page_id,
              CASE WHEN bool_and(embedding IS NOT NULL) THEN 'indexed' ELSE 'lexical-only' END AS status
       FROM knowledge_chunks
       WHERE page_id = ANY($1::uuid[])
       GROUP BY page_id`,
      [pageIds]
    );
    for (const r of rows as Array<{ page_id: string; status: IndexingStatus }>) {
      result.set(r.page_id, r.status);
    }
    return result;
  }

  async getIndexingStatus(pageId: string): Promise<IndexingStatus> {
    const statuses = await this.getIndexingStatuses([pageId]);
    return statuses.get(pageId) ?? "pending";
  }

  async listPageIdsNeedingEmbedding(
    activeModel: string,
    activeDim?: number | null
  ): Promise<string[]> {
    const dimCondition =
      activeDim === undefined || activeDim === null ? "" : " OR c.dim IS DISTINCT FROM $2";
    const params: unknown[] = [activeModel];
    if (dimCondition) params.push(activeDim);
    const { rows } = await this.q.query(
      `SELECT DISTINCT p.id
       FROM knowledge_pages p
       JOIN knowledge_chunks c ON c.page_id = p.id
       WHERE p.active = true
         AND (c.embedding IS NULL OR c.model IS DISTINCT FROM $1${dimCondition})`,
      params
    );
    return (rows as Array<{ id: string }>).map((r) => r.id);
  }

  async countStaleDimension(dim: number): Promise<number> {
    const { rows } = await this.q.query(
      `SELECT count(*)::int AS n FROM knowledge_chunks
       WHERE embedding IS NOT NULL AND dim IS DISTINCT FROM $1`,
      [dim]
    );
    return (rows[0] as { n: number } | undefined)?.n ?? 0;
  }

  async indexStats(): Promise<IndexStats> {
    const { rows } = await this.q.query(
      `WITH per_page AS (
         SELECT p.id, p.updated_at, MAX(c.created_at) AS last_chunk
         FROM knowledge_pages p
         LEFT JOIN knowledge_chunks c ON c.page_id = p.id
         WHERE p.active = true
         GROUP BY p.id, p.updated_at
       )
       SELECT
         (SELECT count(*) FROM knowledge_pages WHERE active = true)::int AS active_pages,
         (SELECT count(*) FROM knowledge_chunks)::int AS total_chunks,
         (SELECT count(*) FROM knowledge_chunks WHERE embedding IS NOT NULL)::int AS embedded_chunks,
         (SELECT count(*) FROM knowledge_chunks WHERE embedding IS NULL)::int AS lexical_chunks,
         (SELECT MAX(EXTRACT(EPOCH FROM (updated_at - last_chunk)))
            FROM per_page WHERE last_chunk IS NOT NULL AND updated_at > last_chunk) AS max_lag_seconds`
    );
    const r = rows[0] as {
      active_pages: number;
      total_chunks: number;
      embedded_chunks: number;
      lexical_chunks: number;
      max_lag_seconds: number | null;
    };
    return {
      activePages: Number(r.active_pages),
      totalChunks: Number(r.total_chunks),
      embeddedChunks: Number(r.embedded_chunks),
      lexicalChunks: Number(r.lexical_chunks),
      maxLagSeconds: r.max_lag_seconds === null ? null : Number(r.max_lag_seconds),
    };
  }
}
