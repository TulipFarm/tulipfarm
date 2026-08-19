/**
 * A malformed Space or Page id must answer "not found", not "internal error".
 *
 * `knowledge_spaces.id` and `knowledge_pages.id` are `uuid` columns, so a path segment that is not
 * a UUID makes Postgres raise `invalid input syntax for type uuid` and the route answer 500. That
 * is a disclosure as well as a bug: 500 is a *different* answer from the 404 a well-formed unknown
 * id gets, so the shape of an id becomes observable, and any future id scheme change silently
 * turns into a crash surface. Every id-addressed route answers absence the same way.
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

/** Shapes that are not UUIDs, including ones that look like an injection probe. */
const MALFORMED = ["not-a-uuid", "123", "%20", "null", "undefined", "1' OR '1'='1"];

describe("an id-addressed Knowledge route answers 404 for a malformed id", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string;
  let spaceId: string;
  let pageId: string;

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

    caller = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now())`,
      [caller, `${caller}@example.test`, caller]
    );
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, caller]
    );

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

    const space = await service.createSpace({ name: "handbook" });
    if (!space.ok) throw new Error("space creation failed");
    spaceId = space.space._id;
    const page = await service.writePage({ spaceId, path: "onboarding", content: "# Hi" });
    if (!page.ok || !("page" in page)) throw new Error("page creation failed");
    pageId = page.page._id;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const readRoutes = [
    (id: string) => `${base}/spaces/${id}`,
    (id: string) => `${base}/spaces/${id}/pages`,
    (id: string) => `${base}/spaces/${id}/navigate`,
    (id: string) => `${base}/spaces/${id}/graph`,
    (id: string) => `${base}/pages/${id}`,
    (id: string) => `${base}/pages/${id}/backlinks`,
    (id: string) => `${base}/pages/${id}/revisions`,
  ];

  for (const make of readRoutes) {
    const shape = make(":id").replace(base, "");
    it(`GET ${shape} never answers 5xx`, async () => {
      for (const bad of MALFORMED) {
        const res = await app.inject({ method: "GET", url: make(encodeURIComponent(bad)) });
        expect({ bad, code: res.statusCode }).toEqual({ bad, code: 404 });
      }
    });
  }

  it("DELETE /spaces/:id and /pages/:id answer 404 for a malformed id", async () => {
    for (const bad of MALFORMED) {
      const s = await app.inject({
        method: "DELETE",
        url: `${base}/spaces/${encodeURIComponent(bad)}`,
      });
      expect({ bad, code: s.statusCode }).toEqual({ bad, code: 404 });
      const p = await app.inject({
        method: "DELETE",
        url: `${base}/pages/${encodeURIComponent(bad)}`,
      });
      expect({ bad, code: p.statusCode }).toEqual({ bad, code: 404 });
    }
  });

  it("PUT /spaces/:id and /pages/:id answer 404 for a malformed id", async () => {
    for (const bad of MALFORMED) {
      const s = await app.inject({
        method: "PUT",
        url: `${base}/spaces/${encodeURIComponent(bad)}`,
        payload: { name: "renamed" },
      });
      expect({ bad, code: s.statusCode }).toEqual({ bad, code: 404 });
      const p = await app.inject({
        method: "PUT",
        url: `${base}/pages/${encodeURIComponent(bad)}`,
        // `If-Match` is a precondition checked ahead of the id, and its 400 is the same for every
        // id, so it has to be satisfied before this route can say anything about the id at all.
        headers: { "if-match": '"1"' },
        payload: { content: "# nope" },
      });
      expect({ bad, code: p.statusCode }).toEqual({ bad, code: 404 });
    }
  });

  it("POST /spaces/:id/pages answers 404 for a malformed Space id", async () => {
    for (const bad of MALFORMED) {
      const res = await app.inject({
        method: "POST",
        url: `${base}/spaces/${encodeURIComponent(bad)}/pages`,
        payload: { path: "sneaky", content: "# nope" },
      });
      expect({ bad, code: res.statusCode }).toEqual({ bad, code: 404 });
    }
  });

  it("PUT /spaces/:id/restriction and /pages/:id/restriction answer 404 for a malformed id", async () => {
    for (const bad of MALFORMED) {
      const s = await app.inject({
        method: "PUT",
        url: `${base}/spaces/${encodeURIComponent(bad)}/restriction`,
        payload: { subjects: [{ kind: "user", id: caller }] },
      });
      expect({ bad, code: s.statusCode }).toEqual({ bad, code: 404 });
      const p = await app.inject({
        method: "PUT",
        url: `${base}/pages/${encodeURIComponent(bad)}/restriction`,
        payload: { subjects: [{ kind: "user", id: caller }] },
      });
      expect({ bad, code: p.statusCode }).toEqual({ bad, code: 404 });
    }
  });

  // The control: the fix must not turn well-formed ids into 404s.
  it("still serves the real Space and Page", async () => {
    const s = await app.inject({ method: "GET", url: `${base}/spaces/${spaceId}` });
    expect(s.statusCode).toBe(200);
    const p = await app.inject({ method: "GET", url: `${base}/pages/${pageId}` });
    expect(p.statusCode).toBe(200);
  });

  // A well-formed id that names nothing and a malformed one must be indistinguishable, or the
  // caller learns which id shapes this deployment uses.
  it("answers a malformed id exactly as it answers an absent one", async () => {
    const absent = await app.inject({ method: "GET", url: `${base}/spaces/${randomUUID()}` });
    const malformed = await app.inject({ method: "GET", url: `${base}/spaces/not-a-uuid` });

    expect(malformed.statusCode).toBe(absent.statusCode);
    expect(malformed.body).toBe(absent.body);
  });
});
