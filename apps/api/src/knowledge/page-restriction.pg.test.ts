/**
 * Restricting a Page to an allowlist.
 *
 * Restriction *replaces* the Business-wide grant rather than adding exceptions on top of it, so the
 * subject list a Page reports is the complete reader list. There is no state in which a Page reads
 * as open while quietly excluding people.
 *
 * It is its own sub-resource, not a field on the Page body: changing who may read something is a
 * distinct action from editing what it says, so it cannot happen by accident while saving content.
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

describe("Page restriction", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let caller: string | undefined;
  let spaceId: string;

  async function addMember(role: "member" | "admin" = "member"): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, $4, 'active', now())`,
      [id, `${id}@example.test`, id, role]
    );
    // Roles are seeded from `users` at migration time; a user added afterwards needs its own row.
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, id, role]
    );
    return id;
  }

  async function addTeam(name: string): Promise<string> {
    await db.query(
      `INSERT INTO principal_groups (business_id, id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, name]
    );
    return name;
  }

  async function joinTeam(teamId: string, userId: string, expiresAt?: Date): Promise<void> {
    await db.query(
      `INSERT INTO principal_group_members (business_id, group_id, principal_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [DEPLOYMENT_BUSINESS_ID, teamId, userId, expiresAt ?? null]
    );
  }

  async function writePage(path: string, content: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `${base}/spaces/${spaceId}/pages`,
      payload: { path, content },
    });
    if (res.statusCode >= 300) throw new Error(`write failed: ${res.statusCode} ${res.body}`);
    return res.json().id as string;
  }

  const getPage = (pageId: string) => app.inject({ method: "GET", url: `${base}/pages/${pageId}` });

  const restrict = (pageId: string, subjects: { kind: string; id: string }[]) =>
    app.inject({
      method: "PUT",
      url: `${base}/pages/${pageId}/restriction`,
      payload: { subjects },
    });

  const readRestriction = (pageId: string) =>
    app.inject({ method: "GET", url: `${base}/pages/${pageId}/restriction` });

  const unrestrict = (pageId: string) =>
    app.inject({ method: "DELETE", url: `${base}/pages/${pageId}/restriction` });

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const acl = new PgKnowledgeAclRepo(db);
    const service = new KnowledgeService({
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

    caller = await addMember();
    const created = await service.createSpace({ name: "ops" });
    if (!created.ok) throw new Error("space creation failed");
    spaceId = created.space._id;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("replaces the blanket grant with one grant per named subject", async () => {
    const author = caller as string;
    const pageId = await writePage("hr/layoffs", "# Layoffs");

    expect((await restrict(pageId, [{ kind: "user", id: author }])).statusCode).toBe(200);

    const entries = await db.query<{
      principal_kind: string;
      principal_id: string;
      effect: string;
    }>(
      `SELECT principal_kind, principal_id, effect FROM knowledge_acl_entries
       WHERE subject_kind = 'page' AND subject_id = $1`,
      [pageId]
    );
    expect(entries.rows).toEqual([
      { principal_kind: "user", principal_id: author, effect: "grant" },
    ]);
  });

  it("denies a member outside the list, and serves one inside it", async () => {
    const author = caller as string;
    const outsider = await addMember();
    const pageId = await writePage("hr/layoffs", "# Layoffs");
    await restrict(pageId, [{ kind: "user", id: author }]);

    caller = outsider;
    expect((await getPage(pageId)).statusCode).toBe(404);
    caller = author;
    expect((await getPage(pageId)).statusCode).toBe(200);
  });

  it("hides a restricted Page from every derived surface", async () => {
    const author = caller as string;
    const outsider = await addMember();
    const pageId = await writePage("hr/severance", "# Q3 severance plan\n\nCodeword ORCHIDBANK.");
    await restrict(pageId, [{ kind: "user", id: author }]);

    caller = outsider;
    const surfaces = [
      `${base}/pages`,
      `${base}/pages/mentions?q=severance`,
      `${base}/spaces/${spaceId}/navigate`,
      `${base}/spaces/${spaceId}/graph`,
      `${base}/overview`,
    ];
    const search = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "severance" },
    });
    expect(search.statusCode).toBe(200);
    expect(search.body).not.toContain(pageId);
    expect(search.body).not.toContain("ORCHIDBANK");

    for (const url of surfaces) {
      const res = await app.inject({ method: "GET", url });
      // A 404 would pass the leak assertions vacuously; pin that each surface is actually served.
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(pageId);
      expect(res.body, url).not.toContain("ORCHIDBANK");
      expect(res.body, url).not.toContain("severance plan");
    }
  });

  it("serves a Page to a member of a Team in the list, and stops when they leave", async () => {
    const author = caller as string;
    const teammate = await addMember();
    const team = await addTeam("finance");
    await joinTeam(team, teammate);
    const pageId = await writePage("hr/comp", "# Comp bands");
    await restrict(pageId, [{ kind: "group", id: team }]);

    caller = teammate;
    expect((await getPage(pageId)).statusCode).toBe(200);

    await db.query(
      `DELETE FROM principal_group_members WHERE group_id = $1 AND principal_id = $2`,
      [team, teammate]
    );
    expect((await getPage(pageId)).statusCode).toBe(404);
    expect(author).toBeDefined();
  });

  it("stops serving when a Team membership expires, with no intervening job", async () => {
    const teammate = await addMember();
    const team = await addTeam("finance");
    await joinTeam(team, teammate, new Date(Date.now() - 60_000));
    const pageId = await writePage("hr/comp", "# Comp bands");
    await restrict(pageId, [{ kind: "group", id: team }]);

    caller = teammate;
    expect((await getPage(pageId)).statusCode).toBe(404);
  });

  it("serves a Page to a Role holder, and stops when the Role is removed", async () => {
    const admin = await addMember("admin");
    const pageId = await writePage("hr/comp", "# Comp bands");
    await restrict(pageId, [{ kind: "role", id: "admin" }]);

    caller = admin;
    expect((await getPage(pageId)).statusCode).toBe(200);

    await db.query(`DELETE FROM role_assignments WHERE principal_id = $1 AND role_id = 'admin'`, [
      admin,
    ]);
    expect((await getPage(pageId)).statusCode).toBe(404);
  });

  it("reports exactly the subjects that can read the Page", async () => {
    const author = caller as string;
    const team = await addTeam("finance");
    const pageId = await writePage("hr/comp", "# Comp bands");
    await restrict(pageId, [
      { kind: "user", id: author },
      { kind: "group", id: team },
      { kind: "role", id: "admin" },
    ]);

    const res = await readRestriction(pageId);
    expect(res.statusCode).toBe(200);
    expect(res.json().restricted).toBe(true);
    expect(res.json().subjects).toEqual(
      expect.arrayContaining([
        { kind: "user", id: author },
        { kind: "group", id: team },
        { kind: "role", id: "admin" },
      ])
    );
    expect(res.json().subjects).toHaveLength(3);
  });

  it("reports an unrestricted Page as unrestricted", async () => {
    const pageId = await writePage("hr/open", "# Open");
    const res = await readRestriction(pageId);
    expect(res.json().restricted).toBe(false);
  });

  it("restores Business-wide read when the restriction is removed", async () => {
    const author = caller as string;
    const outsider = await addMember();
    const pageId = await writePage("hr/draft", "# Draft");
    await restrict(pageId, [{ kind: "user", id: author }]);

    caller = outsider;
    expect((await getPage(pageId)).statusCode).toBe(404);

    caller = author;
    expect((await unrestrict(pageId)).statusCode).toBe(200);

    caller = outsider;
    expect((await getPage(pageId)).statusCode).toBe(200);
  });

  it("bumps the Page's access revision without touching its content revision", async () => {
    const author = caller as string;
    const pageId = await writePage("hr/comp", "# Comp bands");
    const before = await db.query<{ acl_revision: string; version: number; content: string }>(
      `SELECT acl_revision, version, content FROM knowledge_pages WHERE id = $1`,
      [pageId]
    );

    await restrict(pageId, [{ kind: "user", id: author }]);

    const after = await db.query<{ acl_revision: string; version: number; content: string }>(
      `SELECT acl_revision, version, content FROM knowledge_pages WHERE id = $1`,
      [pageId]
    );
    expect(after.rows[0].acl_revision).not.toBe(before.rows[0].acl_revision);
    expect(after.rows[0].version).toBe(before.rows[0].version);
    expect(after.rows[0].content).toBe(before.rows[0].content);
  });

  it("refuses a caller who cannot already read the Page", async () => {
    const author = caller as string;
    const outsider = await addMember();
    const pageId = await writePage("hr/comp", "# Comp bands");
    await restrict(pageId, [{ kind: "user", id: author }]);

    caller = outsider;
    const res = await restrict(pageId, [{ kind: "user", id: outsider }]);

    // Indistinguishable from a Page that does not exist — refusing with 403 would confirm it does.
    expect(res.statusCode).toBe(404);
  });

  it("records no deny entries on the authoring path", async () => {
    const author = caller as string;
    const pageId = await writePage("hr/comp", "# Comp bands");
    await restrict(pageId, [{ kind: "user", id: author }]);
    await unrestrict(pageId);
    await restrict(pageId, [{ kind: "role", id: "admin" }]);

    const denies = await db.query(
      `SELECT 1 FROM knowledge_acl_entries WHERE subject_id = $1 AND effect = 'deny'`,
      [pageId]
    );
    expect(denies.rows).toHaveLength(0);
  });

  it("re-restricting replaces the previous list rather than accumulating", async () => {
    const author = caller as string;
    const other = await addMember();
    const pageId = await writePage("hr/comp", "# Comp bands");
    await restrict(pageId, [{ kind: "user", id: author }]);
    await restrict(pageId, [{ kind: "user", id: other }]);

    // Handing readership to someone else takes it away from you: the author is no longer on the
    // list, so the Page is now absent for them. That is the point of replace-not-add.
    expect((await readRestriction(pageId)).statusCode).toBe(404);

    caller = other;
    const res = await readRestriction(pageId);
    expect(res.json().subjects).toEqual([{ kind: "user", id: other }]);
  });

  it("refuses an empty subject list, which would orphan the Page", async () => {
    const pageId = await writePage("hr/comp", "# Comp bands");
    const res = await restrict(pageId, []);
    expect(res.statusCode).toBe(400);
  });
});
