import type {
  EmbeddingPort,
  KnowledgeCandidate,
  KnowledgeIndexEntry,
  KnowledgeIndexQuery,
  MutableKnowledgeIndexPort,
} from "@tulipfarm/knowledge";
import { dimLiteral, embeddingDistanceSql } from "@tulipfarm/storage";
import type { Queryable } from "../db";

interface KnowledgeSourceChunkRow {
  source_id: string;
  chunk_id: string;
  revision: string;
  classification: string[];
  digest: string;
  content: string;
}

function rowToCandidate(row: KnowledgeSourceChunkRow, score: number): KnowledgeCandidate {
  return {
    sourceId: row.source_id,
    chunkId: row.chunk_id,
    revision: row.revision,
    score,
    classification: row.classification,
    digest: row.digest,
    snippet: row.content,
  };
}

/** Postgres Knowledge index; search is vector-first with lexical fallback. */
export class PgKnowledgeIndexStore implements MutableKnowledgeIndexPort {
  constructor(
    private readonly q: Queryable,
    private readonly embeddings: EmbeddingPort
  ) {}

  async upsert(entry: KnowledgeIndexEntry): Promise<void> {
    const active = this.embeddings.isAvailable() ? this.embeddings.getActive() : null;
    const activeModel = active?.model ?? null;

    let vector: number[] | null = null;
    let dim: number | null = null;
    const { rows: existingRows } = await this.q.query(
      "SELECT digest, model, dim, embedding FROM knowledge_source_chunks " +
        "WHERE business_id = $1 AND chunk_id = $2",
      [entry.businessId, entry.chunkId]
    );
    const existing = existingRows[0] as
      | { digest: string; model: string | null; dim: number | null; embedding: unknown }
      | undefined;
    if (
      existing &&
      activeModel !== null &&
      existing.digest === entry.digest &&
      existing.model === activeModel &&
      existing.embedding !== null
    ) {
      vector = parseVector(existing.embedding);
      dim = existing.dim;
    } else if (active !== null) {
      try {
        const out = await this.embeddings.embedMany([entry.text]);
        const embedded = out.embeddings[0];
        if (embedded) {
          vector = embedded;
          dim = out.dimension;
        }
      } catch {
        // No usable embedding this pass; the chunk is stored lexical-only and picked up by a
        // later resync once the provider recovers, same fallback as ../knowledge/index-service.ts.
      }
    }

    await this.q.query(
      `INSERT INTO knowledge_source_chunks
         (business_id, source_id, chunk_id, revision, classification, digest, content,
          embedding, tsv, model, dim, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8::vector,to_tsvector('english', $7),$9,$10,now(),now())
       ON CONFLICT (business_id, chunk_id) DO UPDATE SET
         source_id = EXCLUDED.source_id,
         revision = EXCLUDED.revision,
         classification = EXCLUDED.classification,
         digest = EXCLUDED.digest,
         content = EXCLUDED.content,
         embedding = EXCLUDED.embedding,
         tsv = EXCLUDED.tsv,
         model = EXCLUDED.model,
         dim = EXCLUDED.dim,
         updated_at = now()`,
      [
        entry.businessId,
        entry.sourceId,
        entry.chunkId,
        entry.revision,
        entry.classification,
        entry.digest,
        entry.text,
        vector === null ? null : JSON.stringify(vector),
        vector === null ? null : activeModel,
        vector === null ? null : dim,
      ]
    );
  }

  async removeSource(businessId: string, sourceId: string): Promise<number> {
    const { rows } = await this.q.query(
      "DELETE FROM knowledge_source_chunks WHERE business_id = $1 AND source_id = $2 " +
        "RETURNING chunk_id",
      [businessId, sourceId]
    );
    return rows.length;
  }

  /** Message-granularity removal (e.g. a deleted Slack message) — the source itself stays live. */
  async removeChunk(businessId: string, sourceId: string, chunkId: string): Promise<void> {
    await this.q.query(
      "DELETE FROM knowledge_source_chunks WHERE business_id = $1 AND source_id = $2 AND chunk_id = $3",
      [businessId, sourceId, chunkId]
    );
  }

  async search(query: KnowledgeIndexQuery): Promise<readonly KnowledgeCandidate[]> {
    if (query.allowedSourceIds.size === 0) return [];
    const sourceIds = [...query.allowedSourceIds];

    if (this.embeddings.isAvailable()) {
      const active = this.embeddings.getActive();
      if (active?.dimension) {
        const out = await this.embeddings.embedMany([query.query]);
        const vec = out.embeddings[0];
        if (vec) {
          return this.searchVector(query.businessId, sourceIds, vec, out.dimension, query.limit);
        }
      }
    }
    return this.searchLexical(query.businessId, sourceIds, query.query, query.limit);
  }

  private async searchVector(
    businessId: string,
    sourceIds: readonly string[],
    queryEmbedding: number[],
    dim: number,
    limit: number
  ): Promise<KnowledgeCandidate[]> {
    // Must be byte-identical to the indexed expression, or Postgres quietly scans instead.
    const { sql: distance } = embeddingDistanceSql("embedding", "$1", dim);
    const { rows } = await this.q.query(
      `SELECT source_id, chunk_id, revision, classification, digest, content,
              (${distance}) AS distance
       FROM knowledge_source_chunks
       WHERE business_id = $2 AND source_id = ANY($3::text[])
         AND embedding IS NOT NULL AND dim = ${dimLiteral(dim)}
       ORDER BY ${distance}
       LIMIT $4`,
      [JSON.stringify(queryEmbedding), businessId, sourceIds, limit]
    );
    return (rows as unknown as Array<KnowledgeSourceChunkRow & { distance: number }>).map((row) =>
      rowToCandidate(row, 1 - Number(row.distance))
    );
  }

  private async searchLexical(
    businessId: string,
    sourceIds: readonly string[],
    queryText: string,
    limit: number
  ): Promise<KnowledgeCandidate[]> {
    const { rows } = await this.q.query(
      `SELECT source_id, chunk_id, revision, classification, digest, content,
              ts_rank(tsv, websearch_to_tsquery('english', $1)) AS rank
       FROM knowledge_source_chunks
       WHERE business_id = $2 AND source_id = ANY($3::text[])
         AND tsv @@ websearch_to_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $4`,
      [queryText, businessId, sourceIds, limit]
    );
    return (rows as unknown as Array<KnowledgeSourceChunkRow & { rank: number }>).map((row) =>
      rowToCandidate(row, Number(row.rank))
    );
  }
}

/** Parse a pgvector value (returned as a `"[1,2,3]"` string) back into a number[]. */
function parseVector(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value as number[];
  const text = String(value).trim();
  if (text.length === 0 || text === "[]") return null;
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((n) => Number(n));
}
