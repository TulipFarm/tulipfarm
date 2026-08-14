import type {
  MemoryCandidateSignals,
  MemoryEpisodeChunkType,
  MemoryEpisodeSourceType,
  MemoryRecallIndex,
  MemoryRecallIndexRequest,
  MemoryTelemetryPort,
} from "@tulipfarm/memory";
import {
  endMemorySpan,
  MEMORY_METRICS,
  MEMORY_SPANS,
  recordMemoryCounter,
  recordMemorySpanError,
  setMemorySpanAttributes,
  startMemorySpan,
} from "@tulipfarm/memory";
import type { Queryable } from "../db";
import { dimLiteral, embeddingDistanceSql } from "../vector-search";
import { embedOne, type MemoryEmbedder } from "./embedder";

/**
 * Postgres `MemoryRecallIndex`: three retrieval arms over `memory_assertions`. - **lexical** —
 * full-text search over the generated `tsv` column. - **entity** — overlap against the assertion's
 * extracted entities, which catches the case full-text misses: a query naming a person or project
 * whose statement never repeats the name. - **vector** — pgvector cosine distance, only when an
 * embedding provider is configured. Filtering by scope here would move half the access decision
 * away from the audit trail. Superseded, forgotten, and unconfirmed assertions are excluded,
 * because they are not candidates under any caller's authority.
 */

const candidateFloor = (alias: string): string =>
  `${alias}.status = 'active' AND ${alias}.confirmation = 'confirmed'`;

interface RecallArmHit {
  readonly assertionId: string;
  readonly chunkType?: MemoryEpisodeChunkType;
  readonly sourceType?: MemoryEpisodeSourceType;
}

export class PgMemoryRecallIndex implements MemoryRecallIndex {
  constructor(
    private readonly db: Queryable,
    private readonly embedder?: MemoryEmbedder,
    private readonly telemetry?: MemoryTelemetryPort
  ) {}

  async search(request: MemoryRecallIndexRequest): Promise<readonly MemoryCandidateSignals[]> {
    const span = startMemorySpan(this.telemetry, MEMORY_SPANS.episodeRecall);
    try {
      const [lexical, entity, vector] = await Promise.all([
        this.lexicalArm(request),
        this.entityArm(request),
        this.vectorArm(request),
      ]);

      this.recordEpisodeArm("lexical", lexical);
      this.recordEpisodeArm("vector", vector);

      const signals = new Map<
        string,
        { -readonly [K in keyof MemoryCandidateSignals]: MemoryCandidateSignals[K] }
      >();
      const record = (
        hits: readonly RecallArmHit[],
        arm: "lexicalRank" | "entityRank" | "vectorRank"
      ): void => {
        hits.forEach((hit, rank) => {
          const existing = signals.get(hit.assertionId) ?? { assertionId: hit.assertionId };
          existing[arm] = rank;
          signals.set(hit.assertionId, existing);
        });
      };

      record(lexical, "lexicalRank");
      record(entity, "entityRank");
      record(vector, "vectorRank");
      setMemorySpanAttributes(span, {
        outcome: "ok",
        lexical_candidates: lexical.length,
        entity_candidates: entity.length,
        vector_candidates: vector.length,
        episode_chunk_candidates:
          lexical.filter((hit) => hit.chunkType !== undefined).length +
          vector.filter((hit) => hit.chunkType !== undefined).length,
      });
      return [...signals.values()];
    } catch (error) {
      recordMemorySpanError(span, "episode_recall_failed");
      throw error;
    } finally {
      endMemorySpan(span);
    }
  }

  private recordEpisodeArm(arm: "lexical" | "vector", hits: readonly RecallArmHit[]): void {
    const episodeHits = hits.filter(
      (
        hit
      ): hit is RecallArmHit & {
        readonly chunkType: MemoryEpisodeChunkType;
        readonly sourceType: MemoryEpisodeSourceType;
      } => hit.chunkType !== undefined && hit.sourceType !== undefined
    );
    if (episodeHits.length === 0) {
      recordMemoryCounter(this.telemetry, MEMORY_METRICS.episodeRecallCandidates, 1, {
        arm,
        outcome: "empty",
      });
      return;
    }
    for (const hit of episodeHits) {
      recordMemoryCounter(this.telemetry, MEMORY_METRICS.episodeRecallCandidates, 1, {
        arm,
        outcome: "hit",
        source_type: hit.sourceType,
        chunk_type: hit.chunkType,
      });
    }
  }

