import { noEmbeddings } from "./test-support";
/**
 * "Who can see this?" — the question the whole spec exists to answer, asked directly.
 *
 * Two things make it hard to answer honestly. A restriction can arrive from an ancestor rather than
 * from this Page, and showing that as if the author had set it invites them to "remove" something
 * they cannot remove. And a reader can arrive through a Team or a Role rather than by being named,
 * so a list of named subjects is not a list of readers.
 *
 * This is a deliberate, caller-initiated disclosure about a Page the caller already reads and
 * administers. It is not the same as the passive readership preview in `page-move.ts`, which
 * deliberately does *not* expand Teams — there the caller never asked, so naming members of a Team
 * they cannot enumerate would be a disclosure they did not request.
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
import { AuthorLabeller } from "./author-label";
import { PageReadGate } from "./page-access";
import { ReaderDirectory } from "./reader-directory";
import { registerKnowledgeRoutes } from "./routes";

const base = "/api/v1/knowledge";

describe("who can see this Page", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string;
  /** Set to an action name to make the deployment's decision engine refuse it. */
  let deniedAction: string | null;
  let spaceId: string;
  let spaceName: string;

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

  async function addTeam(team: string, members: string[]): Promise<string> {
    await db.query(
      `INSERT INTO principal_groups (business_id, id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, team]
    );
    for (const m of members) {
      await db.query(
        `INSERT INTO principal_group_members (business_id, group_id, principal_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [DEPLOYMENT_BUSINESS_ID, team, m]
      );
    }
    return team;
  }

  async function writePage(path: string): Promise<string> {
    const r = await service.writePage({ spaceId, path, content: `# ${path}` });
    if (!r.ok || !("page" in r)) throw new Error(`write failed: ${path}`);
    return r.page._id;
  }

  const restrictPage = (id: string, subjects: Array<{ kind: string; id: string }>) =>
    app.inject({
      method: "PUT",
      url: `${base}/pages/${id}/restriction`,
      payload: { subjects },
    });

  const restrictSpace = (id: string, subjects: Array<{ kind: string; id: string }>) =>
    app.inject({
      method: "PUT",
      url: `${base}/spaces/${id}/restriction`,
      payload: { subjects },
    });

  const visibility = (id: string) =>
    app.inject({ method: "GET", url: `${base}/pages/${id}/visibility` });

  beforeEach(async () => {
    deniedAction = null;
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
      makeRequireAuthorization({
        authorize: async (_principal, request) => request.action !== deniedAction,
      }),
      new PageReadGate(db),
      new PageRetrievalService(db),
      undefined,
      new AuthorLabeller(db),
      new ReaderDirectory(db)
    );
    await app.ready();

    spaceName = "handbook";
    const s = await service.createSpace({ name: spaceName });
    if (!s.ok) throw new Error("space creation failed");
    spaceId = s.space._id;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("says an unrestricted Page is open to the whole Business, not that it has no readers", async () => {
    const id = await writePage("policies/leave");

    const res = await visibility(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe("business");
    expect(res.json().restricted).toBe(false);
  });

  it("names the readers a Team grants, and says the Team is how they got there", async () => {
    const ana = await addUser("Ana Ruiz");
    const bo = await addUser("Bo Chen");
    // The caller must be in the Team, or restricting the Page to it locks them out of their own work.
    await addTeam("finance", [ana, bo, caller]);
    const id = await writePage("comp/bands");
    expect((await restrictPage(id, [{ kind: "group", id: "finance" }])).statusCode).toBe(200);

    const res = await visibility(id);
    if (res.statusCode !== 200) throw new Error(`${res.statusCode}: ${res.body}`);
    const body = res.json();
    expect(body.scope).toBe("own");
    const names = body.readers.map((r: { label: string }) => r.label).sort();
    expect(names).toContain("Ana Ruiz");
    expect(names).toContain("Bo Chen");
    expect(names).toContain("Caller");
    for (const r of body.readers) expect(r.via).toEqual({ kind: "group", id: "finance" });
  });

  it("shows a restriction that comes from the Space as inherited, and names the Space", async () => {
    const ana = await addUser("Ana Ruiz");
    const id = await writePage("policies/leave");
    expect((await restrictSpace(spaceId, [{ kind: "user", id: caller }])).statusCode).toBe(200);
    expect(ana).toBeTruthy();

    const body = (await visibility(id)).json();
    expect(body.scope).toBe("inherited");
    expect(body.restricted).toBe(true);
    expect(body.inheritedFrom).toMatchObject({ kind: "space", id: spaceId, label: spaceName });
    // The Page names nobody itself; presenting the ancestor's list as the Page's own would invite
    // the author to "remove" a restriction they cannot remove from here.
    expect(body.own).toEqual([]);
  });

  it("names the ancestor Page a restriction is inherited from, not just the Space", async () => {
    const parent = await writePage("comp");
    const child = await writePage("comp/bands");
    expect((await restrictPage(parent, [{ kind: "user", id: caller }])).statusCode).toBe(200);

    const body = (await visibility(child)).json();
    expect(body.scope).toBe("inherited");
    expect(body.inheritedFrom).toMatchObject({ kind: "page", id: parent });
  });

  it("refuses a grant its ancestor does not allow, naming the ancestor, and applies none of it", async () => {
    const ana = await addUser("Ana Ruiz");
    const outsider = await addUser("Outsider");
    const parent = await writePage("comp");
    const child = await writePage("comp/bands");
    expect(
      (
        await restrictPage(parent, [
          { kind: "user", id: caller },
          { kind: "user", id: ana },
        ])
      ).statusCode
    ).toBe(200);

    const res = await restrictPage(child, [
      { kind: "user", id: ana },
      { kind: "user", id: outsider },
    ]);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/ancestor/i);
    expect(res.json().constrainedBy).toMatchObject({ kind: "page", id: parent });

    // Partially applying it would silently narrow the Page to something nobody asked for.
    expect((await visibility(child)).json().own).toEqual([]);
  });

  it("answers the visibility of a Page the caller cannot read as it answers an absent one", async () => {
    const other = await addUser("Other");
    const id = await writePage("comp/exec");
    expect((await restrictPage(id, [{ kind: "user", id: other }])).statusCode).toBe(200);

    const denied = await visibility(id);
    const absent = await visibility(randomUUID());
    expect(denied.statusCode).toBe(absent.statusCode);
    expect(denied.body).toBe(absent.body);
  });

  it("declares reshare through the authorization gate, so a deployment can refuse it", async () => {
    const id = await writePage("comp/bands");
    deniedAction = "knowledge_page.restrict";

    const refused = await app.inject({
      method: "PUT",
      url: `/api/v1/knowledge/pages/${id}/restriction`,
      payload: { subjects: [{ kind: "user", id: caller }] },
    });
    expect(refused.statusCode).toBe(403);

    // Reading who can see it is not a reshare, so refusing reshare must not blind the author.
    expect((await visibility(id)).statusCode).toBe(200);
    expect((await visibility(id)).json().scope).toBe("business");
  });

  it("refuses a grant that reaches past an ancestor's ceiling, and applies none of it", async () => {
    const ana = await addUser("Ana Ruiz");
    const bo = await addUser("Bo Lang");
    const parent = await writePage("comp");
    const child = await writePage("comp/bands");

    // The ancestor admits the caller and Ana. Bo is outside it.
    expect(
      (
        await restrictPage(parent, [
          { kind: "user", id: caller },
          { kind: "user", id: ana },
        ])
      ).statusCode
    ).toBe(200);

    const refused = await restrictPage(child, [
      { kind: "user", id: ana },
      { kind: "user", id: bo },
    ]);
    expect(refused.statusCode).toBe(409);

    const body = refused.json();
    expect(body.error).toMatch(/beyond/i);
    // Naming the ancestor is the point: without it the author cannot find what to change.
    expect(body.constrainedBy.label).toBe("comp");
    expect(body.rejected).toEqual([{ kind: "user", id: bo }]);

    // Not partially applied: the child must still be exactly what the ancestor left it.
    const after = await visibility(child);
    expect(after.statusCode).toBe(200);
    expect(after.json().scope).toBe("inherited");
    expect(after.json().own).toEqual([]);
  });
});
