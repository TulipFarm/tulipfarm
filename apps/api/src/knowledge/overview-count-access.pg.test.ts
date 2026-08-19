/**
 * A readable Space must not report the Pages inside it that the viewer cannot read.
 *
 * Restricting a Page closes the Page, but the Knowledge home still summarised it: `pageCount` was a
 * `COUNT(*)` over every active Page in the Space, and `lastActivity` was a `MAX(updated_at)` over
 * the same rows. So an outsider inside an open Space could still see that the Space holds four
 * Pages when they can read three, and watch the timestamp move whenever the hidden one was edited.
 * A count and a clock are a slow channel, but they are a channel: they answer "is there something
 * here I am not being shown, and is someone working on it right now".
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

interface OverviewSpace {
  id: string;
  pageCount: number;
  lastActivity: string;
}

describe("the Knowledge overview counts only Pages the viewer may read", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string;
  let insider: string;
  let outsider: string;
  let spaceId: string;
  let secretPageId: string;

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

  async function overviewSpace(): Promise<OverviewSpace | undefined> {
    const res = await app.inject({ method: "GET", url: `${base}/overview` });
    expect(res.statusCode).toBe(200);
    return (res.json().spaces as OverviewSpace[]).find((s) => s.id === spaceId);
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

    // The Space itself stays open: this is about a Page-level restriction inside a Space the
    // outsider is legitimately in, which is the case the Space-level filter never sees.
    const space = await service.createSpace({ name: "handbook" });
    if (!space.ok) throw new Error("space creation failed");
    spaceId = space.space._id;

    for (const path of ["onboarding", "expenses", "travel"]) {
      const p = await service.writePage({ spaceId, path, content: `# ${path}` });
      if (!p.ok) throw new Error("page creation failed");
    }
    const secret = await service.writePage({
      spaceId,
      path: "ORCHIDBANK-layoffs",
      content: "# Layoffs",
    });
    if (!secret.ok || !("page" in secret)) throw new Error("page creation failed");
    secretPageId = secret.page._id;

    const restricted = await app.inject({
      method: "PUT",
      url: `${base}/pages/${secretPageId}/restriction`,
      payload: { subjects: [{ kind: "user", id: insider }] },
    });
    expect(restricted.statusCode).toBeLessThan(300);
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("excludes a restricted Page from pageCount", async () => {
    caller = outsider;
    expect((await overviewSpace())?.pageCount).toBe(3);
  });

  it("still counts it for someone who may read it", async () => {
    caller = insider;
    expect((await overviewSpace())?.pageCount).toBe(4);
  });

  it("does not move lastActivity when a restricted Page is edited", async () => {
    caller = outsider;
    const before = await overviewSpace();

    caller = insider;
    const edited = await app.inject({
      method: "POST",
      url: `${base}/spaces/${spaceId}/pages`,
      payload: { path: "ORCHIDBANK-layoffs", content: "# Layoffs, revised" },
    });
    expect(edited.statusCode).toBeLessThan(300);

    caller = outsider;
    const after = await overviewSpace();
    expect(after?.lastActivity).toBe(before?.lastActivity);
    // The control: the insider, who may read it, does see the clock move.
    caller = insider;
    expect((await overviewSpace())?.lastActivity).not.toBe(before?.lastActivity);
  });

  it("moves lastActivity for the outsider when a readable Page is edited", async () => {
    caller = outsider;
    const before = await overviewSpace();

    caller = insider;
    const edited = await app.inject({
      method: "POST",
      url: `${base}/spaces/${spaceId}/pages`,
      payload: { path: "travel", content: "# travel, revised" },
    });
    expect(edited.statusCode).toBeLessThan(300);

    caller = outsider;
    expect((await overviewSpace())?.lastActivity).not.toBe(before?.lastActivity);
  });

  it("never names the restricted Page in the overview body", async () => {
    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/overview` });

    expect(res.body).not.toContain("ORCHIDBANK");
    expect(res.body).not.toContain(secretPageId);
  });

  // Default-deny: a Space whose every Page is restricted still exists for a member, but it must
  // report nothing about its contents.
  it("reports zero for a Space whose only Pages are all restricted", async () => {
    caller = insider;
    const closed = await service.createSpace({ name: "board" });
    if (!closed.ok) throw new Error("space creation failed");
    const page = await service.writePage({
      spaceId: closed.space._id,
      path: "minutes",
      content: "# Minutes",
    });
    if (!page.ok || !("page" in page)) throw new Error("page creation failed");
    await app.inject({
      method: "PUT",
      url: `${base}/pages/${page.page._id}/restriction`,
      payload: { subjects: [{ kind: "user", id: insider }] },
    });

    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/overview` });
    const board = (res.json().spaces as OverviewSpace[]).find((s) => s.id === closed.space._id);
    expect(board?.pageCount).toBe(0);
  });
});
