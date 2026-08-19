import type { Queryable } from "@tulipfarm/storage";
import type { KnowledgeSubjectKind } from "../subject";
import type { ExtractionStore } from "./extract";
import type { GraphInvalidationPort } from "./invalidate";
import type { GraphSearchStore } from "./search";
import {
  type ExtractionOutput,
  edgeKey,
  entityKey,
  type GraphChunk,
  type GraphCommunityRecord,
  type GraphCommunitySummaryRecord,
  type GraphEntityRecord,
} from "./types";

/** A bare `%` in a user query would otherwise match every entity in the business. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toEntity(row: Record<string, unknown>): GraphEntityRecord {
  return {
    entityId: row.id as string,
    businessId: row.business_id as string,
    name: row.name as string,
    type: row.type as string,
    description: (row.description as string) ?? "",
    sourceChunkIds: (row.source_chunk_ids as string[]) ?? [],
  };
}

function toSummary(row: Record<string, unknown>): GraphCommunitySummaryRecord {
  return {
    communityId: row.community_id as string,
    businessId: row.business_id as string,
    buildId: row.build_id as string,
    title: row.title as string,
    summary: row.summary as string,
    provenanceChunkIds: (row.provenance_chunk_ids as string[]) ?? [],
    usage: {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    },
  };
}

/**
 * Postgres store for the GraphRAG tables. Takes a `Queryable` and never opens a pool, so the caller
 * decides the transaction boundary — a build writes entities, edges and communities as one unit.
 */
export class PgGraphRagRepo implements ExtractionStore, GraphSearchStore, GraphInvalidationPort {
  constructor(
    private readonly db: Queryable,
    private readonly businessId: string,
    private readonly buildId: string
  ) {}

  async loadExtractedRevisions(chunkIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (chunkIds.length === 0) return new Map();
    const { rows } = await this.db.query<{ chunk_id: string; revision: string }>(
      `SELECT chunk_id, revision FROM knowledge_graph_extractions
        WHERE business_id = $1 AND chunk_id = ANY($2::text[])`,
      [this.businessId, [...chunkIds]]
    );
    return new Map(rows.map((row) => [row.chunk_id, row.revision]));
  }

