import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { ConfluenceApiPort, ConfluenceChange, ConfluencePage } from "@tulipfarm/integrations";
import { syncConfluenceKnowledge } from "@tulipfarm/integrations";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  KNOWLEDGE_TOOLS,
  KnowledgeService,
  PageRetrievalService,
  PgKnowledgeChunkRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
} from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdentityVerificationMethod } from "../identity/external-links";
import { MemoryExternalIdentityRepo } from "../identity/fakes";
import { ExternalLinkKnowledgeIdentityMap } from "../identity/knowledge-identity-map";
import { PgConfluenceKnowledgeCheckpointStore } from "../knowledge-sources/confluence-checkpoint-store";
import { PgKnowledgeEmissionSink } from "../knowledge-sources/emission-sink";
import { PgKnowledgeIndexStore } from "../knowledge-sources/index-store";
import { PgKnowledgeSourceStore } from "../knowledge-sources/source-store";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = DEPLOYMENT_BUSINESS_ID;
const NOW = new Date("2026-08-08T12:00:00.000Z");
const SECRET_TEXT = "orchid launch plan for confluence readers";

const lexicalOnlyEmbeddings: EmbeddingPort = {
  isAvailable: () => false,
  embedMany: async () => ({ embeddings: [], dimension: 0 }),
  getActive: () => null,
  getDimension: () => null,
  pendingReindex: () => false,
  clearPendingReindex: () => {},
};

class FakeConfluenceApi implements ConfluenceApiPort {
  changes: ConfluenceChange[] = [{ pageId: "page-1", cursor: "c1" }];
  pages = new Map<string, ConfluencePage | undefined>([["page-1", this.page()]]);
  permissions = new Map<string, readonly string[] | undefined>([["page-1", ["acct_alice"]]]);

  async listChanged({ cursor }: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly ConfluenceChange[];
    readonly nextCursor?: string;
  }> {
    const start =
      cursor === undefined ? 0 : this.changes.findIndex((change) => change.cursor === cursor) + 1;
    const changes = this.changes.slice(start);
    return { changes, nextCursor: changes.at(-1)?.cursor ?? cursor };
  }

  async getPage(pageId: string): Promise<ConfluencePage | undefined> {
    return this.pages.get(pageId);
  }

  async getPagePermissions(
    pageId: string
  ): Promise<readonly { readonly accountId: string }[] | undefined> {
    return this.permissions.get(pageId)?.map((accountId) => ({ accountId }));
  }

  page(overrides: Partial<ConfluencePage> = {}): ConfluencePage {
    return {
      id: "page-1",
      title: "Launch Plan",
      spaceId: "space-1",
      spaceKey: "ENG",
      version: "1",
      ownerAccountId: "acct_alice",
      updatedAt: NOW.toISOString(),
      content: SECRET_TEXT,
      ...overrides,
    };
  }
}

function mappedIdentity(
  verifiedVia: IdentityVerificationMethod = "link_token"
): ExternalLinkKnowledgeIdentityMap {
  const repo = new MemoryExternalIdentityRepo();
  repo.mappings.push({
    provider: "confluence",
    externalSubject: "acct_alice",
    userId: "alice",
    verifiedAt: NOW,
    expiresAt: null,
    verifiedVia,
  });
  repo.mappings.push({
    provider: "confluence",
    externalSubject: "acct_bob",
    userId: "bob",
    verifiedAt: NOW,
    expiresAt: null,
    verifiedVia,
  });
  return new ExternalLinkKnowledgeIdentityMap(repo);
}

