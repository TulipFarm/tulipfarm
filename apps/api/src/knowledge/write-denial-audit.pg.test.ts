/**
 * Refused writes are recorded, so path-probing is detectable.
 *
 * `write_page` and `POST /spaces/:id/pages` upsert by `(spaceId, path)`, so a caller who may read a
 * Space learns whether a path is occupied by comparing a success against a refusal. That bit cannot
 * be removed without either overwriting the hidden Page or making the Space read-only, so the
 * countermeasure is detection: every refused write is recorded, and a burst from one actor is the
 * probing signature.
 *
 * The ledger must not become the oracle the gate just closed. A denial records *who* was refused
 * and *what kind* of subject they aimed at — never the path, Page id, Space id or content, since
 * naming a withheld subject would leak it to every reader of the audit ledger. This mirrors
 * `auditRetrieval`, which targets the Knowledge boundary rather than the documents.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  EmbeddingPort,
  KnowledgeToolContext,
  KnowledgeWriteDenial,
} from "@tulipfarm/knowledge";
import {
  BLANKET_READ_PRINCIPAL,
  KNOWLEDGE_TOOLS,
  KnowledgeService,
  PageReadGate,
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
const HIDDEN_PATH = "hr/layoffs";

const byName = Object.fromEntries(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));
type Result = { success: boolean };

describe("a refused write is recorded", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let gate: PageReadGate;
  let acl: PgKnowledgeAclRepo;
  let spaceId: string;
  let hiddenPage: string;
  let author: string;
  let outsider: string;
  let caller: string | undefined;
  let recorded: KnowledgeWriteDenial[];
  let sinkThrows: boolean;

  const sink = {
    recordWriteDenial: async (denial: KnowledgeWriteDenial) => {
      recorded.push(denial);
      if (sinkThrows) throw new Error("ledger unavailable");
    },
  };

  async function addMember(name: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now())`,
      [id, `${name}-${id}@example.com`, name]
    );
    return id;
  }

  async function restrict(
    kind: "page" | "space",
    subjectId: string,
    userId: string
  ): Promise<void> {
    await acl.remove(DEPLOYMENT_BUSINESS_ID, kind, subjectId, BLANKET_READ_PRINCIPAL);
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind: kind,
      subjectId,
      principal: { kind: "user", id: userId },
      capability: "read",
      effect: "grant",
      origin: "authored",
    });
  }

  const authorPage = (path: string, content: string) =>
    app.inject({
      method: "POST",
      url: `${base}/spaces/${spaceId}/pages`,
      payload: { path, content },
    });

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
    gate = new PageReadGate(db);
    recorded = [];
    sinkThrows = false;

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
      gate,
      undefined,
      undefined,
      undefined,
      undefined,
      sink
    );
    await app.ready();

    author = await addMember("author");
    outsider = await addMember("outsider");

    caller = author;
    const wrote = await service.writePage({
      spaceId,
      path: HIDDEN_PATH,
      content: `# Layoffs\n\nCodeword ${SECRET}.`,
    });
    if (!wrote.ok || !("page" in wrote)) throw new Error("seed write failed");
    hiddenPage = wrote.page._id;
    await restrict("page", hiddenPage, author);
    caller = outsider;
    recorded = [];
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  describe("through the route", () => {
    it("records the refusal when a taken path holds a Page the caller cannot read", async () => {
      const res = await authorPage(HIDDEN_PATH, "# seized");

      expect(res.statusCode).toBe(404);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ actorId: outsider, subjectKind: "page" });
    });

    it("records the refusal when the whole Space is unreadable", async () => {
      await restrict("space", spaceId, author);

      const res = await authorPage("brand-new", "# injected");

      expect(res.statusCode).toBe(404);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ actorId: outsider, subjectKind: "space" });
    });

    it("records a refused update, delete and revision", async () => {
      await app.inject({
        method: "PUT",
        url: `${base}/pages/${hiddenPage}`,
        headers: { "if-match": '"1"' },
        payload: {},
      });
      await app.inject({ method: "DELETE", url: `${base}/pages/${hiddenPage}` });
      await app.inject({
        method: "POST",
        url: `${base}/pages/${hiddenPage}/revisions`,
        payload: { content: "# probe", reason: null },
      });

      expect(recorded.map((d) => d.action)).toEqual([
        "knowledge.page.update",
        "knowledge.page.delete",
        "knowledge.page.revise",
      ]);
    });

    it("records nothing when the write is allowed", async () => {
      const created = await authorPage("brand-new", "# fine");

      expect(created.statusCode).toBe(201);
      expect(recorded).toEqual([]);
    });

    it("never names the path, the Page, the Space or the content", async () => {
      // Both branches: the Page one needs a readable Space, so it must run before the Space is shut.
      await authorPage(HIDDEN_PATH, `# seized ${SECRET}`);
      await restrict("space", spaceId, author);
      await authorPage("brand-new", "# injected");

      expect(recorded.map((d) => d.subjectKind)).toEqual(["page", "space"]);
      const payload = JSON.stringify(recorded);
      for (const secret of [HIDDEN_PATH, "layoffs", SECRET, hiddenPage, spaceId, "injected"]) {
        expect(payload).not.toContain(secret);
      }
    });

    it("still refuses identically when the ledger is unavailable", async () => {
      sinkThrows = true;

      const denied = await authorPage(HIDDEN_PATH, "# seized");
      const absent = await app.inject({
        method: "POST",
        url: `${base}/spaces/${randomUUID()}/pages`,
        payload: { path: HIDDEN_PATH, content: "# seized" },
      });

      expect(denied.statusCode).toBe(absent.statusCode);
      expect(denied.body).toBe(absent.body);
    });
  });

  describe("through the Tool", () => {
    const ctx = (userId: string, agentId?: string): KnowledgeToolContext => ({
      userId,
      service,
      pageGate: gate,
      denials: sink,
      ...(agentId === undefined ? {} : { agentId }),
    });

    it("records a refused write_page, naming the Agent that attempted it", async () => {
      const res = (await byName.write_page.handler(
        { spaceId, path: HIDDEN_PATH, content: "# seized" },
        ctx(outsider, "agent-7")
      )) as Result;

      expect(res.success).toBe(false);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        actorId: outsider,
        agentId: "agent-7",
        subjectKind: "page",
      });
    });

    it("records the refusal when the Space is unreadable", async () => {
      await restrict("space", spaceId, author);

      await byName.write_page.handler(
        { spaceId, path: "brand-new", content: "# x" },
        ctx(outsider)
      );

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ subjectKind: "space" });
    });

    it("records nothing when the write is allowed", async () => {
      const res = (await byName.write_page.handler(
        { spaceId, path: "brand-new", content: "# fine" },
        ctx(outsider)
      )) as Result;

      expect(res.success).toBe(true);
      expect(recorded).toEqual([]);
    });

    it("still refuses identically when the ledger is unavailable", async () => {
      sinkThrows = true;

      const denied = (await byName.write_page.handler(
        { spaceId, path: HIDDEN_PATH, content: "# seized" },
        ctx(outsider)
      )) as Result;
      const absent = (await byName.write_page.handler(
        { spaceId: randomUUID(), path: HIDDEN_PATH, content: "# seized" },
        ctx(outsider)
      )) as Result;

      expect(JSON.stringify(denied)).toBe(JSON.stringify(absent));
    });
  });
});
