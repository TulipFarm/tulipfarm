import { noEmbeddings } from "./test-support";
/**
 * A person weighs a document differently depending on whether a colleague wrote it or an Agent
 * generated it. That judgement is only possible if the Page records which — so authorship is a
 * stored fact, captured on every write, not inferred at render time.
 *
 * The label must travel with the Page wherever it is listed, so this pins it on every listing
 * surface, not just the Page itself.
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

describe("a Page records who authored it", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let human: string;
  let spaceId: string;

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

    human = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', 'Human', 'member', 'active', now())`,
      [human, `${human}@example.test`]
    );
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, human]
    );

    app = Fastify();
    registerKnowledgeRoutes(
      app,
      service,
      async (req) => {
        req.user = {
          _id: human,
          email: "u@example.com",
          passwordHash: "x",
          name: null,
          role: "member",
          status: "active" as const,
          createdAt: new Date(),
        };
        req.principal = {
          id: human,
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

  it("attributes a Page written through the interface to the signed-in person", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base}/spaces/${spaceId}/pages`,
      payload: { path: "notes/one", content: "# One" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().authorKind).toBe("user");
    expect(res.json().authorId).toBe(human);
  });

  it("attributes a Page written by an Agent to that Agent", async () => {
    await service.writePage({
      spaceId,
      path: "notes/auto",
      content: "# Auto",
      author: { kind: "agent", id: "agent-scribe" },
    });

    const listed = await app.inject({ method: "GET", url: `${base}/spaces/${spaceId}/pages` });
    const page = listed.json().items.find((p: { path: string }) => p.path === "notes/auto");
    expect(page.authorKind).toBe("agent");
    expect(page.authorId).toBe("agent-scribe");
  });

  it("carries the label into the flat listing the tree resolves against", async () => {
    await service.writePage({
      spaceId,
      path: "notes/auto",
      content: "# Auto",
      author: { kind: "agent", id: "agent-scribe" },
    });
    await service.writePage({
      spaceId,
      path: "notes/hand",
      content: "# Hand",
      author: { kind: "user", id: human },
    });

    const res = await app.inject({ method: "GET", url: `${base}/pages/mentions` });

    expect(res.statusCode).toBe(200);
    const byPath = new Map(
      res.json().items.map((e: { path: string; authorKind?: string }) => [e.path, e.authorKind])
    );
    expect(byPath.get("notes/auto")).toBe("agent");
    expect(byPath.get("notes/hand")).toBe("user");
  });

  it("records the author that most recently wrote it", async () => {
    await service.writePage({
      spaceId,
      path: "notes/one",
      content: "# One",
      author: { kind: "agent", id: "agent-scribe" },
    });
    await service.writePage({
      spaceId,
      path: "notes/one",
      content: "# One, corrected",
      author: { kind: "user", id: human },
    });

    const listed = await app.inject({ method: "GET", url: `${base}/spaces/${spaceId}/pages` });
    const page = listed.json().items.find((p: { path: string }) => p.path === "notes/one");
    expect(page.authorKind).toBe("user");
  });

  it("leaves a Page written before authorship was recorded unlabelled rather than guessing", async () => {
    await service.writePage({ spaceId, path: "notes/legacy", content: "# Legacy" });
    await db.query(
      `UPDATE knowledge_pages SET author_kind = NULL, author_id = NULL WHERE path = 'notes/legacy'`
    );

    const listed = await app.inject({ method: "GET", url: `${base}/spaces/${spaceId}/pages` });
    const page = listed.json().items.find((p: { path: string }) => p.path === "notes/legacy");
    expect(page.authorKind).toBeNull();
  });

  it("refuses to navigate a Space the caller cannot read", async () => {
    const other = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', 'Other', 'member', 'active', now())`,
      [other, `${other}@example.test`]
    );
    await app.inject({
      method: "PUT",
      url: `${base}/spaces/${spaceId}/restriction`,
      payload: { subjects: [{ kind: "user", id: other }] },
    });

    const res = await app.inject({
      method: "GET",
      url: `${base}/spaces/${spaceId}/navigate?dirPath=`,
    });
    expect(res.statusCode).toBe(404);
  });
});
