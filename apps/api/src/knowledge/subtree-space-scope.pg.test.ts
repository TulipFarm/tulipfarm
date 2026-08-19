/**
 * A subtree is bounded by its Space.
 *
 * `moveSubtree` and `listSubtree` select descendants by `business_id` and a `path LIKE 'parent/%'`
 * prefix, with no `space_id`. Paths are unique per Space, not per Business, so two Spaces are
 * expected to both hold `notes` and `notes/one`. Moving one Space's `notes` therefore drags the
 * other Space's `notes/one` along with it — silently relocating a Page the operator never named
 * and re-parenting its ACL inheritance onto the destination.
 *
 * The prefix is also an unescaped LIKE pattern, so `_` and `%` in a stored path are wildcards: a
 * Page at `a_b` claims `axb/...` as its children.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  KnowledgeService,
  PageRetrievalService,
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

function noEmbeddings(): EmbeddingPort {
  return {
    isAvailable: () => false,
    embedMany: async (values) => ({ embeddings: values.map(() => [0, 0, 0]), dimension: 3 }),
    getActive: () => null,
    getDimension: () => null,
    pendingReindex: () => false,
    clearPendingReindex: () => {},
  };
}

describe("a subtree is bounded by its Space", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let pages: PgKnowledgePageRepo;

  async function makeSpace(name: string): Promise<string> {
    const created = await service.createSpace({ name });
    if (!created.ok) throw new Error(`space ${name} failed`);
    return created.space._id;
  }

  async function writePage(spaceId: string, path: string): Promise<string> {
    const res = await service.writePage({ spaceId, path, content: `# ${path}\n\nbody` });
    if (!res.ok || !("page" in res)) throw new Error(`write ${path} failed`);
    return res.page._id;
  }

  /** Where a Page sits right now, straight from the row the move rewrote. */
  async function locate(pageId: string): Promise<{ spaceId: string | null; path: string | null }> {
    const page = await pages.getById(pageId);
    return { spaceId: page?.spaceId ?? null, path: page?.path ?? null };
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    pages = new PgKnowledgePageRepo(db);
    service = new KnowledgeService({
      pages,
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeSpaceOverrideRepo(db),
      embeddings: noEmbeddings(),
      retrieval: new PageRetrievalService(db),
      readership: new PgKnowledgeSubjectStore(db),
      acl: new PgKnowledgeAclRepo(db),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("lists only its own Space's descendants", async () => {
    const a = await makeSpace("Alpha");
    const b = await makeSpace("Beta");
    await writePage(a, "notes");
    const mine = await writePage(a, "notes/one");
    await writePage(b, "notes");
    const theirs = await writePage(b, "notes/one");
    const parent = await service.getPageByPath(a, "notes");
    if (!parent) throw new Error("parent missing");

    const listed = (await pages.listSubtree(parent._id)).map((d) => d.id);

    expect(listed).toEqual([mine]);
    expect(listed).not.toContain(theirs);
  });

  it("moves only its own Space's descendants", async () => {
    const a = await makeSpace("Alpha");
    const b = await makeSpace("Beta");
    const dest = await makeSpace("Archive");
    const parent = await writePage(a, "notes");
    const mine = await writePage(a, "notes/one");
    await writePage(b, "notes");
    const theirs = await writePage(b, "notes/one");

    await pages.moveSubtree(parent, dest, "archive/notes");

    expect(await locate(mine)).toEqual({ spaceId: dest, path: "archive/notes/one" });
    expect(await locate(theirs)).toEqual({ spaceId: b, path: "notes/one" });
  });

  it("returns only its own Space's ids from a move, so nothing foreign is reindexed", async () => {
    const a = await makeSpace("Alpha");
    const b = await makeSpace("Beta");
    const dest = await makeSpace("Archive");
    const parent = await writePage(a, "notes");
    const mine = await writePage(a, "notes/one");
    await writePage(b, "notes");
    const theirs = await writePage(b, "notes/one");

    const moved = await pages.moveSubtree(parent, dest, "archive/notes");

    expect([...moved].sort()).toEqual([parent, mine].sort());
    expect(moved).not.toContain(theirs);
  });

  it("treats `_` in a path as a literal, not a single-character wildcard", async () => {
    const a = await makeSpace("Alpha");
    const parent = await writePage(a, "a_b");
    await writePage(a, "axb");
    const decoy = await writePage(a, "axb/child");

    expect((await pages.listSubtree(parent)).map((d) => d.id)).toEqual([]);

    await pages.moveSubtree(parent, a, "moved");

    expect(await locate(decoy)).toEqual({ spaceId: a, path: "axb/child" });
  });

  it("still carries its own real descendants, so the scoping did not just switch nesting off", async () => {
    const a = await makeSpace("Alpha");
    const dest = await makeSpace("Archive");
    const parent = await writePage(a, "notes");
    const child = await writePage(a, "notes/one");
    const grandchild = await writePage(a, "notes/one/deep");

    expect((await pages.listSubtree(parent)).map((d) => d.id).sort()).toEqual(
      [child, grandchild].sort()
    );

    await pages.moveSubtree(parent, dest, "archive/notes");

    expect(await locate(child)).toEqual({ spaceId: dest, path: "archive/notes/one" });
    expect(await locate(grandchild)).toEqual({ spaceId: dest, path: "archive/notes/one/deep" });
  });
});
