/**
 * A vanished chunk must take everything derived from it out of the graph.
 *
 * `source_chunk_ids` and `provenance_chunk_ids` are `text[]`, and Postgres cannot foreign-key an
 * array element, so the graph tables record provenance with no referential integrity behind it.
 * `invalidateGraphForChunks` was written to close that at the application layer — but it has no
 * production caller, and three routine paths delete chunks without going near it:
 *
 *   deleting a Page  →  knowledge_chunks.page_id ON DELETE CASCADE
 *   deleting a Space →  DELETE FROM knowledge_pages, then the same cascade
 *   re-indexing      →  DELETE FROM knowledge_chunks WHERE page_id = $1, then re-insert
 *
 * Each leaves entities, edges and summaries pointing at chunks that no longer exist. A summary is
 * the dangerous one: it is prose derived from material that has been withdrawn, and it keeps being
 * served. So the guarantee is enforced where it cannot be bypassed — in the database.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = DEPLOYMENT_BUSINESS_ID;

describe("deleting a chunk prunes everything the graph derived from it", () => {
  let db: PGlite;
  let spaceId: string;
  let pageId: string;
  let chunkId: string;
  let otherPageId: string;
  let otherChunkId: string;

  async function makePage(path: string): Promise<{ pageId: string; chunkId: string }> {
    const page = randomUUID();
    const chunk = randomUUID();
    await db.query(
      `INSERT INTO knowledge_pages
         (id, title, content, plain_text, source, source_id, active, always_load_for_agents,
          version, space_id, path, created_at, updated_at)
       VALUES ($1, $2, '# x', 'x', 'okf', $5, true, false, 1, $3, $4, now(), now())`,
      [page, path, spaceId, path, `okf:${path}`]
    );
    await db.query(
      `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, created_at)
       VALUES ($1, $2, 0, 'x', to_tsvector('english', 'x'), now())`,
      [chunk, page]
    );
    return { pageId: page, chunkId: chunk };
  }

  async function makeEntity(name: string, chunkIds: string[]): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO knowledge_graph_entities
         (business_id, entity_key, name, type, source_chunk_ids, build_id)
       VALUES ($1, $2, $2, 'concept', $3::text[], 'build-1') RETURNING id`,
      [BUSINESS, name, chunkIds]
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("entity insert returned no id");
    return id;
  }

  async function makeSummary(communityId: string, chunkIds: string[]): Promise<void> {
    await db.query(
      `INSERT INTO knowledge_graph_community_summaries
         (community_id, business_id, build_id, title, summary, provenance_chunk_ids)
       VALUES ($1, $2, 'build-1', 'T', 'S', $3::text[])`,
      [communityId, BUSINESS, chunkIds]
    );
  }

  async function makeExtraction(chunk: string, subject: string): Promise<void> {
    await db.query(
      `INSERT INTO knowledge_graph_extractions
         (business_id, chunk_id, subject_kind, subject_id, revision)
       VALUES ($1, $2, 'page', $3, 'r1')`,
      [BUSINESS, chunk, subject]
    );
  }

  async function count(table: string, where: string, params: unknown[]): Promise<number> {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
      params
    );
    return Number(rows[0]?.n ?? "0");
  }

  async function staleOf(communityId: string): Promise<boolean | undefined> {
    const { rows } = await db.query<{ stale: boolean }>(
      "SELECT stale FROM knowledge_graph_community_summaries WHERE community_id = $1",
      [communityId]
    );
    return rows[0]?.stale;
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    spaceId = randomUUID();
    await db.query(
      `INSERT INTO knowledge_spaces (id, name, created_at, updated_at)
       VALUES ($1, 'handbook', now(), now())`,
      [spaceId]
    );

    ({ pageId, chunkId } = await makePage("doomed"));
    ({ pageId: otherPageId, chunkId: otherChunkId } = await makePage("survivor"));

    const doomed = await makeEntity("Doomed", [chunkId]);
    const survivor = await makeEntity("Survivor", [otherChunkId]);
    await db.query(
      `INSERT INTO knowledge_graph_edges
         (business_id, edge_key, source_entity_id, target_entity_id, source_chunk_ids, build_id)
       VALUES ($1, 'doomed->survivor', $2, $3, $4::text[], 'build-1')`,
      [BUSINESS, doomed, survivor, [chunkId]]
    );
    await makeSummary("c-doomed", [chunkId]);
    await makeSummary("c-mixed", [chunkId, otherChunkId]);
    await makeSummary("c-clean", [otherChunkId]);
    await makeExtraction(chunkId, pageId);
    await makeExtraction(otherChunkId, otherPageId);
  });

  afterEach(async () => {
    await db.close();
  });

  /** Every assertion that must hold once the doomed chunk is gone, whatever removed it. */
  async function expectPruned(): Promise<void> {
    expect(await count("knowledge_graph_entities", "name = $1", ["Doomed"])).toBe(0);
    expect(
      await count("knowledge_graph_edges", "source_chunk_ids && $1::text[]", [[chunkId]])
    ).toBe(0);
    expect(await count("knowledge_graph_extractions", "chunk_id = $1", [chunkId])).toBe(0);
    // A summary is marked, not deleted: the row is what tells the next build to re-summarise, and
    // `stale = true` already stops it being served.
    expect(await staleOf("c-doomed")).toBe(true);
    // Partial provenance is still withdrawal: the summary is not re-derivable from what remains.
    expect(await staleOf("c-mixed")).toBe(true);

    // The control. Without it a trigger that wiped the whole graph would pass everything above.
    expect(await count("knowledge_graph_entities", "name = $1", ["Survivor"])).toBe(1);
    expect(await count("knowledge_graph_extractions", "chunk_id = $1", [otherChunkId])).toBe(1);
    expect(await staleOf("c-clean")).toBe(false);
  }

  it("prunes when the Page is deleted", async () => {
    await db.query("DELETE FROM knowledge_pages WHERE id = $1", [pageId]);
    await expectPruned();
  });

  it("prunes when the whole Space is deleted", async () => {
    // Mirrors PgKnowledgeSpaceRepo.delete, which removes Pages in a CTE and never calls the
    // application-level invalidation.
    await db.query("DELETE FROM knowledge_pages WHERE space_id = $1", [spaceId]);
    await db.query("DELETE FROM knowledge_spaces WHERE id = $1", [spaceId]);

    expect(await count("knowledge_graph_entities", "true", [])).toBe(0);
    expect(await count("knowledge_graph_edges", "true", [])).toBe(0);
    expect(await count("knowledge_graph_extractions", "true", [])).toBe(0);
    expect(await staleOf("c-clean")).toBe(true);
  });

  it("prunes when the Page is re-indexed and its chunks are replaced", async () => {
    // Re-indexing deletes by page_id and re-inserts; the new chunk is a new id, so anything keyed
    // to the old one is derived from text that no longer exists.
    await db.query("DELETE FROM knowledge_chunks WHERE page_id = $1", [pageId]);
    await db.query(
      `INSERT INTO knowledge_chunks (id, page_id, chunk_index, content, tsv, created_at)
       VALUES ($1, $2, 0, 'rewritten', to_tsvector('english', 'rewritten'), now())`,
      [randomUUID(), pageId]
    );
    await expectPruned();
  });

  it("prunes a chunk deleted on its own", async () => {
    await db.query("DELETE FROM knowledge_chunks WHERE id = $1", [chunkId]);
    await expectPruned();
  });

  it("drops an entity whose provenance is only partly withdrawn", async () => {
    // Conservative on purpose, and it matches `deleteEntitiesDerivedFrom`: an entity described
    // partly from withdrawn text cannot be re-derived from what is left, so it goes.
    await makeEntity("Mixed", [chunkId, otherChunkId]);
    await db.query("DELETE FROM knowledge_chunks WHERE id = $1", [chunkId]);

    expect(await count("knowledge_graph_entities", "name = $1", ["Mixed"])).toBe(0);
  });

  it("leaves the graph alone when no chunk is deleted", async () => {
    await db.query("UPDATE knowledge_chunks SET content = 'edited' WHERE id = $1", [chunkId]);

    expect(await count("knowledge_graph_entities", "true", [])).toBe(2);
    expect(await staleOf("c-doomed")).toBe(false);
  });
});
