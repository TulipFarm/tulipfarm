import { randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import type { ChunkInput, KnowledgeSource, SearchFilters, SearchHit } from "./types";

/** Push `d.*` filter conditions onto `params` and return the SQL fragments. */
function docFilterConditions(filters: SearchFilters, params: unknown[]): string[] {
  const conds: string[] = [];
  if (filters.domain !== undefined) {
    params.push(filters.domain);
    conds.push(`d.domain = $${params.length}`);
  }
  if (filters.source !== undefined) {
    params.push(filters.source);
    conds.push(`d.source = $${params.length}`);
  }
  if (filters.tags && filters.tags.length > 0) {
    params.push(filters.tags);
    conds.push(`d.tags @> $${params.length}::text[]`);
  }
  return conds;
}

function rowToHit(row: Record<string, unknown>, score: number): SearchHit {
  return {
    documentId: row.document_id as string,
    chunkId: row.chunk_id as string,
    title: row.title as string,
    content: row.content as string,
    source: row.source as KnowledgeSource,
    score,
  };
}

export interface KnowledgeChunkRepo {
  deleteByDocument(documentId: string): Promise<void>;
  insertMany(documentId: string, chunks: ChunkInput[]): Promise<void>;
  /** Cosine exact-scan over chunks whose stored dim matches the active model. */
  searchVector(
    queryEmbedding: number[],
    dim: number,
    limit: number,
    filters: SearchFilters
  ): Promise<SearchHit[]>;
  /** Lexical fallback via `websearch_to_tsquery` + `ts_rank`. */
  searchLexical(query: string, limit: number, filters: SearchFilters): Promise<SearchHit[]>;
}

export class PgKnowledgeChunkRepo implements KnowledgeChunkRepo {
  constructor(private readonly q: Queryable) {}

  async deleteByDocument(documentId: string): Promise<void> {
    await this.q.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [documentId]);
  }

  async insertMany(documentId: string, chunks: ChunkInput[]): Promise<void> {
    for (const chunk of chunks) {
      await this.q.query(
        `INSERT INTO knowledge_chunks
           (id, document_id, chunk_index, content, embedding, tsv, model, dim, created_at)
         VALUES ($1, $2, $3, $4, $5::vector, to_tsvector('english', $4), $6, $7, now())`,
        [
          randomUUID(),
          documentId,
          chunk.chunkIndex,
          chunk.content,
          chunk.embedding === null ? null : JSON.stringify(chunk.embedding),
          chunk.model,
          chunk.dim,
        ]
      );
    }
  }

  async searchVector(
    queryEmbedding: number[],
    dim: number,
    limit: number,
    filters: SearchFilters
  ): Promise<SearchHit[]> {
    const params: unknown[] = [JSON.stringify(queryEmbedding), dim];
    const conds = docFilterConditions(filters, params);
    const filterSql = conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "";
    params.push(limit);
    const { rows } = await this.q.query(
      `SELECT c.id AS chunk_id, c.document_id, c.content, d.title, d.source,
              (c.embedding <=> $1::vector) AS distance
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL AND c.dim = $2 AND d.active = true${filterSql}
       ORDER BY c.embedding <=> $1::vector
       LIMIT $${params.length}`,
      params
    );
    // cosine distance ∈ [0,2] → similarity score = 1 - distance.
    return rows.map((r) => rowToHit(r, 1 - Number((r as { distance: number }).distance)));
  }

  async searchLexical(query: string, limit: number, filters: SearchFilters): Promise<SearchHit[]> {
    const params: unknown[] = [query];
    const conds = docFilterConditions(filters, params);
    const filterSql = conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "";
    params.push(limit);
    const { rows } = await this.q.query(
      `SELECT c.id AS chunk_id, c.document_id, c.content, d.title, d.source,
              ts_rank(c.tsv, websearch_to_tsquery('english', $1)) AS rank
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.tsv @@ websearch_to_tsquery('english', $1) AND d.active = true${filterSql}
       ORDER BY rank DESC
       LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => rowToHit(r, Number((r as { rank: number }).rank)));
  }
}
