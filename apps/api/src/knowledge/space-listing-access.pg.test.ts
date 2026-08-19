/**
 * A restricted Space must not appear in a listing.
 *
 * Ticket 20 gave a Space an allowlist and the gate a `canReadSpace`, but nothing consulted it when
 * *listing* Spaces — so restricting a Space closed its Pages while leaving its name, page count and
 * last-activity timestamp on the Knowledge home for everyone. The name alone is the disclosure:
 * "layoffs-2026" tells the reader what they were not supposed to know.
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

describe("a Space the viewer cannot read does not appear in any listing", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string;
  let openSpace: string;
  let secretSpace: string;
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

    insider = await addMember();
    outsider = await addMember();
    caller = insider;

    const a = await service.createSpace({ name: "handbook" });
    const b = await service.createSpace({ name: "ORCHIDBANK-layoffs" });
    if (!a.ok || !b.ok) throw new Error("space creation failed");
    openSpace = a.space._id;
    secretSpace = b.space._id;

    await service.writePage({ spaceId: secretSpace, path: "plan", content: "# Plan" });
    await app.inject({
      method: "PUT",
      url: `${base}/spaces/${secretSpace}/restriction`,
      payload: { subjects: [{ kind: "user", id: insider }] },
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("omits it from GET /spaces", async () => {
    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/spaces` });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((s: { id: string }) => s.id)).toEqual([openSpace]);
    expect(res.body).not.toContain("ORCHIDBANK");
  });

  it("omits it from the Knowledge overview", async () => {
    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/overview` });

    expect(res.statusCode).toBe(200);
    expect(res.json().spaces.map((s: { id: string }) => s.id)).toEqual([openSpace]);
    // Page count and last-activity are disclosures too, not just the name.
    expect(res.body).not.toContain("ORCHIDBANK");
  });

  it("answers 404 for GET /spaces/:id", async () => {
    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/spaces/${secretSpace}` });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("ORCHIDBANK");
  });

  it("still shows it to a member on the allowlist", async () => {
    caller = insider;
    const list = await app.inject({ method: "GET", url: `${base}/spaces` });
    const overview = await app.inject({ method: "GET", url: `${base}/overview` });
    const one = await app.inject({ method: "GET", url: `${base}/spaces/${secretSpace}` });

    expect(
      list
        .json()
        .items.map((s: { id: string }) => s.id)
        .sort()
    ).toEqual([openSpace, secretSpace].sort());
    expect(overview.json().spaces).toHaveLength(2);
    expect(one.statusCode).toBe(200);
  });

  it("leaves an unrestricted Space visible to everyone", async () => {
    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/spaces/${openSpace}` });
    expect(res.statusCode).toBe(200);
  });

  it("refuses to rename or delete a Space the caller cannot read", async () => {
    caller = outsider;
    const renamed = await app.inject({
      method: "PUT",
      url: `${base}/spaces/${secretSpace}`,
      payload: { name: "renamed" },
    });
    const deleted = await app.inject({ method: "DELETE", url: `${base}/spaces/${secretSpace}` });

    expect(renamed.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(404);
    caller = insider;
    expect(
      (await app.inject({ method: "GET", url: `${base}/spaces/${secretSpace}` })).json().name
    ).toBe("ORCHIDBANK-layoffs");
  });

  it("omits its Pages from the Space's page listing", async () => {
    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/spaces/${secretSpace}/pages` });
    expect(res.statusCode).toBe(404);
  });
});
