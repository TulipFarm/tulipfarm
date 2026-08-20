/**
 * A Page authored by `create_knowledge_page` must be usable by everything that reads Pages.
 *
 * The Tool reported success for a Page that had no Space, no path and no ACL entry: absent from
 * every Space listing, denied by the Page gate that `GET /knowledge/pages/:id` consults, and
 * invisible to the lexical arm of `hybridSearchPages`, which only considers placed Pages. The
 * authoring Agent saw none of that, because it read the Page back through `getPage` alone.
 *
 * These assertions walk the reader's own paths, in the order the QA journey did.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  KNOWLEDGE_TOOLS,
  KnowledgeService,
  type KnowledgeToolContext,
  PageReadGate,
  PageRetrievalService,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
} from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";

const FAQ = "Go to Settings > Auth > Reset password. The reset link expires in 15 min.";

function lexicalOnly(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}

const byName = Object.fromEntries(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));

type Result = { success: boolean; data?: unknown; error?: unknown };

describe("a Page created by create_knowledge_page is reachable by every reader", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let gate: PageReadGate;
  let author: string;
  let reader: string;
  let pageId: string;

  const ctx = (userId: string): KnowledgeToolContext => ({ userId, service, pageGate: gate });

  const call = (name: string, args: object, userId: string): Promise<Result> =>
    byName[name].handler(args, ctx(userId)) as Promise<Result>;

  async function addMember(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, created_at)
       VALUES ($1, $2, 'x', 'member', now())`,
      [id, `${id}@example.test`]
    );
    return id;
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeSpaceOverrideRepo(db),
      embeddings: lexicalOnly(),
      retrieval: new PageRetrievalService(db),
      acl: new PgKnowledgeAclRepo(db),
    });
    gate = new PageReadGate(db, BUSINESS);

    author = await addMember();
    reader = await addMember();

    const created = await call(
      "create_knowledge_page",
      { title: "Password Reset FAQ", content: FAQ },
      author
    );
    if (!created.success) throw new Error(`create failed: ${JSON.stringify(created)}`);
    pageId = (created.data as { id: string }).id;
  });

  afterEach(async () => {
    await db.close();
  });

  it("belongs to a Space and appears in that Space's page list", async () => {
    const page = await service.getPage(pageId);
    expect(page?.spaceId ?? null).not.toBeNull();

    const listed = await service.listSpacePages(page?.spaceId ?? "");
    expect(listed.map((p) => p._id)).toContain(pageId);
  });

  it("passes the Page gate the detail route reads through", async () => {
    expect(await gate.canRead(author, pageId)).toBe(true);
    expect(await gate.canRead(reader, pageId)).toBe(true);
  });

  it("is returned by query_knowledge so an Agent can ground on it", async () => {
    const res = await call("query_knowledge", { query: "reset my password" }, reader);

    expect(res.success).toBe(true);
    const hits = (res.data as { results: { pageId: string }[] }).results;
    expect(hits.map((h) => h.pageId)).toContain(pageId);
  });

  it("is readable by get_page from another Agent's turn", async () => {
    const res = await call("get_page", { pageId }, reader);
    expect(res.success).toBe(true);
  });

  it("places a second Page of the same title beside the first, not over it", async () => {
    const again = await call(
      "create_knowledge_page",
      { title: "Password Reset FAQ", content: "A later revision of the FAQ." },
      author
    );

    expect(again.success).toBe(true);
    const second = (again.data as { id: string }).id;
    expect(second).not.toBe(pageId);
    const page = await service.getPage(pageId);
    const listed = await service.listSpacePages(page?.spaceId ?? "");
    expect(listed.map((p) => p._id).sort()).toEqual([pageId, second].sort());
  });
});
