/**
 * The Agent's precision Knowledge Tools obey the same Page gate as retrieval.
 *
 * `query_knowledge` carried a Principal into connected-source retrieval, so it *looked* gated — but
 * its OKF arms ran straight against the corpus, and the exact-lookup Tools — `get_page`,
 * `get_page_by_path`, `navigate_space`, `get_backlinks`, `get_space_graph` — read Pages directly
 * and skipped the gate entirely. An Agent could name a restricted Page's id or path and read it
 * whole. The search side is covered in `tool-search-access.pg.test.ts`.
 *
 * Denial is indistinguishable from absence: a withheld Page answers exactly as one that was never
 * written, so nothing in a Tool result reveals that something was withheld.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { ROUTINE_SERVICE_PRINCIPAL_ID } from "@tulipfarm/constants";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  BLANKET_READ_PRINCIPAL,
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

describe("precision Knowledge Tools obey the Page gate", () => {
  let db: PGlite;
  let service: KnowledgeService;
  let gate: PageReadGate;
  let acl: PgKnowledgeAclRepo;
  let author: string;
  let outsider: string;
  let spaceId: string;
  let openPage: string;
  let closedPage: string;

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

  async function writePage(path: string, content: string, userId: string): Promise<string> {
    const res = await call("write_page", { spaceId, path, content }, userId);
    if (!res.success) throw new Error(`write_page failed: ${JSON.stringify(res)}`);
    return (res.data as { id: string }).id;
  }

  /** Replace the blanket grant with an allowlist of one — the product's "restrict" action. */
  async function restrictTo(pageId: string, userId: string): Promise<void> {
    await acl.remove(BUSINESS, "page", pageId, BLANKET_READ_PRINCIPAL);
    await acl.put({
      businessId: BUSINESS,
      subjectKind: "page",
      subjectId: pageId,
      principal: { kind: "user", id: userId },
      effect: "grant",
      capability: "read",
    });
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
      retrieval: new PageRetrievalService(db),
      acl,
    });
    gate = new PageReadGate(db, BUSINESS);

    author = await addMember();
    outsider = await addMember();

    const sp = await call("create_space", { name: "ops" }, author);
    spaceId = (sp.data as { id: string }).id;

    openPage = await writePage(
      "runbooks/deploy",
      "---\ntype: Playbook\ntitle: Deploy\n---\n\nHow we ship.",
      author
    );
    closedPage = await writePage(
      "hr/layoffs",
      "---\ntype: Playbook\ntitle: Layoffs\n---\n\nConfidential headcount plan.",
      author
    );
    await restrictTo(closedPage, author);
  });

  afterEach(async () => {
    await db.close();
  });

  it("get_page serves a Page the actor may read", async () => {
    const res = await call("get_page", { pageId: openPage }, outsider);
    expect(res.success).toBe(true);
  });

  it("get_page answers a restricted Page exactly as one that was never written", async () => {
    const denied = await call("get_page", { pageId: closedPage }, outsider);
    const missing = await call("get_page", { pageId: randomUUID() }, outsider);

    expect(denied.success).toBe(false);
    expect(JSON.stringify(denied)).toBe(JSON.stringify(missing));
  });

  it("get_page_by_path answers a restricted path exactly as one that does not exist", async () => {
    const denied = await call("get_page_by_path", { spaceId, path: "hr/layoffs" }, outsider);
    const missing = await call("get_page_by_path", { spaceId, path: "hr/nothing" }, outsider);

    expect(denied.success).toBe(false);
    expect(JSON.stringify(denied)).toBe(JSON.stringify(missing));
  });

  it("get_backlinks withholds a restricted Page's inbound links", async () => {
    const res = await call("get_backlinks", { pageId: closedPage }, outsider);
    expect(res.success).toBe(false);
  });

  it("navigate_space omits a restricted Page from the listing", async () => {
    const res = await call("navigate_space", { spaceId, dirPath: "" }, outsider);
    expect(res.success).toBe(true);
    expect(JSON.stringify(res)).not.toContain("layoffs");
    expect(JSON.stringify(res)).not.toContain("Layoffs");
  });

  it("get_space_graph omits a restricted Page's node", async () => {
    const res = await call("get_space_graph", { spaceId }, outsider);
    expect(res.success).toBe(true);
    expect(JSON.stringify(res)).not.toContain(closedPage);
  });

  it("serves the author every Page, so the gate filters rather than breaks", async () => {
    expect((await call("get_page", { pageId: openPage }, author)).success).toBe(true);
    expect((await call("get_page", { pageId: closedPage }, author)).success).toBe(true);
  });

  it("lets a Routine read an unrestricted Page and withholds a restricted one", async () => {
    const open = await call("get_page", { pageId: openPage }, ROUTINE_SERVICE_PRINCIPAL_ID);
    const closed = await call("get_page", { pageId: closedPage }, ROUTINE_SERVICE_PRINCIPAL_ID);

    expect(open.success).toBe(true);
    expect(closed.success).toBe(false);
  });

  it("refuses every precision Tool when the host wired no gate", async () => {
    const ungated: KnowledgeToolContext = { userId: author, service };
    const res = (await byName.get_page.handler({ pageId: openPage }, ungated)) as Result;
    expect(res.success).toBe(false);
  });

  it("is inert when nothing is restricted: two members get byte-identical results", async () => {
    const a = await call("get_page", { pageId: openPage }, author);
    const b = await call("get_page", { pageId: openPage }, outsider);
    const navA = await call("navigate_space", { spaceId, dirPath: "runbooks" }, author);
    const navB = await call("navigate_space", { spaceId, dirPath: "runbooks" }, outsider);

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(navB)).toBe(JSON.stringify(navA));
  });

  /**
   * `write_page` is the Tool twin of `POST /spaces/:id/pages`, and it upserts by `(spaceId, path)`
   * the same way — so an Agent could name a restricted Page's path, replace its body and take over
   * its authorship without ever being able to read it. The route was gated; the Tool was not, which
   * left the more-trafficked half of the pair open, since Agents are the primary writers here.
   *
   * Authority follows `ctx.userId`, as it does for every other gated Tool in this file: `agentId`
   * records who wrote, never what may be written.
   */
  describe("write_page obeys the gate", () => {
    async function restrictSpaceTo(id: string, userId: string): Promise<void> {
      await acl.remove(BUSINESS, "space", id, BLANKET_READ_PRINCIPAL);
      await acl.put({
        businessId: BUSINESS,
        subjectKind: "space",
        subjectId: id,
        principal: { kind: "user", id: userId },
        effect: "grant",
        capability: "read",
      });
    }

    it("refuses to overwrite a Page the caller cannot read", async () => {
      const res = await call(
        "write_page",
        { spaceId, path: "hr/layoffs", content: "# Layoffs\n\nseized" },
        outsider
      );

      expect(res.success).toBe(false);
    });

    it("leaves the Page and its authorship untouched", async () => {
      await call(
        "write_page",
        { spaceId, path: "hr/layoffs", content: "# Layoffs\n\nseized" },
        outsider
      );

      const still = await call("get_page", { pageId: closedPage }, author);
      expect(JSON.stringify(still)).toContain("Confidential headcount plan");
    });

    it("answers a denied path exactly as an absent Space", async () => {
      const denied = await call(
        "write_page",
        { spaceId, path: "hr/layoffs", content: "# Probe" },
        outsider
      );
      const absent = await call(
        "write_page",
        { spaceId: randomUUID(), path: "hr/layoffs", content: "# Probe" },
        outsider
      );

      expect(JSON.stringify(denied)).toBe(JSON.stringify(absent));
    });

    it("refuses to author into a Space the caller cannot read", async () => {
      await restrictSpaceTo(spaceId, author);

      const res = await call(
        "write_page",
        { spaceId, path: "brand-new", content: "# Injected" },
        outsider
      );

      expect(res.success).toBe(false);
    });

    it("refuses to author when the host wired no gate", async () => {
      const ungated: KnowledgeToolContext = { userId: author, service };
      const res = (await byName.write_page.handler(
        { spaceId, path: "brand-new", content: "# Probe" },
        ungated
      )) as Result;

      // A crash would also report `success: false`, so pin the deliberate refusal: an unwired gate
      // must deny the way a missing Space does, not surface an internal error.
      expect(res.error).toEqual({ code: "not_found", message: "space_not_found" });
      const listed = await call("navigate_space", { spaceId, dirPath: "" }, author);
      expect(JSON.stringify(listed)).not.toContain("brand-new");
    });

    it("still lets a member author a new Page and update one they can read", async () => {
      const created = await call(
        "write_page",
        { spaceId, path: "brand-new", content: "# Open\n\nallowed" },
        outsider
      );
      const updated = await call(
        "write_page",
        { spaceId, path: "runbooks/deploy", content: "# Deploy\n\nrevised" },
        outsider
      );

      expect(created.success).toBe(true);
      expect(updated.success).toBe(true);
    });

    it("still lets a member of a restricted Space author in it", async () => {
      await restrictSpaceTo(spaceId, author);

      const res = await call(
        "write_page",
        { spaceId, path: "brand-new", content: "# Mine" },
        author
      );

      expect(res.success).toBe(true);
    });
  });
});
