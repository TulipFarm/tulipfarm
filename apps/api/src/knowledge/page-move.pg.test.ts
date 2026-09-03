import { noEmbeddings } from "./test-support";
/**
 * Moving a Page is a permission change wearing the clothes of an organisational tidy-up.
 *
 * Dragging a Page out of a restricted Space publishes it to the whole Business; dragging one in
 * silently hides it from people relying on it. So a move can be *asked, before it happens*, what it
 * would do to the Page's readers.
 *
 * The answer is computed from the same effective-entry resolution that decides reads, so a preview
 * cannot disagree with what actually happens afterwards. A test here pins that equality directly.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
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
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRequireAuthorization } from "../authz/route-gate";
import { makeMigratedPglite } from "../test/pglite";
import { PageReadGate } from "./page-access";
import { registerKnowledgeRoutes } from "./routes";

const base = "/api/v1/knowledge";

type Subject = { kind: string; id: string };

describe("moving a Page reports its readership change", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string | undefined;
  let openSpace: string;
  let closedSpace: string;
  let insider: string;
  let outsider: string;

  async function addMember(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now())`,
      [id, `${id}@example.test`, id]
    );
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, id]
    );
    return id;
  }

  async function makeSpace(name: string): Promise<string> {
    const created = await service.createSpace({ name });
    if (!created.ok) throw new Error("space creation failed");
    return created.space._id;
  }

  async function writePage(spaceId: string, path: string, content: string): Promise<string> {
    const res = await service.writePage({ spaceId, path, content });
    if (!res.ok || !("page" in res)) throw new Error(`write failed: ${JSON.stringify(res)}`);
    return res.page._id;
  }

  const restrictSpace = (id: string, subjects: Subject[]) =>
    app.inject({ method: "PUT", url: `${base}/spaces/${id}/restriction`, payload: { subjects } });

  const restrictPage = (id: string, subjects: Subject[]) =>
    app.inject({ method: "PUT", url: `${base}/pages/${id}/restriction`, payload: { subjects } });

  const preview = (pageId: string, dest: { spaceId?: string; path?: string }) =>
    app.inject({ method: "POST", url: `${base}/pages/${pageId}/move/preview`, payload: dest });

  const move = (pageId: string, dest: { spaceId?: string; path?: string }) =>
    app.inject({ method: "POST", url: `${base}/pages/${pageId}/move`, payload: dest });

  const getPage = (id: string) => app.inject({ method: "GET", url: `${base}/pages/${id}` });

  /** Who actually reads the Page right now, per the gate that serves reads. */
  async function actualReaders(pageId: string): Promise<Subject[]> {
    const subjects = await new PgKnowledgeSubjectStore(db).getManyAuthored(DEPLOYMENT_BUSINESS_ID, [
      pageId,
    ]);
    const entries = subjects[0]?.entries ?? [];
    return entries
      .filter((e) => e.effect === "grant")
      .map((e) => ({ kind: e.principal.kind, id: e.principal.id }));
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const acl = new PgKnowledgeAclRepo(db);
    service = new KnowledgeService({
      pages: new PgKnowledgePageRepo(db),
      chunks: new PgKnowledgeChunkRepo(db),
      revisions: new PgKnowledgeRevisionRepo(db),
      spaces: new PgKnowledgeSpaceRepo(db),
      links: new PgKnowledgeLinksRepo(db),
      overrides: new PgKnowledgeSpaceOverrideRepo(db),
      embeddings: noEmbeddings(),
      retrieval: new PageRetrievalService(db),
      readership: new PgKnowledgeSubjectStore(db),
      acl,
    });

    app = Fastify();
    registerKnowledgeRoutes(
      app,
      service,
      async (req) => {
        if (caller === undefined) return;
        req.user = {
          _id: caller,
          email: "u@example.com",
          passwordHash: "x",
          name: null,
          role: "member",
          status: "active" as const,
          createdAt: new Date(),
        };
        req.principal = {
          id: caller,
          kind: "user",
          businessId: DEPLOYMENT_BUSINESS_ID,
          credential: "session",
          authMethods: ["password"],
          authenticatedAt: new Date(),
          role: "member",
        };
      },
      makeRequireAuthorization(),
      new PageReadGate(db),
      new PageRetrievalService(db)
    );
    await app.ready();

    insider = await addMember();
    outsider = await addMember();
    caller = insider;
    openSpace = await makeSpace("handbook");
    closedSpace = await makeSpace("hr");
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("evaluates a move without performing it", async () => {
    const pageId = await writePage(openSpace, "notes/one", "# One");
    const before = await actualReaders(pageId);

    const res = await preview(pageId, { spaceId: closedSpace, path: "notes/one" });

    expect(res.statusCode).toBe(200);
    expect(await actualReaders(pageId)).toEqual(before);
    const page = await getPage(pageId);
    expect(page.json().spaceId).toBe(openSpace);
  });

  it("reports widening, and names who gains, when leaving a restricted Space", async () => {
    await restrictSpace(closedSpace, [{ kind: "user", id: insider }]);
    const pageId = await writePage(closedSpace, "comp/bands", "# Bands");

    const res = await preview(pageId, { spaceId: openSpace, path: "comp/bands" });

    expect(res.json().effect).toBe("widens");
    expect(res.json().gained).toEqual([{ kind: "role", id: "role-everyone" }]);
    // Not `[insider]`: the blanket Role contains them, so publishing the Page costs them nothing.
    expect(res.json().lost).toEqual([]);
  });

  it("reports narrowing, and names who loses, when entering a restricted Space", async () => {
    await restrictSpace(closedSpace, [{ kind: "user", id: insider }]);
    const pageId = await writePage(openSpace, "notes/one", "# One");

    const res = await preview(pageId, { spaceId: closedSpace, path: "notes/one" });

    expect(res.json().effect).toBe("narrows");
    expect(res.json().lost).toEqual([{ kind: "role", id: "role-everyone" }]);
    // Nobody gains: insider already read the Page as a member of the Business.
    expect(res.json().gained).toEqual([]);
  });

  it("reports no change when readership is unaffected", async () => {
    const pageId = await writePage(openSpace, "notes/one", "# One");

    const res = await preview(pageId, { spaceId: openSpace, path: "archive/one" });

    expect(res.json().effect).toBe("unchanged");
    expect(res.json().gained).toEqual([]);
    expect(res.json().lost).toEqual([]);
  });

  it("reports whether everyone the Page's own restriction names survives the destination", async () => {
    await restrictSpace(closedSpace, [{ kind: "user", id: insider }]);
    const survives = await writePage(openSpace, "notes/a", "# A");
    const doesNot = await writePage(openSpace, "notes/b", "# B");
    await restrictPage(survives, [{ kind: "user", id: insider }]);
    await restrictPage(doesNot, [
      { kind: "user", id: insider },
      { kind: "user", id: outsider },
    ]);

    const good = await preview(survives, { spaceId: closedSpace, path: "notes/a" });
    expect(good.statusCode).toBe(200);
    expect(good.json().ownRestrictionSurvives).toBe(true);

    // The Page's own list names someone the destination Space excludes. The caller still reads the
    // Page either way — the useful question is whether the people they named do.
    const bad = await preview(doesNot, { spaceId: closedSpace, path: "notes/b" });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().ownRestrictionSurvives).toBe(false);
    expect(bad.json().lost).toEqual([{ kind: "user", id: outsider }]);
  });

  it("reports null for a Page carrying no restriction of its own", async () => {
    const pageId = await writePage(openSpace, "notes/one", "# One");
    const res = await preview(pageId, { spaceId: closedSpace, path: "notes/one" });
    expect(res.json().ownRestrictionSurvives).toBeNull();
  });

  it("produces exactly the readership the preview predicted", async () => {
    await restrictSpace(closedSpace, [{ kind: "user", id: insider }]);
    const pageId = await writePage(openSpace, "notes/one", "# One");

    const predicted = (await preview(pageId, { spaceId: closedSpace, path: "notes/one" })).json();
    expect((await move(pageId, { spaceId: closedSpace, path: "notes/one" })).statusCode).toBe(200);

    const after = await actualReaders(pageId);
    expect(after).toEqual(predicted.after);
  });

  it("applies the predicted denial: an excluded member loses the Page after the move", async () => {
    await restrictSpace(closedSpace, [{ kind: "user", id: insider }]);
    const pageId = await writePage(openSpace, "notes/one", "# One");

    caller = outsider;
    expect((await getPage(pageId)).statusCode).toBe(200);

    caller = insider;
    await move(pageId, { spaceId: closedSpace, path: "notes/one" });

    caller = outsider;
    expect((await getPage(pageId)).statusCode).toBe(404);
  });

  it("updates the readership of Pages nested beneath the moved Page", async () => {
    await restrictSpace(closedSpace, [{ kind: "user", id: insider }]);
    const parent = await writePage(openSpace, "notes", "# Notes");
    const child = await writePage(openSpace, "notes/detail", "# Detail");

    caller = outsider;
    expect((await getPage(child)).statusCode).toBe(200);

    caller = insider;
    await move(parent, { spaceId: closedSpace, path: "notes" });

    caller = outsider;
    expect((await getPage(child)).statusCode).toBe(404);
    caller = insider;
    expect((await getPage(child)).statusCode).toBe(200);
    expect((await getPage(child)).json().path).toBe("notes/detail");
  });

  it("never discloses a destination the caller cannot read", async () => {
    await restrictSpace(closedSpace, [{ kind: "user", id: insider }]);
    const pageId = await writePage(openSpace, "notes/one", "# One");

    caller = outsider;
    const res = await preview(pageId, { spaceId: closedSpace, path: "notes/one" });

    // 404, not 403: a 403 would confirm the Space exists and is restricted.
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(insider);
  });

  it("refuses to move a Page the caller cannot read", async () => {
    const pageId = await writePage(openSpace, "notes/one", "# One");
    await restrictPage(pageId, [{ kind: "user", id: insider }]);

    caller = outsider;
    expect((await preview(pageId, { path: "archive/one" })).statusCode).toBe(404);
    expect((await move(pageId, { path: "archive/one" })).statusCode).toBe(404);
  });

  it("leaves content and content version untouched", async () => {
    const pageId = await writePage(openSpace, "notes/one", "# One\n\nBody.");
    const before = await db.query<{ version: number; content: string }>(
      `SELECT version, content FROM knowledge_pages WHERE id = $1`,
      [pageId]
    );

    await move(pageId, { spaceId: closedSpace, path: "notes/one" });

    const after = await db.query<{ version: number; content: string }>(
      `SELECT version, content FROM knowledge_pages WHERE id = $1`,
      [pageId]
    );
    expect(after.rows[0].content).toBe(before.rows[0].content);
    expect(after.rows[0].version).toBe(before.rows[0].version);
  });

  it("reports what the move does to Pages nested beneath, not only the one grabbed", async () => {
    await restrictSpace(closedSpace, [{ kind: "user", id: insider }]);
    const branch = await writePage(closedSpace, "team", `---\ntype: Note\ntitle: t\n---\n\nBody.`);
    const leaf = await writePage(
      closedSpace,
      "team/notes",
      `---\ntype: Note\ntitle: t\n---\n\nBody.`
    );

    const res = await preview(branch, { spaceId: openSpace, path: "team" });
    expect(res.statusCode).toBe(200);

    const nested = res.json().descendants as Array<{
      pageId: string;
      path: string;
      effect: string;
    }>;
    // Dragging a branch is where the largest accidental disclosures come from, so the Page the
    // operator grabbed is not the whole story.
    expect(nested.map((d) => d.pageId)).toEqual([leaf]);
    expect(nested[0].path).toBe("team/notes");
    expect(nested[0].effect).toBe("widens");
  });

  it("reports no descendants for a leaf, rather than omitting the field", async () => {
    const leaf = await writePage(closedSpace, "solo", `---\ntype: Note\ntitle: t\n---\n\nBody.`);
    const res = await preview(leaf, { path: "archive/solo" });
    expect(res.statusCode).toBe(200);
    expect(res.json().descendants).toEqual([]);
  });

  /**
   * A nested Page the operator cannot read is omitted, not summarised. The move still relocates it
   * — the preview is a disclosure surface, not the authority for the write — but naming it, or even
   * counting it, would tell the operator that a Page exists where they are entitled to see nothing.
   */
  describe("a nested Page the operator cannot read", () => {
    const body = `---\ntype: Note\ntitle: t\n---\n\nBody.`;

    async function branchWithHiddenLeaf(): Promise<{ branch: string; open: string }> {
      const branch = await writePage(openSpace, "team", body);
      const open = await writePage(openSpace, "team/roster", body);
      const hidden = await writePage(openSpace, "team/pay", body);
      await restrictPage(hidden, [{ kind: "user", id: insider }]);
      return { branch, open };
    }

    it("is omitted from the preview", async () => {
      const { branch, open } = await branchWithHiddenLeaf();
      caller = outsider;

      const res = await preview(branch, { spaceId: closedSpace, path: "team" });

      expect(res.statusCode).toBe(200);
      expect(res.json().descendants.map((d: { pageId: string }) => d.pageId)).toEqual([open]);
    });

    it("leaves no trace in the payload — not its path, not a count", async () => {
      const { branch } = await branchWithHiddenLeaf();
      caller = outsider;

      const res = await preview(branch, { spaceId: closedSpace, path: "team" });

      expect(JSON.stringify(res.json())).not.toContain("team/pay");
      expect(Object.keys(res.json())).not.toContain("hiddenDescendants");
    });

    it("is still reported to someone who may read it", async () => {
      const { branch, open } = await branchWithHiddenLeaf();
      caller = insider;

      const res = await preview(branch, { spaceId: closedSpace, path: "team" });

      expect(res.json().descendants).toHaveLength(2);
      expect(res.json().descendants.map((d: { pageId: string }) => d.pageId)).toContain(open);
    });

    it("is moved anyway, because the preview gates disclosure and not the write", async () => {
      const { branch } = await branchWithHiddenLeaf();
      caller = outsider;

      const res = await move(branch, { spaceId: closedSpace, path: "team" });
      expect(res.statusCode).toBe(200);

      caller = insider;
      const hidden = await service.getPageByPath(closedSpace, "team/pay");
      expect(hidden).not.toBeNull();
    });
  });
});