  private async lexicalArm(request: MemoryRecallIndexRequest): Promise<RecallArmHit[]> {
    const { rows } = await this.db.query(
      `WITH query AS (SELECT websearch_to_tsquery('english', $2) AS q),
       hits AS (
         SELECT a.assertion_id, NULL::text AS chunk_type, NULL::text AS source_type,
                ts_rank(a.tsv, query.q) AS score
           FROM memory_assertions a, query
          WHERE a.business_id = $1
            AND ${candidateFloor("a")}
            AND a.tsv @@ query.q
         UNION ALL
         SELECT c.assertion_id, c.chunk_type, e.source_type, ts_rank(c.tsv, query.q) AS score
           FROM memory_chunks c
           JOIN memory_assertions a
             ON a.business_id = c.business_id AND a.assertion_id = c.assertion_id
           JOIN memory_episodes e
             ON e.business_id = c.business_id AND e.episode_id = c.episode_id,
                query
          WHERE c.business_id = $1
            AND ${candidateFloor("a")}
            AND c.tsv @@ query.q
       )
       SELECT assertion_id,
              (array_agg(chunk_type ORDER BY (chunk_type IS NULL), score DESC))[1] AS chunk_type,
              (array_agg(source_type ORDER BY (chunk_type IS NULL), score DESC))[1] AS source_type
         FROM hits
        GROUP BY assertion_id
        ORDER BY max(score) DESC, assertion_id
        LIMIT $3`,
      [request.businessId, request.query, request.limit]
    );
    return (
      rows as { assertion_id: string; chunk_type: string | null; source_type: string | null }[]
    ).map((row) => ({
      assertionId: row.assertion_id,
      ...(row.chunk_type === null ? {} : { chunkType: row.chunk_type as MemoryEpisodeChunkType }),
      ...(row.source_type === null
        ? {}
        : { sourceType: row.source_type as MemoryEpisodeSourceType }),
    }));
  }

  private async entityArm(request: MemoryRecallIndexRequest): Promise<RecallArmHit[]> {
    const terms = [...new Set(request.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
    if (terms.length === 0) return [];
    const { rows } = await this.db.query(
      `SELECT assertion_id,
              (SELECT count(*) FROM unnest(entities) AS e WHERE lower(e) = ANY($2::text[])) AS overlap
       FROM memory_assertions
       WHERE business_id = $1
         AND ${candidateFloor("memory_assertions")}
         AND EXISTS (
           SELECT 1 FROM unnest(entities) AS e
           WHERE lower(e) = ANY($2::text[])
         )
       ORDER BY overlap DESC, assertion_id
       LIMIT $3`,
      [request.businessId, terms, request.limit]
    );
    return (rows as { assertion_id: string }[]).map((row) => ({ assertionId: row.assertion_id }));
  }

  private async vectorArm(request: MemoryRecallIndexRequest): Promise<RecallArmHit[]> {
    if (this.embedder === undefined || !this.embedder.isAvailable()) return [];
    const embedded = await embedOne(this.embedder, request.query);
    if (embedded === undefined) return [];
    // Must be byte-identical to the indexed expressions, or Postgres quietly scans instead.
    const { sql: assertionDistance } = embeddingDistanceSql(
      "a.embedding",
      "$2",
      embedded.dimension
    );
    const { sql: chunkDistance } = embeddingDistanceSql("c.embedding", "$2", embedded.dimension);
    const { rows } = await this.db.query(
      `WITH hits AS (
         SELECT a.assertion_id, NULL::text AS chunk_type, NULL::text AS source_type,
                ${assertionDistance} AS distance
           FROM memory_assertions a
          WHERE a.business_id = $1
            AND ${candidateFloor("a")}
            AND a.embedding IS NOT NULL
            AND a.embedding_dim = ${dimLiteral(embedded.dimension)}
         UNION ALL
         SELECT c.assertion_id, c.chunk_type, e.source_type,
                ${chunkDistance} AS distance
           FROM memory_chunks c
           JOIN memory_assertions a
             ON a.business_id = c.business_id AND a.assertion_id = c.assertion_id
           JOIN memory_episodes e
             ON e.business_id = c.business_id AND e.episode_id = c.episode_id
          WHERE c.business_id = $1
            AND ${candidateFloor("a")}
            AND c.embedding IS NOT NULL
            AND c.embedding_dim = ${dimLiteral(embedded.dimension)}
       )
       SELECT assertion_id,
              (array_agg(chunk_type ORDER BY (chunk_type IS NULL), distance))[1] AS chunk_type,
              (array_agg(source_type ORDER BY (chunk_type IS NULL), distance))[1] AS source_type
         FROM hits
        GROUP BY assertion_id
        ORDER BY min(distance), assertion_id
        LIMIT $3`,
      [request.businessId, JSON.stringify(embedded.embedding), request.limit]
    );
    return (
      rows as { assertion_id: string; chunk_type: string | null; source_type: string | null }[]
    ).map((row) => ({
      assertionId: row.assertion_id,
      ...(row.chunk_type === null ? {} : { chunkType: row.chunk_type as MemoryEpisodeChunkType }),
      ...(row.source_type === null
        ? {}
        : { sourceType: row.source_type as MemoryEpisodeSourceType }),
    }));
  }
}
