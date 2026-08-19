/**
 * Deleting a Space takes everything under it with it.
 *
 * The confirm dialog promises exactly that — "Its N pages will be deleted with it, along with their
 * history and links. This cannot be undone." — so anything left behind is a lie the product told,
 * not merely untidy storage. Two of the leftovers are access-control leaks rather than clutter: an
 * ACL entry whose subject no longer exists still names people, and a chunk whose Page is gone is
 * still reachable by retrieval, which authorizes against a Page row that would no longer be there
 * to refuse.
 *
 * `knowledge_pages.space_id` is NO ACTION on purpose: an accidental `DELETE FROM knowledge_spaces`
 * must not silently take a corpus with it. That makes deleting the Pages the service's job, and
 * makes this a real-Postgres test — the foreign keys and the ACL prune triggers are the behaviour
 * under test, and no fake repository can stand in for them.
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

describe("deleting a Space", () => {
  let db: PGlite;
  let app: FastifyInstance;
  let service: KnowledgeService;
  let caller: string;
  let spaceId: string;

  const count = async (sql: string, params: unknown[]): Promise<number> =>
    Number((await db.query<{ n: number }>(sql, params)).rows[0].n);

  async function writePage(path: string, content: string): Promise<string> {
    const res = await service.writePage({ spaceId, path, content });
    if (!res.ok || !("page" in res)) throw new Error(`write failed: ${JSON.stringify(res)}`);
    return res.page._id;
  }

  const deleteSpace = (id: string) => app.inject({ method: "DELETE", url: `${base}/spaces/${id}` });

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
      acl: new PgKnowledgeAclRepo(db),
      readership: new PgKnowledgeSubjectStore(db),
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
          role: "admin",
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
          role: "admin",
        };
      },
      makeRequireAuthorization(),
      new PageReadGate(db),
      new PageRetrievalService(db)
    );
    await app.ready();

    caller = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', null, 'admin', 'active', now())`,
      [caller, `${caller}@example.test`]
    );
    await db.query(
      `INSERT INTO role_assignments (business_id, principal_id, role_id) VALUES ($1, $2, 'admin')
       ON CONFLICT DO NOTHING`,
      [DEPLOYMENT_BUSINESS_ID, caller]
    );
    const created = await service.createSpace({ name: "hr" });
    if (!created.ok) throw new Error("space creation failed");
    spaceId = created.space._id;
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("succeeds on a Space that still has Pages in it", async () => {
    await writePage("handbook", "---\ntitle: Handbook\n---\n\nbody");
    await writePage("policies/leave", "---\ntitle: Leave\n---\n\nbody");

    expect((await deleteSpace(spaceId)).statusCode).toBe(204);
    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_spaces WHERE id = $1", [spaceId])
    ).toBe(0);
  });

  it("takes the Pages with it rather than orphaning them", async () => {
    await writePage("handbook", "---\ntitle: Handbook\n---\n\nbody");
    await writePage("policies/leave", "---\ntitle: Leave\n---\n\nbody");

    await deleteSpace(spaceId);

    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_pages WHERE space_id = $1", [spaceId])
    ).toBe(0);
  });

  it("takes each Page's history and links with it", async () => {
    const handbook = await writePage("handbook", "# Handbook\n\n[Leave](policies/leave.md)");
    await writePage("policies/leave", "---\ntitle: Leave\n---\n\nbody");
    await service.writePage({
      spaceId,
      path: "handbook",
      content: "# Handbook\n\nrevised, still [Leave](policies/leave.md)",
    });
    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_revisions WHERE page_id = $1", [
        handbook,
      ])
    ).toBeGreaterThan(0);
    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_links WHERE space_id = $1", [spaceId])
    ).toBeGreaterThan(0);

    await deleteSpace(spaceId);

    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_revisions WHERE page_id = $1", [
        handbook,
      ])
    ).toBe(0);
    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_links WHERE space_id = $1", [spaceId])
    ).toBe(0);
  });

  it("leaves no chunk behind for retrieval to serve from a Page that no longer exists", async () => {
    const handbook = await writePage("handbook", "---\ntitle: Handbook\n---\n\nbody");
    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_chunks WHERE page_id = $1", [handbook])
    ).toBeGreaterThan(0);

    await deleteSpace(spaceId);

    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_chunks WHERE page_id = $1", [handbook])
    ).toBe(0);
  });

  it("leaves no ACL entry naming a Page or Space that is gone", async () => {
    const handbook = await writePage("handbook", "---\ntitle: Handbook\n---\n\nbody");
    await app.inject({
      method: "PUT",
      url: `${base}/pages/${handbook}/restriction`,
      payload: { subjects: [{ kind: "user", id: caller }] },
    });
    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_acl_entries WHERE subject_id = $1", [
        handbook,
      ])
    ).toBeGreaterThan(0);

    await deleteSpace(spaceId);

    expect(
      await count(
        "SELECT count(*)::int AS n FROM knowledge_acl_entries WHERE subject_id = ANY($1)",
        [[handbook, spaceId]]
      )
    ).toBe(0);
  });

  it("does not touch a Page in a different Space", async () => {
    const other = await service.createSpace({ name: "eng" });
    if (!other.ok) throw new Error("space creation failed");
    const survivor = await service.writePage({
      spaceId: other.space._id,
      path: "runbook",
      content: "---\ntitle: Runbook\n---\n\nbody",
    });
    if (!survivor.ok || !("page" in survivor)) throw new Error("write failed");
    await writePage("handbook", "---\ntitle: Handbook\n---\n\nbody");

    await deleteSpace(spaceId);

    expect(await service.getPage(survivor.page._id)).not.toBeNull();
    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_chunks WHERE page_id = $1", [
        survivor.page._id,
      ])
    ).toBeGreaterThan(0);
  });

  it("reports 404 for a Space that is already gone, so a double submit is not an error", async () => {
    await writePage("handbook", "---\ntitle: Handbook\n---\n\nbody");
    expect((await deleteSpace(spaceId)).statusCode).toBe(204);
    expect((await deleteSpace(spaceId)).statusCode).toBe(404);
  });

  // deletePage is a *soft* delete, so the row and its space_id survive it. A Space cleanup that
  // only swept live Pages would leave those tombstones behind and the FK would still refuse.
  it("succeeds when a Page in it was already deleted, since that delete was only a tombstone", async () => {
    const doomed = await writePage("handbook", "---\ntitle: Handbook\n---\n\nbody");
    await service.deletePage(doomed);
    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_pages WHERE id = $1", [doomed])
    ).toBe(1);

    expect((await deleteSpace(spaceId)).statusCode).toBe(204);

    expect(
      await count("SELECT count(*)::int AS n FROM knowledge_pages WHERE id = $1", [doomed])
    ).toBe(0);
  });
});
