import { noEmbeddings } from "./test-support";
/**
 * Ticket 18 — every Page-disclosing surface obeys the gate.
 *
 * Reading a Page directly is one disclosure; search, mentions, backlinks, the link graph, the
 * navigate index, revisions, and the overview are seven more. Each asserts the same property from a
 * different angle: a Page the caller cannot read produces *no object at all* — not a placeholder,
 * not a redacted title, not a gap in a page of results. A title is usually the whole secret.
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
/** The string that must never reach an excluded reader, on any surface. */
const SECRET = "Q3-layoffs-engineering";

describe("every derived Knowledge surface obeys the gate", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let acl: PgKnowledgeAclRepo;
  let spaceId: string;
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

  async function writePage(path: string, content: string): Promise<string> {
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

  const get = (url: string) => app.inject({ method: "GET", url });

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

  it("keeps a denied Page out of search results", async () => {
    await writePage("public", "# Onboarding\n\nGeneral guidance.");
    const secret = await writePage("secret", `# ${SECRET}\n\nConfidential plans.`);
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "layoffs", granularity: "page" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(secret);
  });

  it("keeps a denied Page out of the @-mention picker", async () => {
    const secret = await writePage("secret", `# ${SECRET}\n\nConfidential.`);
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await get(`${base}/pages/mentions`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(secret);
  });

  it("keeps a denied Page out of the paginated Page list", async () => {
    const secret = await writePage("secret", `# ${SECRET}`);
    await writePage("public", "# Onboarding");
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await get(`${base}/pages`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(secret);
  });

  it("fills a page of results as if the denied Pages never existed", async () => {
    // Four readable Pages with a denied one interleaved. Asking for two must yield two, not one:
    // a short page would itself disclose that something was removed.
    const ids: string[] = [];
    for (const name of ["alpha", "bravo", "charlie", "delta"]) {
      ids.push(await writePage(name, `# ${name}`));
    }
    const secret = await writePage("secret", `# ${SECRET}`);
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await get(`${base}/pages?limit=2`);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
    expect(res.body).not.toContain(SECRET);
  });

  it("denies a denied Page's revision history", async () => {
    const secret = await writePage("secret", `# ${SECRET}\n\nv1`);
    await writePage("secret", `# ${SECRET}\n\nv2`);
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await get(`${base}/pages/${secret}/revisions`);

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(SECRET);
  });

  it("keeps a denied Page out of the navigate index", async () => {
    await writePage("public", "# Onboarding\n\nGeneral guidance.");
    const secret = await writePage("secret", `# ${SECRET}\n\nConfidential.`);
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await get(`${base}/spaces/${spaceId}/navigate`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(secret);
    // The readable Page is still listed — the filter removes the withheld entry, not the index.
    expect(res.json().listing).toContain("public");
    expect(res.json().listing).not.toContain("secret");
  });

  it("keeps a denied Page out of the link graph, and drops every edge touching it", async () => {
    // `public` links to `secret`, so the edge alone would betray that `secret` exists.
    const secret = await writePage("secret", `# ${SECRET}\n\nConfidential.`);
    await writePage("public", "# Onboarding\n\nSee [secret](/secret.md).");
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await get(`${base}/spaces/${spaceId}/graph`);

    expect(res.statusCode).toBe(200);
    const graph = res.json() as {
      nodes: Array<{ id: string }>;
      edges: Array<{ targetId: string | null; targetPath: string }>;
    };
    expect(graph.nodes.map((n) => n.id)).not.toContain(secret);
    expect(graph.edges.some((e) => e.targetId === secret)).toBe(false);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(secret);
  });

  it("keeps a denied Page out of backlinks", async () => {
    const target = await writePage("target", "# Target\n\nLinked from elsewhere.");
    const secret = await writePage("secret", `# ${SECRET}\n\nSee [target](/target.md).`);
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await get(`${base}/pages/${target}/backlinks`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(secret);
  });

  it("keeps a denied Page out of the overview's recent list", async () => {
    await writePage("public", "# Onboarding");
    const secret = await writePage("secret", `# ${SECRET}`);
    await restrictToAuthor(secret);

    caller = outsider;
    const res = await get(`${base}/overview`);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(secret);
  });

  it("changes nothing on any surface while nothing is restricted", async () => {
    const pageId = await writePage("public", "# Onboarding\n\nGeneral guidance.");
    const target = await writePage("target", "# Target\n\nSee [public](/public.md).");

    const surfaces = [
      `${base}/pages`,
      `${base}/pages/mentions`,
      `${base}/pages/${pageId}`,
      `${base}/pages/${pageId}/revisions`,
      `${base}/pages/${target}/backlinks`,
      `${base}/spaces/${spaceId}/pages`,
      `${base}/spaces/${spaceId}/navigate`,
      `${base}/spaces/${spaceId}/graph`,
      `${base}/overview`,
    ];

    caller = author;
    const asAuthor = await Promise.all(surfaces.map(get));
    caller = outsider;
    const asColleague = await Promise.all(surfaces.map(get));

    // Every Page carries the blanket grant, so two different members must see byte-identical
    // output. This is what makes the gate provably inert before restriction exists.
    for (const [i, url] of surfaces.entries()) {
      expect(asAuthor[i]?.statusCode, url).toBe(200);
      expect(asColleague[i]?.body, url).toBe(asAuthor[i]?.body);
    }
  });
});
