/**
 * The Page read view — the screen the product is actually used on.
 *
 * Two things are pinned here. First, attribution: a reader needs to know *who* last changed a Page
 * to judge whether to trust it, and a raw principal id does not answer that. Second, that a denial
 * is indistinguishable from an absence — a distinct "you may not read this" answer confirms the
 * Page is real and turns URL guessing into an enumeration tool.
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
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRequireAuthorization } from "../authz/route-gate";
import { makeMigratedPglite } from "../test/pglite";
import { AuthorLabeller } from "./author-label";
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

describe("Page read view", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string;
  let author: string;
  let spaceId: string;

  async function addUser(name: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now())`,
      [id, `${id}@example.test`, name]
    );
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, id]
    );
    return id;
  }

  async function writePage(path: string, content: string, by?: string): Promise<string> {
    const r = await service.writePage({
      spaceId,
      path,
      content,
      author: by ? { kind: "user", id: by } : undefined,
    });
    if (!r.ok || !("page" in r)) throw new Error(`write failed: ${path}`);
    return r.page._id;
  }

  async function restrictPage(pageId: string, subjects: Array<{ kind: string; id: string }>) {
    const res = await app.inject({
      method: "PUT",
      url: `${base}/pages/${pageId}/restriction`,
      payload: { subjects },
    });
    if (res.statusCode !== 200) throw new Error(`restrict failed: ${res.body}`);
  }

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

    caller = await addUser("Caller");
    author = await addUser("Dana Okonkwo");

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
      new PageRetrievalService(db),
      undefined,
      new AuthorLabeller(db)
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

  it("names the person who last changed it, not their principal id", async () => {
    const id = await writePage("notes/one", "# One", author);

    const res = await app.inject({ method: "GET", url: `${base}/pages/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorLabel).toBe("Dana Okonkwo");
  });

  it("falls back to the editor's email when they have no name", async () => {
    const nameless = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, 'quiet@example.test', 'x', NULL, 'member', 'active', now())`,
      [nameless]
    );
    const id = await writePage("notes/two", "# Two", nameless);

    const res = await app.inject({ method: "GET", url: `${base}/pages/${id}` });
    expect(res.json().authorLabel).toBe("quiet@example.test");
  });

  it("says nothing about the author of a Page written before authorship was recorded", async () => {
    const id = await writePage("notes/old", "# Old");
    await db.query(
      "UPDATE knowledge_pages SET author_kind = NULL, author_id = NULL WHERE id = $1",
      [id]
    );

    const res = await app.inject({ method: "GET", url: `${base}/pages/${id}` });
    expect(res.json().authorKind).toBeNull();
    expect(res.json().authorLabel).toBeNull();
  });

  it("marks an Agent-written Page without inventing a person for it", async () => {
    const r = await service.writePage({
      spaceId,
      path: "notes/auto",
      content: "# Auto",
      author: { kind: "agent", id: "agent-scribe" },
    });
    if (!r.ok || !("page" in r)) throw new Error("write failed");

    const res = await app.inject({ method: "GET", url: `${base}/pages/${r.page._id}` });
    expect(res.json().authorKind).toBe("agent");
    expect(res.json().authorLabel).toBe("agent-scribe");
  });

  it("does not turn attribution into a user directory for Pages the caller cannot read", async () => {
    const secret = await writePage("comp/bands", "# Bands", author);
    await restrictPage(secret, [{ kind: "user", id: author }]);

    const res = await app.inject({ method: "GET", url: `${base}/pages/${secret}` });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("Dana Okonkwo");
  });

  it("answers a denied Page exactly as it answers one that never existed", async () => {
    const secret = await writePage("comp/exec", "# Exec", author);
    await restrictPage(secret, [{ kind: "user", id: author }]);

    const denied = await app.inject({ method: "GET", url: `${base}/pages/${secret}` });
    const absent = await app.inject({ method: "GET", url: `${base}/pages/${randomUUID()}` });

    expect(denied.statusCode).toBe(absent.statusCode);
    expect(denied.body).toBe(absent.body);
  });

  it("answers the revision history of a denied Page as it answers an absent one", async () => {
    const secret = await writePage("comp/raise", "# Raise", author);
    await restrictPage(secret, [{ kind: "user", id: author }]);

    const denied = await app.inject({ method: "GET", url: `${base}/pages/${secret}/revisions` });
    const absent = await app.inject({
      method: "GET",
      url: `${base}/pages/${randomUUID()}/revisions`,
    });

    expect(denied.statusCode).toBe(absent.statusCode);
    expect(denied.body).toBe(absent.body);
  });

  it("omits an unreadable Page from backlinks, and reports no count for what it omitted", async () => {
    const target = await writePage("policies/leave", "# Leave");
    const link = "[leave](tf:page/handbook/policies/leave)";
    const openLinker = await writePage("policies/open", `See ${link}`);
    const secretLinker = await writePage("comp/secret", `Codeword ORCHIDBANK ${link}`);
    await restrictPage(secretLinker, [{ kind: "user", id: author }]);

    const res = await app.inject({ method: "GET", url: `${base}/pages/${target}/backlinks` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].sourceId).toBe(openLinker);
    expect(res.body).not.toContain(secretLinker);
    expect(res.body).not.toContain("ORCHIDBANK");
    expect(JSON.stringify(body)).not.toMatch(/hidden|omitted|withheld/i);
  });
});
