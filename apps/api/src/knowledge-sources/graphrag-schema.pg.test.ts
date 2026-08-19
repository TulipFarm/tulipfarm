/**
 * Proves the GraphRAG tables and `PgGraphRagRepo` behave against a real engine: provenance merges
 * rather than being overwritten, edges cascade with their entities, and a revocation or deletion
 * actually reaches every derived row. The array operators and `ON CONFLICT` clauses here cannot be
 * checked by typechecking alone, and every one of them is load-bearing for access control.
 */

import type { PGlite } from "@electric-sql/pglite";
import { invalidateGraphForSubject, PgGraphRagRepo } from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";
const BUILD = "build-1";

function chunk(chunkId: string, subjectId: string, revision = "r1") {
  return { chunkId, subjectKind: "page" as const, subjectId, revision, text: `text ${chunkId}` };
}

function extraction(names: string[], related = false) {
  return {
    entities: names.map((name) => ({ name, type: "concept", description: `about ${name}` })),
    relationships:
      related && names.length > 1
        ? [{ source: names[0] ?? "", target: names[1] ?? "", description: "rel", weight: 2 }]
        : [],
    claims: [],
    usage: { inputTokens: 10, outputTokens: 4 },
  };
}

describe("GraphRAG schema", () => {
  let db: PGlite;
  let repo: PgGraphRagRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    repo = new PgGraphRagRepo(db, BUSINESS, BUILD);
  });

  afterEach(async () => {
    await db.close();
  });

  it("records which chunk an entity came from", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments"]));
    const entities = await repo.listEntities();
    expect(entities).toHaveLength(1);
    expect(entities[0]?.sourceChunkIds).toEqual(["ch1"]);
  });

  it("merges provenance when the same entity turns up in a second chunk", async () => {
    // Overwriting here would silently drop a chunk from the ACL check that gates this entity.
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments"]));
    await repo.saveExtraction(chunk("ch2", "page-2"), extraction(["Payments"]));
    const entities = await repo.listEntities();
    expect(entities).toHaveLength(1);
    expect([...(entities[0]?.sourceChunkIds ?? [])].sort()).toEqual(["ch1", "ch2"]);
  });

  it("treats an entity as the same one whatever its casing or padding", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments"]));
    await repo.saveExtraction(chunk("ch2", "page-1"), extraction([" payments "]));
    expect(await repo.listEntities()).toHaveLength(1);
  });

  it("stores an edge between two entities from the same chunk", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments", "Refunds"], true));
    const edges = await repo.listEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.weight).toBe(1);
  });

  it("weighs an edge by how many distinct chunks attest to it", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments", "Refunds"], true));
    await repo.saveExtraction(chunk("ch2", "page-1"), extraction(["Payments", "Refunds"], true));
    const edges = await repo.listEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.weight).toBe(2);
    expect([...(edges[0]?.sourceChunkIds ?? [])].sort()).toEqual(["ch1", "ch2"]);
  });

  it("does not count a chunk twice when it is re-extracted after an edit", async () => {
    // Accumulating on every upsert would make weight a function of edit history, and clustering
    // would stop being reproducible.
    await repo.saveExtraction(
      chunk("ch1", "page-1", "r1"),
      extraction(["Payments", "Refunds"], true)
    );
    await repo.saveExtraction(
      chunk("ch1", "page-1", "r2"),
      extraction(["Payments", "Refunds"], true)
    );
    const edges = await repo.listEdges();
    expect(edges[0]?.weight).toBe(1);
  });

  it("drops a relationship whose endpoint name is ambiguous within the chunk", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), {
      entities: [
        { name: "Mercury", type: "project", description: "the project" },
        { name: "Mercury", type: "person", description: "the person" },
        { name: "Refunds", type: "concept", description: "refunds" },
      ],
      relationships: [{ source: "Mercury", target: "Refunds", description: "rel", weight: 1 }],
      claims: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(await repo.listEntities()).toHaveLength(3);
    expect(await repo.listEdges()).toEqual([]);
  });

  it("remembers the revision it extracted, so a rerun skips the chunk", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1", "r1"), extraction(["Payments"]));
    expect(await repo.loadExtractedRevisions(["ch1"])).toEqual(new Map([["ch1", "r1"]]));
  });

  it("reports no revision for a chunk it has never seen", async () => {
    expect(await repo.loadExtractedRevisions(["never"])).toEqual(new Map());
  });

  it("finds an entity by a fragment of its name", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments Platform"]));
    const found = await repo.findEntities(BUSINESS, "platform", 10, 0);
    expect(found.map((e) => e.name)).toEqual(["Payments Platform"]);
  });

  it("treats a wildcard in the query as a literal, not a match-everything", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments"]));
    expect(await repo.findEntities(BUSINESS, "%", 10, 0)).toEqual([]);
    expect(await repo.findEntities(BUSINESS, "_", 10, 0)).toEqual([]);
  });

  it("pages through entities so a caller can look past denied ones", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Aaa", "Bbb", "Ccc"]));
    const first = await repo.findEntities(BUSINESS, "", 2, 0);
    const second = await repo.findEntities(BUSINESS, "", 2, 2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    const seen = [...first, ...second].map((e) => e.name).sort();
    expect(seen).toEqual(["Aaa", "Bbb", "Ccc"]);
  });

  it("never returns another business's entity", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments"]));
    const other = new PgGraphRagRepo(db, "other-business", BUILD);
    expect(await other.findEntities("other-business", "Payments", 10, 0)).toEqual([]);
  });

  it("hides a stale summary from every query", async () => {
    await repo.saveSummaries([summary("c1", ["ch1"])]);
    expect(await repo.listCommunitySummaries(BUSINESS, 10, 0)).toHaveLength(1);
    await repo.markSummariesStale(["ch1"]);
    expect(await repo.listCommunitySummaries(BUSINESS, 10, 0)).toEqual([]);
  });

  it("stales only the summaries that actually cite the affected chunk", async () => {
    await repo.saveSummaries([summary("c1", ["ch1"]), summary("c2", ["ch2"])]);
    expect(await repo.markSummariesStale(["ch1"])).toBe(1);
    const left = await repo.listCommunitySummaries(BUSINESS, 10, 0);
    expect(left.map((s) => s.communityId)).toEqual(["c2"]);
  });

  it("counts a stale summary once, not on every later sweep", async () => {
    await repo.saveSummaries([summary("c1", ["ch1"])]);
    await repo.markSummariesStale(["ch1"]);
    expect(await repo.markSummariesStale(["ch1"])).toBe(0);
  });

  it("brings a summary back when it is rebuilt", async () => {
    await repo.saveSummaries([summary("c1", ["ch1"])]);
    await repo.markSummariesStale(["ch1"]);
    await repo.saveSummaries([summary("c1", ["ch1"], "rebuilt")]);
    const fresh = await repo.listCommunitySummaries(BUSINESS, 10, 0);
    expect(fresh[0]?.summary).toBe("rebuilt");
  });

  it("takes an edge with its entity when the entity is deleted", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments", "Refunds"], true));
    expect(await repo.deleteEntitiesDerivedFrom(["ch1"])).toBe(2);
    expect(await repo.listEdges()).toEqual([]);
  });

  it("leaves an entity alone when the deleted chunk is not one of its sources", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments"]));
    expect(await repo.deleteEntitiesDerivedFrom(["unrelated"])).toBe(0);
    expect(await repo.listEntities()).toHaveLength(1);
  });

  it("removes every trace of a deleted page from the graph", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments", "Refunds"], true));
    await repo.saveExtraction(chunk("ch2", "page-2"), extraction(["Billing"]));
    await repo.saveSummaries([summary("c1", ["ch1"]), summary("c2", ["ch2"])]);

    const report = await invalidateGraphForSubject("page", "page-1", repo);

    expect(report.entitiesRemoved).toBe(2);
    expect(report.summariesInvalidated).toBe(1);
    expect(report.extractionsForgotten).toBe(1);
    expect((await repo.listEntities()).map((e) => e.name)).toEqual(["Billing"]);
    expect((await repo.listCommunitySummaries(BUSINESS, 10, 0)).map((s) => s.communityId)).toEqual([
      "c2",
    ]);
    expect(await repo.loadExtractedRevisions(["ch1"])).toEqual(new Map());
  });

  it("re-extracts a deleted page's chunk rather than treating it as already done", async () => {
    await repo.saveExtraction(chunk("ch1", "page-1"), extraction(["Payments"]));
    await invalidateGraphForSubject("page", "page-1", repo);
    expect(await repo.loadExtractedRevisions(["ch1"])).toEqual(new Map());
  });

  it("stores communities and reads them back with their parent links", async () => {
    await repo.saveCommunities([
      {
        communityId: "l1:a",
        businessId: BUSINESS,
        level: 1,
        entityIds: ["a"],
        parentCommunityId: "l2:a",
      },
      { communityId: "l2:a", businessId: BUSINESS, level: 2, entityIds: ["a"] },
    ]);
    const { rows } = await db.query<{ community_id: string; parent_community_id: string | null }>(
      "SELECT community_id, parent_community_id FROM knowledge_graph_communities ORDER BY level"
    );
    expect(rows).toEqual([
      { community_id: "l1:a", parent_community_id: "l2:a" },
      { community_id: "l2:a", parent_community_id: null },
    ]);
  });

  it("deletes a summary whose community no longer exists after re-clustering", async () => {
    // Community ids are derived from membership, so re-clustering renames them. An orphaned
    // summary would otherwise keep being served forever, with nothing able to stale it.
    await repo.saveCommunities([
      { communityId: "l1:a", businessId: BUSINESS, level: 1, entityIds: ["a"] },
    ]);
    await repo.saveSummaries([summary("l1:a", ["ch1"])]);
    await repo.saveCommunities([
      { communityId: "l1:b", businessId: BUSINESS, level: 1, entityIds: ["b"] },
    ]);
    expect(await repo.listCommunitySummaries(BUSINESS, 10, 0)).toEqual([]);
  });

  it("keeps a summary whose community survived re-clustering", async () => {
    const same = { communityId: "l1:a", businessId: BUSINESS, level: 1, entityIds: ["a"] };
    await repo.saveCommunities([same]);
    await repo.saveSummaries([summary("l1:a", ["ch1"])]);
    await repo.saveCommunities([same]);
    expect(await repo.listCommunitySummaries(BUSINESS, 10, 0)).toHaveLength(1);
  });

  it("replaces the previous run's communities rather than accumulating them", async () => {
    const one = { communityId: "l1:a", businessId: BUSINESS, level: 1, entityIds: ["a"] };
    await repo.saveCommunities([one]);
    await repo.saveCommunities([one]);
    const { rows } = await db.query("SELECT community_id FROM knowledge_graph_communities");
    expect(rows).toHaveLength(1);
  });

  it("keeps the token cost of a summary so a build is measurable", async () => {
    await repo.saveSummaries([summary("c1", ["ch1"])]);
    const [stored] = await repo.listCommunitySummaries(BUSINESS, 10, 0);
    expect(stored?.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("refuses an entity that cannot say where it came from", async () => {
    await expect(
      db.query(
        `INSERT INTO knowledge_graph_entities (business_id, entity_key, name, type, build_id)
         VALUES ($1, 'k', 'n', 't', $2)`,
        [BUSINESS, BUILD]
      )
    ).rejects.toThrow();
  });
});

function summary(communityId: string, chunkIds: string[], text = `summary ${communityId}`) {
  return {
    communityId,
    businessId: BUSINESS,
    buildId: BUILD,
    title: `T:${communityId}`,
    summary: text,
    provenanceChunkIds: chunkIds,
    usage: { inputTokens: 7, outputTokens: 3 },
  };
}
