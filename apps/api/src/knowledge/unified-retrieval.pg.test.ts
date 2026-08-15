import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { KnowledgeSourceRecord } from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgKnowledgeIndexStore } from "../knowledge-sources/index-store";
import { PgKnowledgeSourceStore } from "../knowledge-sources/source-store";
import { makeMigratedPglite } from "../test/pglite";
import { PgKnowledgeChunkRepo } from "./chunks-repo";
import { PageRetrievalService } from "./page-search-adapter";
import { PgKnowledgePageRepo, PgKnowledgeRevisionRepo } from "./repo";
import { KnowledgeService } from "./service";
import { KNOWLEDGE_TOOLS } from "./tools";
import type { EmbeddingPort } from "./types";

const NOW = new Date("2026-08-08T12:00:00.000Z");

const lexicalOnlyEmbeddings: EmbeddingPort = {
  isAvailable: () => false,
  embedMany: async () => ({ embeddings: [], dimension: 0 }),
  getActive: () => null,
  getDimension: () => null,
  consumePendingReindex: () => false,
};

async function seedSpacePage(db: PGlite): Promise<string> {
  const spaceId = randomUUID();
  const pageId = randomUUID();
  await db.query(
    `INSERT INTO knowledge_spaces (id, name, description, created_at, updated_at)
     VALUES ($1, 'ops', NULL, now(), now())`,
    [spaceId]
  );
  await db.query(
    `INSERT INTO knowledge_pages
       (id, title, content, plain_text, source, source_id, tags, active, always_load_for_agents,
        version, space_id, path, type, frontmatter_extra, created_at, updated_at)
     VALUES ($1,$2,$3,$3,'authored',$4,'{}',true,false,1,$5,'runbooks/incidents',NULL,'{}'::jsonb,
             now(),now())`,
    [
      pageId,
      "Incident handbook",
      "Incident handbook\n\nVisible incident response steps for everyone.",
      `okf:${spaceId}:runbooks/incidents`,
      spaceId,
    ]
  );
  await db.query(
    `INSERT INTO knowledge_chunks
       (id, page_id, chunk_index, content, content_hash, embedding, tsv, model, dim, created_at)
     VALUES ($1,$2,0,$3,md5($3),NULL,to_tsvector('english',$3),NULL,NULL,now())`,
    [randomUUID(), pageId, "Visible incident response steps for everyone."]
  );
  return pageId;
}

function slackSource(): KnowledgeSourceRecord {
  return {
    sourceId: "slack:T-secret:C-secret",
    businessId: DEPLOYMENT_BUSINESS_ID,
    integrationId: "slack-install-1",
    provider: "slack",
    externalId: "C-secret",
    externalTenantId: "T-secret",
    ownerExternalId: "U-owner",
    revision: "1680000000.000100",
    classification: ["restricted"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "snapshot", aclRevision: "acl-slack-secret", maximumAgeSeconds: 3600 },
    acl: {
      aclRevision: "acl-slack-secret",
      capturedAt: NOW.toISOString(),
      principals: [{ kind: "user", id: "slack-member" }],
    },
    provenance: { capturedAt: NOW.toISOString(), contentHash: "s".repeat(64) },
    lastSyncedAt: NOW.toISOString(),
  };
}

describe("query_knowledge unified retrieval", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("does not let an unauthorized Slack hit consume a limit-1 result slot or leak existence", async () => {
    const okfPageId = await seedSpacePage(db);
    const sources = new PgKnowledgeSourceStore(db);
    const sourceIndex = new PgKnowledgeIndexStore(db, lexicalOnlyEmbeddings);
    await sources.put(slackSource());
    await sourceIndex.upsert({
      businessId: DEPLOYMENT_BUSINESS_ID,
      sourceId: "slack:T-secret:C-secret",
      chunkId: "slack:T-secret:C-secret#1680000000.000100",
      revision: "1680000000.000100",
      classification: ["restricted"],
      digest: "t".repeat(64),
      text: "incident incident incident private war-room escalation codeword-rosebud",
    });

    const service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      embeddings: lexicalOnlyEmbeddings,
      retrieval: new PageRetrievalService(db),
      sourceRetrieval: {
        sources,
        index: sourceIndex,
        now: () => NOW,
      },
    });
    const tool = KNOWLEDGE_TOOLS.find((candidate) => candidate.name === "query_knowledge");
    if (tool === undefined) throw new Error("query_knowledge not registered");

    const outcome = await tool.handler(
      { query: "incident", limit: 1 },
      { userId: "user-without-slack", service, agentId: "agent-1" }
    );

    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect(outcome.data).toMatchObject({
      results: [{ pageId: okfPageId, origin: "okf" }],
    });
    const serialized = JSON.stringify(outcome.data);
    expect(serialized).not.toContain("slack");
    expect(serialized).not.toContain("C-secret");
    expect(serialized).not.toContain("rosebud");
    expect(serialized).not.toContain("excluded");
  });
});
