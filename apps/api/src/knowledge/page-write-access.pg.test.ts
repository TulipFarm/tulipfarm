/**
 * The write half of ticket 17.
 *
 * `page-routes-access.pg.test.ts` proves the *read* routes consult the gate. These four do not,
 * and a write route that does not ask is worse than a write hole: `PageUpdateBodySchema` has no
 * required fields, so `PUT` with an empty body is a no-op whose 200 carries the whole Page back.
 * That makes the update route a read primitive for a Page the caller was just told does not exist.
 * The version conflict is an oracle of the same kind — 409 against 404 confirms the Page is there,
 * and versions start at 1, so one guess is enough.
 *
 * `POST /spaces/:id/pages` is the same defect wearing a different hat: it upserts by path, so
 * authoring a Page at a path already taken by a restricted one overwrites its content and takes
 * over its authorship, without ever naming it.
 *
 * Every assertion here is paired with the author performing the same call successfully, so a
 * blanket "deny everything" would not pass.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  BLANKET_READ_PRINCIPAL,
  KnowledgeService,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
} from "@tulipfarm/knowledge";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRequireAuthorization } from "../authz/route-gate";
import { makeMigratedPglite } from "../test/pglite";
import { PageReadGate } from "./page-access";
import { registerKnowledgeRoutes } from "./routes";

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

const base = "/api/v1/knowledge";
const SECRET = "ORCHIDBANK";

describe("authored Page write routes consult the gate", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let acl: PgKnowledgeAclRepo;
  let spaceId: string;
  let author: string;
  let outsider: string;
  let caller: string | undefined;

  async function addMember(name: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now())`,
      [id, `${name}@example.com`, name]
    );
    return id;
  }

  async function writePage(path: string, content: string): Promise<string> {
    const res = await service.writePage({ spaceId, path, content });
    if (!res.ok || !("page" in res)) throw new Error(`write failed: ${JSON.stringify(res)}`);
    return res.page._id;
  }

  async function restrictTo(pageId: string, userId: string): Promise<void> {
    await acl.remove(DEPLOYMENT_BUSINESS_ID, "page", pageId, BLANKET_READ_PRINCIPAL);
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind: "page",
      subjectId: pageId,
      principal: { kind: "user", id: userId },
      capability: "read",
      effect: "grant",
      origin: "authored",
    });
  }

  async function restrictSpaceTo(id: string, userId: string): Promise<void> {
    await acl.remove(DEPLOYMENT_BUSINESS_ID, "space", id, BLANKET_READ_PRINCIPAL);
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind: "space",
      subjectId: id,
      principal: { kind: "user", id: userId },
      capability: "read",
      effect: "grant",
      origin: "authored",
    });
  }

  /** Authors a restricted Page as `author` and leaves `caller` set to the outsider. */
  async function restrictedPage(path = "layoffs"): Promise<string> {
    caller = author;
    const id = await writePage(path, `# Q3 layoffs\n\nCodeword ${SECRET}.`);
    await restrictTo(id, author);
    caller = outsider;
    return id;
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
      embeddings: noEmbeddings(),
      acl,
    });
    const created = await service.createSpace({ name: "Handbook" });
    if (!created.ok) throw new Error("space creation failed");
    spaceId = created.space._id;

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
      new PageReadGate(db)
    );
    await app.ready();

    author = await addMember("author");
    outsider = await addMember("outsider");
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  describe("PUT /pages/:id", () => {
    it("does not hand a denied Page back through an empty update", async () => {
      const pageId = await restrictedPage();

      const res = await app.inject({
        method: "PUT",
        url: `${base}/pages/${pageId}`,
        headers: { "if-match": '"1"' },
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain("layoffs");
      expect(res.body).not.toContain(pageId);
    });

    it("answers a denied Page exactly as one that was never written, at every version guess", async () => {
      const pageId = await restrictedPage();

      for (const version of ['"1"', '"2"', '"99"']) {
        const denied = await app.inject({
          method: "PUT",
          url: `${base}/pages/${pageId}`,
          headers: { "if-match": version },
          payload: {},
        });
        const absent = await app.inject({
          method: "PUT",
          url: `${base}/pages/${randomUUID()}`,
          headers: { "if-match": version },
          payload: {},
        });
        expect(denied.statusCode, `If-Match ${version}`).toBe(absent.statusCode);
        expect(denied.body, `If-Match ${version}`).toBe(absent.body);
      }
    });

    it("leaves the Page untouched, so the author still reads what they wrote", async () => {
      const pageId = await restrictedPage();
      await app.inject({
        method: "PUT",
        url: `${base}/pages/${pageId}`,
        headers: { "if-match": '"1"' },
        payload: { content: "# Nothing to see\n\nreplaced" },
      });

      caller = author;
      const res = await app.inject({ method: "GET", url: `${base}/pages/${pageId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().content).toContain(SECRET);
    });

    it("still lets a member update a Page they can read", async () => {
      caller = author;
      const pageId = await writePage("onboarding", "# Onboarding\n\nStart here.");

      caller = outsider;
      const res = await app.inject({
        method: "PUT",
        url: `${base}/pages/${pageId}`,
        headers: { "if-match": '"1"' },
        payload: { content: "# Onboarding\n\nRevised." },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe("DELETE /pages/:id", () => {
    it("refuses to delete a denied Page, and the author still has it", async () => {
      const pageId = await restrictedPage();

      const res = await app.inject({ method: "DELETE", url: `${base}/pages/${pageId}` });
      expect(res.statusCode).toBe(404);

      caller = author;
      expect((await app.inject({ method: "GET", url: `${base}/pages/${pageId}` })).statusCode).toBe(
        200
      );
    });

    it("still lets a member delete a Page they can read", async () => {
      caller = author;
      const pageId = await writePage("onboarding", "# Onboarding");

      caller = outsider;
      const res = await app.inject({ method: "DELETE", url: `${base}/pages/${pageId}` });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /pages/:id/revisions", () => {
    it("refuses to snapshot a denied Page, and adds no revision to it", async () => {
      const pageId = await restrictedPage();

      const res = await app.inject({
        method: "POST",
        url: `${base}/pages/${pageId}/revisions`,
        payload: { content: "# Injected", reason: "probe" },
      });
      expect(res.statusCode).toBe(404);

      caller = author;
      const revisions = await app.inject({
        method: "GET",
        url: `${base}/pages/${pageId}/revisions`,
      });
      expect(revisions.json().items).toHaveLength(0);
    });

    it("still lets a member snapshot a Page they can read", async () => {
      caller = author;
      const pageId = await writePage("onboarding", "# Onboarding");

      caller = outsider;
      const res = await app.inject({
        method: "POST",
        url: `${base}/pages/${pageId}/revisions`,
        payload: { content: "# Onboarding\n\nsnapshot", reason: null },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("POST /spaces/:id/pages", () => {
    it("does not let authoring at a taken path overwrite a Page the author cannot read", async () => {
      const pageId = await restrictedPage();

      const res = await app.inject({
        method: "POST",
        url: `${base}/spaces/${spaceId}/pages`,
        payload: { path: "layoffs", content: "# Layoffs\n\nseized" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(pageId);

      caller = author;
      const still = await app.inject({ method: "GET", url: `${base}/pages/${pageId}` });
      expect(still.json().content).toContain(SECRET);
    });

    it("still authors a new Page, and still updates one the caller can read", async () => {
      caller = author;
      await writePage("onboarding", "# Onboarding");

      caller = outsider;
      const created = await app.inject({
        method: "POST",
        url: `${base}/spaces/${spaceId}/pages`,
        payload: { path: "handbook", content: "# Handbook\n\nnew" },
      });
      expect(created.statusCode).toBe(201);

      const updated = await app.inject({
        method: "POST",
        url: `${base}/spaces/${spaceId}/pages`,
        payload: { path: "onboarding", content: "# Onboarding\n\nrevised" },
      });
      expect(updated.statusCode).toBe(201);
    });
  });

  /**
   * Every other `/spaces/:id/*` route asks `canReadSpace` first, so a restricted Space answers as
   * if it were not there. This one only guarded the overwrite case, which left the Space itself
   * addressable: authoring at a free path succeeded (201) while a path already taken by a hidden
   * Page answered 404, and the pair of replies is an oracle for which paths inside a Space the
   * caller cannot read are occupied. It also let an outsider inject Pages that the Space's own
   * members — and their Agents — would then read back as knowledge.
   */
  describe("POST /spaces/:id/pages into a restricted Space", () => {
    it("refuses to author into a Space the caller cannot read", async () => {
      await restrictSpaceTo(spaceId, author);
      caller = outsider;

      const res = await app.inject({
        method: "POST",
        url: `${base}/spaces/${spaceId}/pages`,
        payload: { path: "brand-new", content: "# Injected\n\nby an outsider" },
      });

      expect(res.statusCode).toBe(404);
    });

    it("creates nothing, so the Space's members never read the injected Page", async () => {
      await restrictSpaceTo(spaceId, author);
      caller = outsider;
      await app.inject({
        method: "POST",
        url: `${base}/spaces/${spaceId}/pages`,
        payload: { path: "brand-new", content: "# Injected\n\nby an outsider" },
      });

      caller = author;
      const listed = await app.inject({ method: "GET", url: `${base}/spaces/${spaceId}/pages` });
      expect(listed.json().items.map((p: { path: string }) => p.path)).not.toContain("brand-new");
    });

    it("answers a free path, a taken hidden path and an absent Space identically", async () => {
      caller = author;
      await writePage("layoffs", `# Q3 layoffs\n\nCodeword ${SECRET}.`);
      await restrictSpaceTo(spaceId, author);
      caller = outsider;

      const post = (space: string, path: string) =>
        app.inject({
          method: "POST",
          url: `${base}/spaces/${space}/pages`,
          payload: { path, content: "# Probe" },
        });

      const free = await post(spaceId, "brand-new");
      const taken = await post(spaceId, "layoffs");
      const absent = await post(randomUUID(), "brand-new");

      expect(free.statusCode).toBe(absent.statusCode);
      expect(free.body).toBe(absent.body);
      expect(taken.statusCode).toBe(absent.statusCode);
      expect(taken.body).toBe(absent.body);
    });

    it("still lets a member of the restricted Space author in it", async () => {
      await restrictSpaceTo(spaceId, author);
      caller = author;

      const res = await app.inject({
        method: "POST",
        url: `${base}/spaces/${spaceId}/pages`,
        payload: { path: "brand-new", content: "# Mine\n\nallowed" },
      });

      expect(res.statusCode).toBe(201);
    });

    it("still lets any member author in an unrestricted Space", async () => {
      caller = outsider;

      const res = await app.inject({
        method: "POST",
        url: `${base}/spaces/${spaceId}/pages`,
        payload: { path: "brand-new", content: "# Open\n\nallowed" },
      });

      expect(res.statusCode).toBe(201);
    });
  });
});
