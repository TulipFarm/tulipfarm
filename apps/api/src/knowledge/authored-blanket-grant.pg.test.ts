/**
 * The write side of authored access: a new Page acquires the blanket grant, and an already
 * restricted Page keeps its restriction across later edits.
 *
 * The second half matters more than the first. Restriction is an allowlist that *replaces* the
 * blanket grant, so re-adding that grant on every save would silently republish a restricted Page
 * to the whole Business on the author's next keystroke.
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

const HANDBOOK = `---
type: Note
title: Handbook
---

The company handbook.`;

const EDITED = `---
type: Note
title: Handbook
---

The company handbook, revised.`;

describe("authored Pages acquire the blanket grant", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let acl: PgKnowledgeAclRepo;
  let spaceId: string;

  async function entriesOn(pageId: string) {
    return acl.listForSubject(BUSINESS, "page", pageId);
  }

  async function writeHandbook(content: string): Promise<string> {
    const res = await service.writePage({ spaceId, path: "handbook", content });
    if (!res.ok || !("page" in res)) throw new Error(`write failed: ${JSON.stringify(res)}`);
    return res.page._id;
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    acl = new PgKnowledgeAclRepo(db);
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

  it("records exactly one grant, to the blanket Principal, on a new Page", async () => {
    const id = await writeHandbook(HANDBOOK);
    expect(await entriesOn(id)).toEqual([
      {
        subjectKind: "page",
        subjectId: id,
        principal: BLANKET,
        effect: "grant",
        capability: "read",
      },
    ]);
  });

  it("does not re-add the blanket grant when a restricted Page is edited", async () => {
    const id = await writeHandbook(HANDBOOK);
    await acl.remove(BUSINESS, "page", id, BLANKET);
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: id,
      principal: { kind: "user", id: "alice" },
      effect: "grant",
      capability: "read",
    });

    await writeHandbook(EDITED);

    const after = await entriesOn(id);
    expect(after.map((e) => e.principal.id)).toEqual(["alice"]);
  });

  it("leaves an unrestricted Page with a single grant after repeated edits", async () => {
    const id = await writeHandbook(HANDBOOK);
    await writeHandbook(EDITED);
    await writeHandbook(HANDBOOK);
    expect(await entriesOn(id)).toHaveLength(1);
  });

  it("writes a Page unchanged when no ACL repo is configured", async () => {
    const bare = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeSpaceOverrideRepo(db),
      embeddings: lexicalOnly(),
    });
    const res = await bare.writePage({ spaceId, path: "bare", content: HANDBOOK });
    expect(res.ok).toBe(true);
  });
});
