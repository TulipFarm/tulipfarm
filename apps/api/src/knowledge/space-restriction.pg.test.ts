/**
 * Restricting a whole Space, inherited by every Page beneath it.
 *
 * The security boundary is enforced at **read** time, not write time: a Space can be restricted long
 * after the Pages beneath it were authored, so a write-time check alone would leave every earlier
 * Page still carrying its old grants.
 *
 * A Page may narrow its Space's list. It can never widen it — a grant naming someone the Space
 * excludes has no effect on who can read the Page, whenever that grant was written.
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

describe("Space restriction", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string | undefined;
  let spaceId: string;

  async function addMember(role: "member" | "admin" = "member"): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, $4, 'active', now())`,
      [id, `${id}@example.test`, id, role]
    );
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, id, role]
    );
    return id;
  }

  async function addTeam(name: string): Promise<string> {
    await db.query(`INSERT INTO principal_groups (business_id, id) VALUES ($1, $2)`, [
      DEPLOYMENT_BUSINESS_ID,
      name,
    ]);
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
    const res = await service.writePage({ spaceId, path, content });
    if (!res.ok || !("page" in res)) throw new Error(`write failed: ${JSON.stringify(res)}`);
    return res.page._id;
  }

  const restrictSpace = (id: string, subjects: { kind: string; id: string }[]) =>
    app.inject({ method: "PUT", url: `${base}/spaces/${id}/restriction`, payload: { subjects } });

  const unrestrictSpace = (id: string) =>
    app.inject({ method: "DELETE", url: `${base}/spaces/${id}/restriction` });

  const readSpaceRestriction = (id: string) =>
    app.inject({ method: "GET", url: `${base}/spaces/${id}/restriction` });

  const restrictPage = (id: string, subjects: { kind: string; id: string }[]) =>
    app.inject({ method: "PUT", url: `${base}/pages/${id}/restriction`, payload: { subjects } });

  const getPage = (id: string) => app.inject({ method: "GET", url: `${base}/pages/${id}` });

  beforeEach(async () => {
    db = await makeMigratedPglite();
    const acl = new PgKnowledgeAclRepo(db);
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
    const created = await service.createSpace({ name: "hr" });
    if (!created.ok) throw new Error("space creation failed");
    spaceId = created.space._id;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("denies every Page beneath a restricted Space to members outside the list", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    const a = await writePage("comp/bands", "# Bands");
    const b = await writePage("policies/leave", "# Leave");

    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    caller = outsider;
    expect((await getPage(a)).statusCode).toBe(404);
    expect((await getPage(b)).statusCode).toBe(404);
  });

  it("serves those Pages to a member inside the list", async () => {
    const insider = caller as string;
    const pageId = await writePage("comp/bands", "# Bands");
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    expect((await getPage(pageId)).statusCode).toBe(200);
  });

  it("denies a Page created after the restriction to members outside the list", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    const later = await writePage("comp/new-hire", "# New hire");

    caller = outsider;
    expect((await getPage(later)).statusCode).toBe(404);
    caller = insider;
    expect((await getPage(later)).statusCode).toBe(200);
  });

  it("keeps the narrower list when a Page restricts itself further than its Space", async () => {
    const insider = caller as string;
    const alsoInSpace = await addMember();
    const pageId = await writePage("comp/exec", "# Exec comp");

    await restrictSpace(spaceId, [
      { kind: "user", id: insider },
      { kind: "user", id: alsoInSpace },
    ]);
    await restrictPage(pageId, [{ kind: "user", id: insider }]);

    expect((await getPage(pageId)).statusCode).toBe(200);
    caller = alsoInSpace;
    expect((await getPage(pageId)).statusCode).toBe(404);
  });

  it("does not let a Page grant its way back out of its Space", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    const pageId = await writePage("comp/exec", "# Exec comp");

    await restrictPage(pageId, [{ kind: "user", id: outsider }]);
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    // The Page's grant predates the Space restriction, which is exactly the case a write-time
    // check would miss.
    caller = outsider;
    expect((await getPage(pageId)).statusCode).toBe(404);
  });

  it("inherits from the nearest restricted ancestor Page, falling back to the Space", async () => {
    const insider = caller as string;
    const midOnly = await addMember();
    const outsider = await addMember();

    const parent = await writePage("comp", "# Comp");
    const child = await writePage("comp/bands", "# Bands");

    await restrictSpace(spaceId, [
      { kind: "user", id: insider },
      { kind: "user", id: midOnly },
      { kind: "user", id: outsider },
    ]);
    await restrictPage(parent, [
      { kind: "user", id: insider },
      { kind: "user", id: midOnly },
    ]);

    caller = midOnly;
    expect((await getPage(child)).statusCode).toBe(200);
    caller = outsider;
    expect((await getPage(child)).statusCode).toBe(404);
  });

  it("hides a restricted Space's Pages from every derived surface", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    const pageId = await writePage("comp/bands", "# Salary bands\n\nCodeword ORCHIDBANK.");
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    caller = outsider;
    const search = await app.inject({
      method: "POST",
      url: `${base}/search`,
      payload: { query: "salary" },
    });
    expect(search.statusCode).toBe(200);
    expect(search.body).not.toContain(pageId);
    expect(search.body).not.toContain("ORCHIDBANK");

    // Business-wide surfaces stay reachable and simply omit the Space's Pages.
    for (const url of [`${base}/pages`, `${base}/pages/mentions?q=salary`, `${base}/overview`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(pageId);
      expect(res.body, url).not.toContain("ORCHIDBANK");
    }

    // Space-scoped surfaces answer as if the Space did not exist, so 404 cannot be read as
    // "it exists but is empty for you" — that distinction is itself a disclosure.
    for (const url of [`${base}/spaces/${spaceId}/navigate`, `${base}/spaces/${spaceId}/graph`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain(pageId);
      expect(res.body, url).not.toContain("ORCHIDBANK");
    }
  });

  it("restores Business-wide read on removal, leaving Page restrictions in place", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    const open = await writePage("policies/leave", "# Leave");
    const own = await writePage("comp/exec", "# Exec comp");

    await restrictPage(own, [{ kind: "user", id: insider }]);
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);
    await unrestrictSpace(spaceId);

    caller = outsider;
    expect((await getPage(open)).statusCode).toBe(200);
    expect((await getPage(own)).statusCode).toBe(404);
  });

  it("serves a Space restricted to a Team to that Team's members and nobody else", async () => {
    const outsider = await addMember();
    const teammate = await addMember();
    const team = await addTeam("hr-team");
    await joinTeam(team, teammate);
    const pageId = await writePage("comp/bands", "# Bands");

    await restrictSpace(spaceId, [{ kind: "group", id: team }]);

    caller = teammate;
    expect((await getPage(pageId)).statusCode).toBe(200);
    caller = outsider;
    expect((await getPage(pageId)).statusCode).toBe(404);
  });

  it("stops serving when a Team membership expires, without touching the Space", async () => {
    const teammate = await addMember();
    const team = await addTeam("hr-team");
    await joinTeam(team, teammate, new Date(Date.now() - 60_000));
    const pageId = await writePage("comp/bands", "# Bands");
    await restrictSpace(spaceId, [{ kind: "group", id: team }]);

    caller = teammate;
    expect((await getPage(pageId)).statusCode).toBe(404);
  });

  it("stops serving when the Team itself expires", async () => {
    const teammate = await addMember();
    const team = await addTeam("hr-team");
    await joinTeam(team, teammate);
    const pageId = await writePage("comp/bands", "# Bands");
    await restrictSpace(spaceId, [{ kind: "group", id: team }]);

    caller = teammate;
    expect((await getPage(pageId)).statusCode).toBe(200);

    await db.query(
      `UPDATE principal_groups SET expires_at = now() - interval '1 minute'
                    WHERE id = $1`,
      [team]
    );
    expect((await getPage(pageId)).statusCode).toBe(404);
  });

  it("reports exactly the subjects that can read the Space, across all three kinds", async () => {
    const insider = caller as string;
    const team = await addTeam("hr-team");
    await restrictSpace(spaceId, [
      { kind: "user", id: insider },
      { kind: "group", id: team },
      { kind: "role", id: "admin" },
    ]);

    const res = await readSpaceRestriction(spaceId);
    expect(res.statusCode).toBe(200);
    expect(res.json().restricted).toBe(true);
    expect(res.json().subjects).toEqual(
      expect.arrayContaining([
        { kind: "user", id: insider },
        { kind: "group", id: team },
        { kind: "role", id: "admin" },
      ])
    );
    expect(res.json().subjects).toHaveLength(3);
  });

  it("reports an unrestricted Space as unrestricted", async () => {
    const res = await readSpaceRestriction(spaceId);
    expect(res.json()).toEqual({ restricted: false, subjects: [] });
  });

  it("is inert when nothing is restricted: two members see identical Pages", async () => {
    const insider = caller as string;
    const other = await addMember();
    const pageId = await writePage("policies/leave", "# Leave");

    const a = await getPage(pageId);
    caller = other;
    const b = await getPage(pageId);

    expect(b.statusCode).toBe(200);
    expect(b.body).toBe(a.body);
    expect(insider).toBeDefined();
  });
});
