import { noEmbeddings } from "./test-support";
/**
 * Ticket 17 at the HTTP boundary.
 *
 * `page-access.pg.test.ts` proves the gate decides correctly. This proves the routes actually ask
 * it, and that a denial is indistinguishable from a Page that was never written — same status, same
 * body, no title, no path, no identifier.
 */

import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID, ROUTINE_SERVICE_PRINCIPAL_ID } from "@tulipfarm/constants";
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

const base = "/api/v1/knowledge";

describe("authored Page routes consult the gate", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let acl: PgKnowledgeAclRepo;
  let spaceId: string;

  /** Whoever the next request is from. `undefined` means an unauthenticated caller. */
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

  /** Replaces the blanket grant with an allowlist — what ticket 19 will do from the UI. */
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
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("lets a member read a Page a different member authored", async () => {
    const author = await addMember("author");
    const colleague = await addMember("colleague");
    caller = author;
    const pageId = await writePage("onboarding", "# Onboarding\n\nStart here.");

    caller = colleague;
    const res = await app.inject({ method: "GET", url: `${base}/pages/${pageId}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: pageId });
  });

  it("shows a member the Pages another member authored when listing a Space", async () => {
    const author = await addMember("author");
    const colleague = await addMember("colleague");
    caller = author;
    await writePage("onboarding", "# Onboarding");
    await writePage("payroll", "# Payroll");

    caller = colleague;
    const res = await app.inject({ method: "GET", url: `${base}/spaces/${spaceId}/pages` });

    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .items.map((p: { path: string }) => p.path)
        .sort()
    ).toEqual(["onboarding", "payroll"]);
  });

  it("denies a caller carrying no Principals", async () => {
    const author = await addMember("author");
    caller = author;
    const pageId = await writePage("onboarding", "# Onboarding");

    caller = undefined;
    const res = await app.inject({ method: "GET", url: `${base}/pages/${pageId}` });

    expect(res.statusCode).toBe(404);
  });

  it("denies an identity that is not a member of the Business", async () => {
    const author = await addMember("author");
    caller = author;
    const pageId = await writePage("onboarding", "# Onboarding");

    // No `users` row backs it, and it is not the Routine executor, so it holds no blanket
    // Principal — denial is structural, not a filter.
    caller = `unknown-${randomUUID()}`;
    const res = await app.inject({ method: "GET", url: `${base}/pages/${pageId}` });

    expect(res.statusCode).toBe(404);
  });

  it("lets a Routine read an unrestricted Page, and still withholds a restricted one", async () => {
    const author = await addMember("author");
    caller = author;
    const open = await writePage("onboarding", "# Onboarding");
    const closed = await writePage("layoffs", "# Q3 layoffs");
    await restrictTo(closed, author);

    caller = ROUTINE_SERVICE_PRINCIPAL_ID;
    const readable = await app.inject({ method: "GET", url: `${base}/pages/${open}` });
    const withheld = await app.inject({ method: "GET", url: `${base}/pages/${closed}` });

    expect(readable.statusCode).toBe(200);
    expect(withheld.statusCode).toBe(404);
  });

  it("answers a denied Page exactly as it answers one that was never written", async () => {
    const author = await addMember("author");
    const outsider = await addMember("outsider");
    caller = author;
    const pageId = await writePage("layoffs", "# Q3 layoffs — engineering\n\nConfidential.");
    await restrictTo(pageId, author);

    caller = outsider;
    const denied = await app.inject({ method: "GET", url: `${base}/pages/${pageId}` });
    const absent = await app.inject({ method: "GET", url: `${base}/pages/${randomUUID()}` });

    expect(denied.statusCode).toBe(absent.statusCode);
    expect(denied.body).toBe(absent.body);
    expect(denied.body).not.toContain("layoffs");
    expect(denied.body).not.toContain(pageId);
  });

  it("omits a denied Page from a Space listing without a gap or placeholder", async () => {
    const author = await addMember("author");
    const outsider = await addMember("outsider");
    caller = author;
    await writePage("onboarding", "# Onboarding");
    const secret = await writePage("layoffs", "# Q3 layoffs — engineering");
    await restrictTo(secret, author);

    caller = outsider;
    const res = await app.inject({ method: "GET", url: `${base}/spaces/${spaceId}/pages` });

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ path: string }>;
    expect(items.map((p) => p.path)).toEqual(["onboarding"]);
    expect(res.body).not.toContain("layoffs");
    expect(res.body).not.toContain(secret);
  });

  it("records the blanket grant on create so a colleague reads without any explicit share", async () => {
    const author = await addMember("author");
    caller = author;
    const pageId = await writePage("onboarding", "# Onboarding");

    const entries = await acl.listForSubject(DEPLOYMENT_BUSINESS_ID, "page", pageId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      principal: BLANKET_READ_PRINCIPAL,
      capability: "read",
      effect: "grant",
    });

    // The gate reads the Page's access revision into the subject it authorizes. A null here would
    // make every decision fall over, so the column's default is load-bearing, not incidental.
    const { rows } = await db.query<{ acl_revision: string | null }>(
      `SELECT acl_revision FROM knowledge_pages WHERE id = $1`,
      [pageId]
    );
    expect(rows[0]?.acl_revision).toEqual(expect.any(String));
  });
});