  async saveExtraction(chunk: GraphChunk, output: ExtractionOutput): Promise<void> {
    const idByKey = new Map<string, string>();
    const keysByName = new Map<string, string[]>();
    for (const entity of output.entities) {
      const key = entityKey(this.businessId, entity.name, entity.type);
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO knowledge_graph_entities
           (business_id, entity_key, name, type, description, source_chunk_ids, build_id)
         VALUES ($1, $2, $3, $4, $5, ARRAY[$6]::text[], $7)
         ON CONFLICT (business_id, entity_key) DO UPDATE SET
           description = CASE
             WHEN length(EXCLUDED.description) > length(knowledge_graph_entities.description)
             THEN EXCLUDED.description ELSE knowledge_graph_entities.description END,
           source_chunk_ids = (
             SELECT array_agg(DISTINCT c) FROM unnest(
               knowledge_graph_entities.source_chunk_ids || EXCLUDED.source_chunk_ids
             ) AS c
           ),
           build_id = EXCLUDED.build_id,
           updated_at = now()
         RETURNING id`,
        [
          this.businessId,
          key,
          entity.name,
          entity.type,
          entity.description,
          chunk.chunkId,
          this.buildId,
        ]
      );
      const id = rows[0]?.id;
      if (id === undefined) continue;
      idByKey.set(key, id);
      const name = entity.name.trim().toLowerCase();
      keysByName.set(name, [...(keysByName.get(name) ?? []), key]);
    }

    // Relationship endpoints arrive as bare names, but identity is `(name, type)`. When one chunk
    // yields "Mercury" the project and "Mercury" the person, a name alone cannot say which was
    // meant, and picking one would assert a relationship the model never stated.
    const resolve = (name: string): string | undefined => {
      const keys = keysByName.get(name.trim().toLowerCase()) ?? [];
      return keys.length === 1 ? idByKey.get(keys[0] ?? "") : undefined;
    };

    for (const relationship of output.relationships) {
      const source = resolve(relationship.source);
      const target = resolve(relationship.target);
      // A relationship naming an entity the same call did not produce, or naming one ambiguously,
      // is dropped rather than guessed at: an edge to a mis-resolved entity is a false provenance
      // claim, and provenance is what the ACL check runs on.
      if (source === undefined || target === undefined || source === target) continue;
      await this.db.query(
        `INSERT INTO knowledge_graph_edges
           (business_id, edge_key, source_entity_id, target_entity_id, description, weight,
            source_chunk_ids, build_id)
         VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7]::text[], $8)
         ON CONFLICT (business_id, edge_key) DO UPDATE SET
           source_chunk_ids = (
             SELECT array_agg(DISTINCT c) FROM unnest(
               knowledge_graph_edges.source_chunk_ids || EXCLUDED.source_chunk_ids
             ) AS c
           ),
           -- Weight is how many distinct chunks attest to this relationship, recomputed from the
           -- merged provenance rather than accumulated. Adding on every upsert would make weight a
           -- function of edit history -- re-extracting a chunk counts it twice -- and clustering
           -- would stop being reproducible, which was the whole reason it is deterministic.
           weight = (
             SELECT count(DISTINCT c) FROM unnest(
               knowledge_graph_edges.source_chunk_ids || EXCLUDED.source_chunk_ids
             ) AS c
           ),
           build_id = EXCLUDED.build_id,
           updated_at = now()`,
        [
          this.businessId,
          edgeKey(this.businessId, source, target),
          source,
          target,
          relationship.description,
          1,
          chunk.chunkId,
          this.buildId,
        ]
      );
    }

    await this.db.query(
      `INSERT INTO knowledge_graph_extractions
         (business_id, chunk_id, subject_kind, subject_id, revision, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, chunk_id) DO UPDATE SET
         revision = EXCLUDED.revision,
         subject_kind = EXCLUDED.subject_kind,
         subject_id = EXCLUDED.subject_id,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         extracted_at = now()`,
      [
        this.businessId,
        chunk.chunkId,
        chunk.subjectKind,
        chunk.subjectId,
        chunk.revision,
        output.usage?.inputTokens ?? 0,
        output.usage?.outputTokens ?? 0,
      ]
    );
  }

  async listEntities(): Promise<readonly GraphEntityRecord[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, business_id, name, type, description, source_chunk_ids
         FROM knowledge_graph_entities WHERE business_id = $1 ORDER BY id`,
      [this.businessId]
    );
    return rows.map(toEntity);
  }

  async listEdges(): Promise<
    readonly { source: string; target: string; weight: number; sourceChunkIds: string[] }[]
  > {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT source_entity_id, target_entity_id, weight, source_chunk_ids
         FROM knowledge_graph_edges WHERE business_id = $1 ORDER BY id`,
      [this.businessId]
    );
    return rows.map((row) => ({
      source: row.source_entity_id as string,
      target: row.target_entity_id as string,
      weight: Number(row.weight ?? 1),
      sourceChunkIds: (row.source_chunk_ids as string[]) ?? [],
    }));
  }

  async saveCommunities(communities: readonly GraphCommunityRecord[]): Promise<void> {
    // A community id is derived from its members, so re-clustering renames communities whose
    // membership shifted. Summaries left behind would keep being served, and being served forever
    // is exactly what a summary derived from since-withdrawn material must not do.
    await this.db.query(
      `DELETE FROM knowledge_graph_community_summaries
        WHERE business_id = $1 AND community_id <> ALL($2::text[])`,
      [this.businessId, communities.map((community) => community.communityId)]
    );
    await this.db.query(`DELETE FROM knowledge_graph_communities WHERE business_id = $1`, [
      this.businessId,
    ]);
    for (const community of communities) {
      await this.db.query(
        `INSERT INTO knowledge_graph_communities
           (community_id, business_id, level, entity_ids, parent_community_id, build_id)
         VALUES ($1, $2, $3, $4::text[], $5, $6)`,
        [
          community.communityId,
          this.businessId,
          community.level,
          [...community.entityIds],
          community.parentCommunityId ?? null,
          this.buildId,
        ]
      );
    }
  }

  async saveSummaries(summaries: readonly GraphCommunitySummaryRecord[]): Promise<void> {
    for (const summary of summaries) {
      await this.db.query(
        `INSERT INTO knowledge_graph_community_summaries
           (community_id, business_id, build_id, title, summary, provenance_chunk_ids,
            input_tokens, output_tokens, stale)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, false)
         ON CONFLICT (business_id, community_id) DO UPDATE SET
           build_id = EXCLUDED.build_id,
           title = EXCLUDED.title,
           summary = EXCLUDED.summary,
           provenance_chunk_ids = EXCLUDED.provenance_chunk_ids,
           input_tokens = EXCLUDED.input_tokens,
           output_tokens = EXCLUDED.output_tokens,
           stale = false,
           updated_at = now()`,
        [
          summary.communityId,
          this.businessId,
          summary.buildId,
          summary.title,
          summary.summary,
          [...summary.provenanceChunkIds],
          summary.usage.inputTokens,
          summary.usage.outputTokens,
        ]
      );
    }
  }

  async findEntities(
    businessId: string,
    query: string,
    limit: number,
    offset = 0
  ): Promise<readonly GraphEntityRecord[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, business_id, name, type, description, source_chunk_ids
         FROM knowledge_graph_entities
        WHERE business_id = $1 AND name ILIKE '%' || $2 || '%' ESCAPE '\\'
        ORDER BY length(name), name, id
        LIMIT $3 OFFSET $4`,
      [businessId, escapeLike(query), limit, offset]
    );
    return rows.map(toEntity);
  }

  async findChunkIdsForEntities(entityIds: readonly string[]): Promise<readonly string[]> {
    if (entityIds.length === 0) return [];
    const { rows } = await this.db.query<{ chunk_id: string }>(
      `SELECT DISTINCT unnest(source_chunk_ids) AS chunk_id
         FROM knowledge_graph_entities
        WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [this.businessId, [...entityIds]]
    );
    return rows.map((row) => row.chunk_id);
  }

  /** Only ever returns fresh summaries. A stale one is derived from material that has since moved. */
  async listCommunitySummaries(
    businessId: string,
    limit: number,
    offset = 0
  ): Promise<readonly GraphCommunitySummaryRecord[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT community_id, business_id, build_id, title, summary, provenance_chunk_ids,
              input_tokens, output_tokens
         FROM knowledge_graph_community_summaries
        WHERE business_id = $1 AND stale = false
        ORDER BY community_id
        LIMIT $2 OFFSET $3`,
      [businessId, limit, offset]
    );
    return rows.map(toSummary);
  }

  async chunkIdsForSubject(
    subjectKind: KnowledgeSubjectKind,
    subjectId: string
  ): Promise<readonly string[]> {
    const { rows } = await this.db.query<{ chunk_id: string }>(
      `SELECT chunk_id FROM knowledge_graph_extractions
        WHERE business_id = $1 AND subject_kind = $2 AND subject_id = $3`,
      [this.businessId, subjectKind, subjectId]
    );
    return rows.map((row) => row.chunk_id);
  }

  /** Edges go with their entities through the foreign key, so this one delete covers both. */
  async deleteEntitiesDerivedFrom(chunkIds: readonly string[]): Promise<number> {
    const { rows } = await this.db.query<{ ok: number }>(
      `DELETE FROM knowledge_graph_entities
        WHERE business_id = $1 AND source_chunk_ids && $2::text[]
        RETURNING 1 AS ok`,
      [this.businessId, [...chunkIds]]
    );
    return rows.length;
  }

  async markSummariesStale(chunkIds: readonly string[]): Promise<number> {
    const { rows } = await this.db.query<{ ok: number }>(
      `UPDATE knowledge_graph_community_summaries
          SET stale = true, updated_at = now()
        WHERE business_id = $1 AND stale = false AND provenance_chunk_ids && $2::text[]
        RETURNING 1 AS ok`,
      [this.businessId, [...chunkIds]]
    );
    return rows.length;
  }

  async forgetExtractions(chunkIds: readonly string[]): Promise<number> {
    const { rows } = await this.db.query<{ ok: number }>(
      `DELETE FROM knowledge_graph_extractions
        WHERE business_id = $1 AND chunk_id = ANY($2::text[])
        RETURNING 1 AS ok`,
      [this.businessId, [...chunkIds]]
    );
    return rows.length;
  }
}
