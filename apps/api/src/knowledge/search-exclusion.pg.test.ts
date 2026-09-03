import { noEmbeddings } from "./test-support";
/**
 * Search is where a leak is most likely and least visible. Nothing here has to disclose a title to
 * give a withheld Page away: a result count that includes it, an ordering that shifts around a gap,
 * a short page of results, or a "no results" that reads differently from an ordinary one all leak
 * by arithmetic rather than by disclosure.
 *
 * So these tests do not check that withheld titles are absent — that is the easy half. They check
 * that the *shape* of every answer is the shape a corpus without those Pages would have produced.
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

describe("finding a Page reveals nothing about the Pages it withheld", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string;
  let insider: string;
  let spaceId: string;

  async function addUser(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', NULL, 'member', 'active', now())`,
      [id, `${id}@example.test`]
    );
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, id]
    );
    return id;
  }

  async function writePage(path: string, content: string, tags: string[] = []): Promise<string> {
    const front = `---\ntitle: ${path}\ntags: [${tags.join(", ")}]\n---\n\n`;
    const r = await service.writePage({ spaceId, path, content: front + content });
    if (!r.ok || !("page" in r)) throw new Error(`write failed: ${path}`);
    return r.page._id;
  }

  const restrict = (pageId: string) =>
    app.inject({
      method: "PUT",
      url: `${base}/pages/${pageId}/restriction`,
      payload: { subjects: [{ kind: "user", id: insider }] },
    });

  const search = (query: string, limit = 10) =>
    app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query, limit, granularity: "page" },
    });

  beforeEach(async () => {
    db = await makeMigratedPglite();
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
      acl: new PgKnowledgeAclRepo(db),
    });

    insider = await addUser();
    caller = insider;

    app = Fastify();
    registerKnowledgeRoutes(
      app,
      service,
      async (req) => {
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

    const s = await service.createSpace({ name: "handbook" });
    if (!s.ok) throw new Error("space creation failed");
    spaceId = s.space._id;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("answers a query that matches only withheld Pages exactly as it answers one that matches nothing", async () => {
    const secret = await writePage("comp/bands", "salary salary salary ORCHIDBANK");
    expect((await restrict(secret)).statusCode).toBe(200);

    caller = await addUser();
    const withheld = await search("salary");
    const nothing = await search("zzzznomatchzzzz");

    expect(withheld.statusCode).toBe(nothing.statusCode);
    expect(withheld.body).toBe(nothing.body);
  });

  it("returns a full page of results even when the natural top hits were withheld", async () => {
    for (let i = 0; i < 6; i += 1) {
      const id = await writePage(`comp/secret-${i}`, "widget widget widget");
      expect((await restrict(id)).statusCode).toBe(200);
    }
    for (let i = 0; i < 5; i += 1) await writePage(`open/public-${i}`, "widget widget widget");

    caller = await addUser();
    const res = await search("widget", 5);

    expect(res.statusCode).toBe(200);
    // A short page is itself a signal that something was removed from it.
    expect(res.json().results).toHaveLength(5);
    for (const r of res.json().results) expect(r.path).toMatch(/^open\//);
  });

  it("orders results as if the withheld Pages had never been written", async () => {
    const open: string[] = [];
    for (let i = 0; i < 4; i += 1) open.push(`open/doc-${i}`);
    for (const p of open) await writePage(p, "gadget gadget");

    const outsider = await addUser();
    caller = outsider;
    const before = (await search("gadget")).json().results.map((r: { path: string }) => r.path);

    caller = insider;
    for (let i = 0; i < 3; i += 1) {
      const id = await writePage(`comp/hidden-${i}`, "gadget gadget gadget gadget");
      expect((await restrict(id)).statusCode).toBe(200);
    }

    caller = outsider;
    const after = (await search("gadget")).json().results.map((r: { path: string }) => r.path);

    // The hidden Pages score higher, so a leaky implementation would reorder or shorten this.
    expect(after).toEqual(before);
  });

  it("keeps tag browsing the same length it would be in a corpus without the withheld Pages", async () => {
    for (let i = 0; i < 4; i += 1) {
      const id = await writePage(`comp/tagged-${i}`, "body", ["finance"]);
      expect((await restrict(id)).statusCode).toBe(200);
    }
    for (let i = 0; i < 3; i += 1) await writePage(`open/tagged-${i}`, "body", ["finance"]);

    caller = await addUser();
    const res = await app.inject({ method: "GET", url: `${base}/pages?tags=finance&limit=3` });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(3);
    for (const p of res.json().items) expect(p.path).toMatch(/^open\//);
  });

  it("carries the Agent label into results, so it is the same label the tree shows", async () => {
    const r = await service.writePage({
      spaceId,
      path: "notes/auto",
      content: "---\ntitle: auto\n---\n\nsprocket sprocket",
      author: { kind: "agent", id: "agent-scribe" },
    });
    if (!r.ok || !("page" in r)) throw new Error("write failed");

    const res = await search("sprocket");
    expect(res.json().results[0].authorKind).toBe("agent");
  });

  it("names no withheld Page in any part of the response, including its warnings", async () => {
    const secret = await writePage("comp/bands", "widget ORCHIDBANK");
    expect((await restrict(secret)).statusCode).toBe(200);
    await writePage("open/tools", "widget");

    caller = await addUser();
    const res = await search("widget");

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(secret);
    expect(res.body).not.toContain("ORCHIDBANK");
    expect(res.body).not.toContain("comp/bands");
    expect(res.json().warnings).toEqual([]);
  });
});
