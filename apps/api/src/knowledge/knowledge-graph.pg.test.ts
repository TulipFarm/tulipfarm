import { noEmbeddings } from "./test-support";
/**
 * Ticket 29 — the cross-Space Page-link graph.
 *
 * The per-Space graph already refuses to draw a withheld Page. Widening it to the whole Business
 * opens a second, quieter channel: *shape*. An edge that stops in mid-air, a node whose degree
 * exceeds the arrows you can count, or a "42 pages" caption above 39 circles each say "something is
 * here that you may not see", and usually say what it connects to. The tests below assert that the
 * graph a restricted reader gets is not a censored copy of the full graph but a smaller graph that
 * is internally consistent — indistinguishable from the graph of a Business that simply has fewer
 * Pages.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  BLANKET_READ_PRINCIPAL,
  KnowledgeService,
  PageRetrievalService,
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

const base = "/api/v1/knowledge";
const SECRET = "Q3-layoffs-engineering";

type GraphNode = { id: string; path: string | null; title: string; spaceId: string };
type GraphEdge = { sourceId: string; targetId: string };
type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  spaces: Array<{ id: string; name: string }>;
  truncated: boolean;
};

describe("the Business-wide Page-link graph", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let acl: PgKnowledgeAclRepo;
  let handbook: string;
  let finance: string;
  let caller: string | undefined;
  let author: string;
  let outsider: string;

  async function addMember(name: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now())`,
      [id, `${name}-${randomUUID()}@example.com`, name]
    );
    return id;
  }

  async function writePage(spaceId: string, path: string, content: string): Promise<string> {
    const res = await service.writePage({ spaceId, path, content });
    if (!res.ok || !("page" in res)) throw new Error(`write failed: ${JSON.stringify(res)}`);
    return res.page._id;
  }

  async function restrictToAuthor(pageId: string): Promise<void> {
    await acl.remove(DEPLOYMENT_BUSINESS_ID, "page", pageId, BLANKET_READ_PRINCIPAL);
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind: "page",
      subjectId: pageId,
      principal: { kind: "user", id: author },
      capability: "read",
      effect: "grant",
      origin: "authored",
    });
  }

  async function graph(): Promise<{ status: number; body: Graph }> {
    const res = await app.inject({ method: "GET", url: `${base}/graph` });
    return { status: res.statusCode, body: res.json() as Graph };
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
      retrieval: new PageRetrievalService(db),
      acl,
    });
    for (const name of ["Handbook", "Finance"]) {
      const created = await service.createSpace({ name });
      if (!created.ok) throw new Error("space creation failed");
      if (name === "Handbook") handbook = created.space._id;
      else finance = created.space._id;
    }

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

    author = await addMember("author");
    outsider = await addMember("outsider");
    caller = author;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("spans Spaces: an edge authored in one Space reaches a node in another", async () => {
    const target = await writePage(finance, "budget", "# Budget\n\nNumbers.");
    const source = await writePage(
      handbook,
      "expenses",
      "# Expenses\n\nSee [the budget](tf:page/Finance/budget)."
    );

    const { status, body } = await graph();
    expect(status).toBe(200);
    expect(body.nodes.map((n) => n.id).sort()).toEqual([source, target].sort());
    expect(body.edges).toContainEqual({ sourceId: source, targetId: target });
  });

  it("says which Space each node belongs to, by id and by name", async () => {
    const page = await writePage(finance, "budget", "# Budget\n\nNumbers.");
    const { body } = await graph();
    expect(body.nodes.find((n) => n.id === page)?.spaceId).toBe(finance);
    expect(body.spaces).toContainEqual({ id: finance, name: "Finance" });
  });

  it("gives every node the path a detail route needs, so a node is navigable", async () => {
    const page = await writePage(handbook, "onboarding", "# Onboarding");
    const { body } = await graph();
    expect(body.nodes.find((n) => n.id === page)?.path).toBe("onboarding");
  });

  it("omits a denied Page and every edge that touches it", async () => {
    const secret = await writePage(finance, "secret", `# ${SECRET}\n\nConfidential.`);
    const source = await writePage(
      handbook,
      "expenses",
      "# Expenses\n\nSee [later](tf:page/Finance/secret)."
    );
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/graph` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(secret);
    const body = res.json() as Graph;
    expect(body.nodes.map((n) => n.id)).toEqual([source]);
    expect(body.edges).toEqual([]);
  });

  it("never emits an edge whose endpoints are not both drawn as nodes", async () => {
    const secret = await writePage(finance, "secret", `# ${SECRET}`);
    await writePage(handbook, "a", "# A\n\n[secret](tf:page/Finance/secret) and [[b]].");
    await writePage(handbook, "b", "# B");
    await restrictToAuthor(secret);

    caller = outsider;
    const { body } = await graph();
    const drawn = new Set(body.nodes.map((n) => n.id));
    for (const e of body.edges) {
      expect(drawn.has(e.sourceId)).toBe(true);
      expect(drawn.has(e.targetId)).toBe(true);
    }
  });

  it("hides the denied Space itself, not only its Pages", async () => {
    await writePage(finance, "budget", "# Budget");
    const secretSpace = await service.createSpace({ name: SECRET });
    if (!secretSpace.ok) throw new Error("space creation failed");
    const inside = await writePage(secretSpace.space._id, "plan", "# Plan");
    await restrictToAuthor(inside);

    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/graph` });
    expect(res.body).not.toContain(SECRET);
    expect((res.json() as Graph).spaces.map((s) => s.name)).toEqual(["Finance"]);
  });

  it("returns an internally consistent empty graph rather than an error", async () => {
    caller = outsider;
    const { status, body } = await graph();
    expect(status).toBe(200);
    expect(body).toMatchObject({ nodes: [], edges: [], truncated: false });
  });

  it("draws nothing at all for a caller with no identity", async () => {
    await writePage(handbook, "a", "# A\n\n[[b]].");
    await writePage(handbook, "b", "# B");

    caller = undefined;
    const { status, body } = await graph();
    expect(status).toBe(200);
    expect(body).toMatchObject({ nodes: [], edges: [], spaces: [] });
  });

  it("produces for a restricted reader exactly the graph they would get if the withheld Page had never been written", async () => {
    const source = await writePage(
      handbook,
      "a",
      "# A\n\n[[b]] and [secret](tf:page/Finance/secret)."
    );
    const target = await writePage(handbook, "b", "# B");
    const secret = await writePage(finance, "secret", `# ${SECRET}`);
    await restrictToAuthor(secret);

    caller = outsider;
    const restricted = (await graph()).body;

    // Now actually delete the withheld Page and look again as someone unrestricted.
    await service.deletePage(secret);
    caller = author;
    const withoutIt = (await graph()).body;

    expect(restricted.nodes.map((n) => n.id).sort()).toEqual([source, target].sort());
    expect(restricted).toEqual(withoutIt);
  });
});
