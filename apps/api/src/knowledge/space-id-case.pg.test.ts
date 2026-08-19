/**
 * A Space has exactly one name, whatever case it is spelled in.
 *
 * `knowledge_acl_entries.subject_id` is `text` (it names Spaces, Pages and external subjects alike)
 * so it compares case-sensitively. `knowledge_spaces.id` is `uuid`, which does not. Left alone the
 * two disagree: the gate finds no restriction row for `A0EE…`, calls the Space unrestricted, and
 * then the `uuid` column happily resolves `A0EE…` to the restricted row.
 *
 * Both directions have to hold, because either spelling can be the one that reaches the database
 * first:
 *   - the *request* is non-canonical and the stored grant is canonical;
 *   - the stored grant is non-canonical and the request is canonical.
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

describe("Space id case canonicalization", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let acl: PgKnowledgeAclRepo;
  let caller: string | undefined;
  let spaceId: string;

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

  const getSpace = (id: string) => app.inject({ method: "GET", url: `${base}/spaces/${id}` });
  const listPages = (id: string) =>
    app.inject({ method: "GET", url: `${base}/spaces/${id}/pages` });
  const restrictSpace = (id: string, subjects: { kind: string; id: string }[]) =>
    app.inject({ method: "PUT", url: `${base}/spaces/${id}/restriction`, payload: { subjects } });

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
    const created = await service.createSpace({ name: "layoffs", description: "confidential" });
    if (!created.ok) throw new Error("space creation failed");
    spaceId = created.space._id;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("control: an unrestricted Space is readable, so a later 404 is the restriction talking", async () => {
    expect((await getSpace(spaceId)).statusCode).toBe(200);
  });

  it("control: the canonical spelling is denied to an outsider", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    caller = outsider;
    expect((await getSpace(spaceId)).statusCode).toBe(404);
  });

  it("denies an outsider spelling a restricted Space's id in upper case", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    caller = outsider;
    const res = await getSpace(spaceId.toUpperCase());
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("confidential");
    expect(res.body).not.toContain("layoffs");
  });

  it("denies the upper-case spelling on the Page listing too", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    caller = outsider;
    expect((await listPages(spaceId.toUpperCase())).statusCode).toBe(404);
  });

  it("refuses to let an outsider author into a restricted Space via the upper-case id", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    caller = outsider;
    const res = await app.inject({
      method: "POST",
      url: `${base}/spaces/${spaceId.toUpperCase()}/pages`,
      payload: { path: "smuggled", content: "# Smuggled" },
    });
    expect(res.statusCode).toBe(404);

    caller = insider;
    const listed = await listPages(spaceId);
    expect(listed.body).not.toContain("smuggled");
  });

  it("honours a grant that was stored non-canonically", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    // A grant written before ids were canonicalized. The request below is spelled correctly; it is
    // the stored row that disagrees, so a gate that only normalizes the request still leaks.
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind: "space",
      subjectId: spaceId.toUpperCase(),
      principal: { kind: "user", id: insider },
      effect: "grant",
      capability: "read",
    });

    caller = outsider;
    expect((await getSpace(spaceId)).statusCode).toBe(404);
  });

  it("still admits the named insider when the grant was stored non-canonically", async () => {
    const insider = caller as string;
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind: "space",
      subjectId: spaceId.toUpperCase(),
      principal: { kind: "user", id: insider },
      effect: "grant",
      capability: "read",
    });

    expect((await getSpace(spaceId)).statusCode).toBe(200);
  });

  it("can revoke a grant that was stored non-canonically", async () => {
    const insider = caller as string;
    const outsider = await addMember();
    // Written straight to the table so the row keeps its non-canonical spelling: this is legacy
    // data, not something the current write path can still produce. A revoke that compares
    // case-sensitively misses it, and the grant becomes impossible to lift through the product.
    await db.query(
      `INSERT INTO knowledge_acl_entries
         (business_id, subject_kind, subject_id, principal_kind, principal_id,
          effect, capability, origin, acl_revision, captured_at)
       VALUES ($1, 'space', $2, 'user', $3, 'grant', 'read', 'authored', '1', now())`,
      [DEPLOYMENT_BUSINESS_ID, spaceId.toUpperCase(), insider]
    );

    caller = outsider;
    expect((await getSpace(spaceId)).statusCode).toBe(404);

    caller = insider;
    await app.inject({ method: "DELETE", url: `${base}/spaces/${spaceId}/restriction` });

    // Unrestricted again only if the non-canonical row was actually deleted.
    caller = outsider;
    expect((await getSpace(spaceId)).statusCode).toBe(200);
  });

  it("stores a grant under the canonical spelling whatever it was given", async () => {
    const insider = caller as string;
    await acl.put({
      businessId: DEPLOYMENT_BUSINESS_ID,
      subjectKind: "space",
      subjectId: spaceId.toUpperCase(),
      principal: { kind: "user", id: insider },
      effect: "grant",
      capability: "read",
    });

    const { rows } = await db.query<{ subject_id: string }>(
      `SELECT subject_id FROM knowledge_acl_entries WHERE subject_kind = 'space'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe(spaceId);
  });

  it("drops a subject's grants even when one was stored non-canonically", async () => {
    const insider = caller as string;
    await db.query(
      `INSERT INTO knowledge_acl_entries
         (business_id, subject_kind, subject_id, principal_kind, principal_id,
          effect, capability, origin, acl_revision, captured_at)
       VALUES ($1, 'space', $2, 'user', $3, 'grant', 'read', 'authored', '1', now())`,
      [DEPLOYMENT_BUSINESS_ID, spaceId.toUpperCase(), insider]
    );

    const dropped = await acl.removeSubject(DEPLOYMENT_BUSINESS_ID, "space", spaceId);
    expect(dropped).toBe(1);
  });

  it("admits the insider whichever way the id is spelled", async () => {
    const insider = caller as string;
    await restrictSpace(spaceId, [{ kind: "user", id: insider }]);

    expect((await getSpace(spaceId)).statusCode).toBe(200);
    expect((await getSpace(spaceId.toUpperCase())).statusCode).toBe(200);
  });
});