describe("Confluence Knowledge security through query_knowledge", () => {
  let db: PGlite;
  let api: FakeConfluenceApi;
  let sources: PgKnowledgeSourceStore;
  let index: PgKnowledgeIndexStore;
  let service: KnowledgeService;
  let now: Date;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    api = new FakeConfluenceApi();
    sources = new PgKnowledgeSourceStore(db);
    index = new PgKnowledgeIndexStore(db, lexicalOnlyEmbeddings);
    now = NOW;
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      embeddings: lexicalOnlyEmbeddings,
      retrieval: new PageRetrievalService(db),
      sourceRetrieval: {
        sources,
        index,
        now: () => now,
      },
    });
  });

  afterEach(async () => {
    await db.close();
  });

  async function sync(
    options: {
      revalidatePageIds?: readonly string[];
      aclMaximumAgeSeconds?: number;
      verifiedVia?: IdentityVerificationMethod;
    } = {}
  ): Promise<void> {
    const { verifiedVia, ...syncOptions } = options;
    await syncConfluenceKnowledge(
      {
        api,
        checkpoints: new PgConfluenceKnowledgeCheckpointStore(db),
        sink: new PgKnowledgeEmissionSink(sources, index),
        identity: mappedIdentity(verifiedVia),
        now: () => NOW,
      },
      {
        businessId: BUSINESS,
        integrationId: "confluence:test:cloud-1",
        externalTenantId: "cloud-1",
        ...syncOptions,
      }
    );
  }

  async function queryAs(userId: string): Promise<unknown> {
    const tool = KNOWLEDGE_TOOLS.find((candidate) => candidate.name === "query_knowledge");
    if (tool === undefined) throw new Error("query_knowledge not registered");
    const outcome = await tool.handler({ query: "orchid", limit: 10 }, { userId, service });
    expect(outcome.success).toBe(true);
    if (!outcome.success) throw new Error(outcome.error.message);
    return outcome.data;
  }

  function resultCount(data: unknown): number {
    if (typeof data !== "object" || data === null || !("results" in data)) return 0;
    const results = (data as { results?: unknown }).results;
    return Array.isArray(results) ? results.length : 0;
  }

  it("excludes a Confluence page from a user without Confluence access", async () => {
    await sync();

    const data = await queryAs("bob");

    expect(resultCount(data)).toBe(0);
    expect(JSON.stringify(data)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(data)).not.toContain("page-1");
  });

  it("revokes retrievability when permissions narrow on re-sync", async () => {
    api.permissions.set("page-1", ["acct_alice", "acct_bob"]);
    await sync();
    expect(resultCount(await queryAs("bob"))).toBe(1);

    api.permissions.set("page-1", ["acct_alice"]);
    await sync({ revalidatePageIds: ["page-1"] });

    expect(resultCount(await queryAs("bob"))).toBe(0);
    expect(resultCount(await queryAs("alice"))).toBe(1);
  });

  it("removes deleted Confluence pages from results", async () => {
    await sync();
    expect(resultCount(await queryAs("alice"))).toBe(1);

    api.changes = [{ pageId: "page-1", cursor: "c2", deleted: true }];
    await sync();

    expect(resultCount(await queryAs("alice"))).toBe(0);
  });

  it("does not grant access for an unmapped Confluence identity", async () => {
    api.permissions.set("page-1", ["acct_unmapped"]);
    await sync();

    expect(resultCount(await queryAs("alice"))).toBe(0);
  });

  // A Slack Connect or Confluence guest counterparty administers their own users' email
  // addresses, so a provider-asserted email identifies a chat sender but must never carry a
  // document grant. Proven end-to-end rather than at the unit, because the grant is frozen into
  // the captured ACL at sync time and a unit test cannot show that the freeze never happened.
  it("grants nothing when the only mapping was verified by provider-asserted email", async () => {
    api.permissions.set("page-1", ["acct_alice"]);
    await sync({ verifiedVia: "manifest_email" });

    const data = await queryAs("alice");
    expect(resultCount(data)).toBe(0);
    expect(JSON.stringify(data)).not.toContain(SECRET_TEXT);
  });

  it("still grants access for the same page once the mapping is link-token verified", async () => {
    api.permissions.set("page-1", ["acct_alice"]);
    await sync({ verifiedVia: "link_token" });

    expect(resultCount(await queryAs("alice"))).toBe(1);
  });

  it("excludes pages with missing or stale ACL data", async () => {
    api.permissions.set("page-1", undefined);
    await sync();
    expect(resultCount(await queryAs("alice"))).toBe(0);

    api.permissions.set("page-1", ["acct_alice"]);
    api.changes = [{ pageId: "page-2", cursor: "c2" }];
    api.pages.set("page-2", api.page({ id: "page-2", version: "1" }));
    api.permissions.set("page-2", ["acct_alice"]);
    await sync({ aclMaximumAgeSeconds: 1 });
    now = new Date(NOW.getTime() + 2_000);

    expect(resultCount(await queryAs("alice"))).toBe(0);
  });
});
