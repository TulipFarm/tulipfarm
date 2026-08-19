/**
 * The listing badge needs one thing the full visibility answer is too expensive to give: whether
 * each Page in a tree is open, restricted by itself, or restricted by something above it.
 *
 * The cost is what makes this a separate method. `visibilityOf` expands readers per Page; running
 * it across a hundred-Page tree is a hundred round trips. This stays flat whatever the tree's size,
 * and deliberately answers less.
 */

import type { PGlite } from "@electric-sql/pglite";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  KnowledgeService,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
  PgKnowledgeSubjectStore,
} from "@tulipfarm/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";

const BUSINESS = "tulipfarm-local";
const BLANKET = { kind: "role", id: "role-everyone" };

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

describe("labelling a whole listing's visibility at once", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let acl: PgKnowledgeAclRepo;
  let scopes: PgKnowledgeSubjectStore;
  let spaceId: string;

  async function page(path: string): Promise<string> {
    const res = await service.writePage({
      spaceId,
      path,
      content: `---\ntype: Note\ntitle: ${path}\n---\n\nBody.`,
    });
    if (!res.ok || !("page" in res)) throw new Error(`write failed: ${JSON.stringify(res)}`);
    return res.page._id;
  }

  /** Restricting is replacing: drop the blanket grant, then name who may read. */
  async function restrict(kind: "page" | "space", id: string, user: string): Promise<void> {
    await acl.remove(BUSINESS, kind, id, BLANKET);
    await acl.put({
      businessId: BUSINESS,
      subjectKind: kind,
      subjectId: id,
      principal: { kind: "user", id: user },
      effect: "grant",
      capability: "read",
    });
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    acl = new PgKnowledgeAclRepo(db);
    scopes = new PgKnowledgeSubjectStore(db);
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeSpaceOverrideRepo(db),
      embeddings: lexicalOnly(),
      acl,
    });
    const space = await service.createSpace({ name: "ops" });
    if (!space.ok) throw new Error(space.reason);
    spaceId = space.space._id;
  });

  afterEach(async () => {
    await db.close();
  });

  it("separates open, self-restricted, and ancestor-restricted in one call", async () => {
    const openPage = await page("onboarding");
    const parent = await page("comp");
    const child = await page("comp/bands");

    await restrict("page", parent, "u1");

    const found = await scopes.scopesOf(BUSINESS, [openPage, parent, child]);
    expect(found.get(openPage)?.scope).toBe("business");
    expect(found.get(parent)?.scope).toBe("own");
    expect(found.get(child)?.scope).toBe("inherited");
    expect(found.get(child)?.inheritedFrom).toEqual({ kind: "page", id: parent });
  });

  it("treats a Space restriction as inherited by every Page beneath it", async () => {
    const a = await page("one");
    await restrict("space", spaceId, "u1");

    const found = await scopes.scopesOf(BUSINESS, [a]);
    expect(found.get(a)?.scope).toBe("inherited");
    expect(found.get(a)?.inheritedFrom).toEqual({ kind: "space", id: spaceId });
  });

  it("reports a Page that restricts itself as its own, even under a restricted ancestor", async () => {
    const parent = await page("comp");
    const child = await page("comp/bands");
    await restrict("page", parent, "u1");
    await restrict("page", child, "u1");

    // Its own restriction is the one the author can change here, so that is what it must report.
    expect((await scopes.scopesOf(BUSINESS, [child])).get(child)?.scope).toBe("own");
  });

  it("answers an empty batch without touching the database", async () => {
    expect((await scopes.scopesOf(BUSINESS, [])).size).toBe(0);
  });
});
