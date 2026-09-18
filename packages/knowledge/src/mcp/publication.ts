import { randomUUID } from "node:crypto";
import { ambientTransactionPort, type Queryable } from "@tulipfarm/storage";
import { PgKnowledgeChunkRepo } from "../chunks-repo";
import { invalidateGraphForChunks } from "../graphrag/invalidate";
import { PgGraphRagRepo } from "../graphrag/repo";
import { indexPage } from "../index-service";
import { PgKnowledgePageRepo } from "../repo";
import type { KnowledgeSourceRecord, MutableKnowledgeSourceStore } from "../source";
import type { EmbeddingPort, KnowledgePage } from "../types";
import type { McpKnowledgeDocument } from "./types";

/** All methods run under the host's selection/lease transaction, never an authored-page writer. */
export class McpKnowledgePublication {
  constructor(
    private readonly db: Queryable,
    private readonly sources: MutableKnowledgeSourceStore,
    private readonly embeddings: EmbeddingPort
  ) {}

  async hide(source: KnowledgeSourceRecord): Promise<string> {
    const pages = new PgKnowledgePageRepo(this.db);
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM knowledge_pages WHERE source='mcp' AND source_id=$1`,
      [source.sourceId]
    );
    const pageId = rows[0]?.id ?? randomUUID();
    if (!rows[0]) {
      await pages.insert(
        this.page(source, { text: "", revision: source.revision, sourceUrl: "" }, pageId, false)
      );
    } else {
      await this.db.query(`UPDATE knowledge_pages SET active=false WHERE id=$1 AND source='mcp'`, [
        pageId,
      ]);
    }
    await this.sources.put({ ...source, verification: "unverifiable" });
    return pageId;
  }

  async publish(
    source: KnowledgeSourceRecord,
    document: McpKnowledgeDocument,
    pageId: string
  ): Promise<void> {
    await this.purgeDerived(source.businessId, source.sourceId, pageId);
    const spaceId = await this.space();
    const pages = new PgKnowledgePageRepo(this.db);
    const page = this.page(source, document, pageId, true);
    page.spaceId = spaceId;
    const saved = await pages.upsertBySource(page);
    if (saved._id !== pageId) throw new Error("mcp_knowledge_page_identity_changed");
    page.version = saved.version;
    await indexPage(
      page,
      new PgKnowledgeChunkRepo(this.db, ambientTransactionPort(this.db)),
      this.embeddings
    );
    await this.sources.put(source);
  }

  async remove(businessId: string, sourceId: string, pageId: string): Promise<void> {
    const source = await this.sources.get(businessId, sourceId);
    if (source) {
      await this.sources.put({ ...source, status: "deleted", verification: "unverifiable" });
    }
    await this.purgeDerived(businessId, sourceId, pageId);
    await this.db.query(
      `DELETE FROM knowledge_pages WHERE id=$1 AND source='mcp' AND source_id=$2`,
      [pageId, sourceId]
    );
  }

  private async purgeDerived(businessId: string, sourceId: string, pageId: string): Promise<void> {
    const graph = new PgGraphRagRepo(this.db, businessId, "mcp-knowledge-invalidation");
    const pageChunks = await graph.chunkIdsForSubject("page", pageId);
    const sourceChunks = await graph.chunkIdsForSubject("source", sourceId);
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id::text FROM knowledge_chunks WHERE page_id=$1
       UNION SELECT chunk_id AS id FROM knowledge_source_chunks WHERE business_id=$2 AND source_id=$3`,
      [pageId, businessId, sourceId]
    );
    const ids = [...new Set([...pageChunks, ...sourceChunks, ...rows.map((row) => row.id)])];
    await invalidateGraphForChunks(ids, graph);
    // Stale summaries are hidden by the normal gate; erasure also removes the retained text.
    await this.db.query(
      `DELETE FROM knowledge_graph_community_summaries
       WHERE business_id=$1 AND provenance_chunk_ids && $2::text[]`,
      [businessId, ids]
    );
    await this.db.query(`DELETE FROM knowledge_chunks WHERE page_id=$1`, [pageId]);
    await this.db.query(`DELETE FROM knowledge_revisions WHERE page_id=$1`, [pageId]);
    await this.db.query(`DELETE FROM knowledge_links WHERE source_id=$1`, [pageId]);
    await this.db.query(
      `DELETE FROM knowledge_source_chunks WHERE business_id=$1 AND source_id=$2`,
      [businessId, sourceId]
    );
  }

  private async space(): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO knowledge_spaces (id,name,description,created_at,updated_at)
       VALUES ($1,'Connected sources','Read-only selected Integration sources',now(),now())
       ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [randomUUID()]
    );
    const row = rows[0];
    if (!row) throw new Error("mcp_knowledge_space_missing");
    return row.id;
  }

  private page(
    source: KnowledgeSourceRecord,
    document: McpKnowledgeDocument,
    id: string,
    active: boolean
  ): KnowledgePage {
    const locator = source.sourceLocator;
    if (locator?.kind !== "mcp") throw new Error("mcp_knowledge_locator_required");
    const now = new Date(source.lastSyncedAt);
    return {
      _id: id,
      title: `${locator.repo}/${locator.path}`,
      content: document.text,
      plainText: document.text,
      source: "mcp",
      sourceId: source.sourceId,
      domain: null,
      tags: [],
      active,
      alwaysLoadForAgents: false,
      version: 1,
      spaceId: null,
      path: source.sourceId.slice(4),
      frontmatterExtra: {
        readOnly: true,
        sourceUrl: locator.sourceUrl,
        lastSyncedAt: source.lastSyncedAt,
      },
      authorKind: null,
      authorId: null,
      createdAt: now,
      updatedAt: now,
    };
  }
}
