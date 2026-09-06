import { noEmbeddings } from "../knowledge/test-support";
/**
 * A File in Knowledge, over real Postgres.
 *
 * The interesting behaviour is entirely about *who may read the indexed text*, and none of it is
 * visible in a typecheck: a File indexed with a default grant is readable by the whole Business,
 * and a share revoked without a matching ACL write leaves the content quotable by someone who can
 * no longer open the File. Both are silent. So every assertion below is about the reader set.
 *
 * Extraction is the worker's job and is not exercised here — this seam ends at the enqueue.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { FileService, PgFileRepo } from "@tulipfarm/files";
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
import { FileSystemBlobPort } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { PageReadGate } from "../knowledge/page-access";
import { makeMigratedPglite } from "../test/pglite";
import { FILE_INDEX_QUEUE, FileKnowledgeBridge } from "./knowledge-bridge";

const TEST_CSRF = "a".repeat(64);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string) {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string) {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count() {
    return this.users.length;
  }
  async insert(user: UserDoc) {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  async create(_token: TokenDoc) {}
  async findByHash() {
    return null;
  }
  async findByUserId() {
    return [];
  }
  async findAll() {
    return [];
  }
  async findById() {
    return null;
  }
  async deleteById() {}
  async findAllPaginated() {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated() {
    return { items: [], nextCursor: null };
  }
}

interface Enqueued {
  readonly name: string;
  readonly data: object;
}

interface Harness {
  app: FastifyInstance;
  db: PGlite;
  files: FileService;
  knowledge: KnowledgeService;
  pages: PgKnowledgePageRepo;
  chunks: PgKnowledgeChunkRepo;
  gate: PageReadGate;
  sent: Enqueued[];
  ownerSid: string;
  ownerId: string;
  readerSid: string;
  readerId: string;
  strangerId: string;
}

async function harness(
  wrap: (bridge: FileKnowledgeBridge) => FileKnowledgeBridge = (b) => b
): Promise<Harness> {
  const db = await makeMigratedPglite();
  const blobs = new FileSystemBlobPort(await mkdtemp(join(tmpdir(), "tulip-file-knowledge-")));
  const sessionStore = new MemorySessionStore();
  const userRepo = new FakeUserRepo();
  const owner = await createUser(userRepo, "owner@example.com", "pass", "member");
  const reader = await createUser(userRepo, "reader@example.com", "pass", "member");
  const stranger = await createUser(userRepo, "stranger@example.com", "pass", "member");
  // The ACL reads Principals out of Postgres, not out of the fake user repo the auth layer uses.
  for (const id of [owner._id, reader._id, stranger._id]) {
    await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, status, created_at)
       VALUES ($1, $2, 'x', $3, 'member', 'active', now()) ON CONFLICT DO NOTHING`,
      [id, `${id}@example.test`, id]
    );
  }

  const files = new FileService({
    repo: new PgFileRepo(db as never),
    blobs,
    newId: () => randomUUID(),
    rolesOf: async () => [],
  });

  const pages = new PgKnowledgePageRepo(db);
  const chunks = new PgKnowledgeChunkRepo(db);
  const acl = new PgKnowledgeAclRepo(db);
  const knowledge = new KnowledgeService({
    pages,
    chunks,
    revisions: new PgKnowledgeRevisionRepo(db),
    spaces: new PgKnowledgeSpaceRepo(db),
    links: new PgKnowledgeLinksRepo(db),
    overrides: new PgKnowledgeSpaceOverrideRepo(db),
    embeddings: noEmbeddings(),
    retrieval: new PageRetrievalService(db),
    acl,
  });

  const sent: Enqueued[] = [];
  const app = await buildApp({
    sessionStore,
    userRepo,
    tokenRepo: new FakeTokenRepo(),
    fileService: files,
    // Registered so the guard that keeps a File's Page out of the wiki's write surface is exercised
    // against the real read gate, not a stand-in that could disagree with it.
    knowledgeService: knowledge,
    knowledgePageGate: new PageReadGate(db),
    fileKnowledge: wrap(
      new FileKnowledgeBridge({
        pages,
        acl,
        chunks,
        enqueue: {
          async send(name, data) {
            sent.push({ name, data });
            return randomUUID();
          },
        },
        businessId: DEPLOYMENT_BUSINESS_ID,
      })
    ),
  });

  return {
    app,
    db,
    files,
    knowledge,
    pages,
    chunks,
    gate: new PageReadGate(db),
    sent,
    ownerSid: await sessionStore.create(owner._id),
    ownerId: owner._id,
    readerSid: await sessionStore.create(reader._id),
    readerId: reader._id,
    strangerId: stranger._id,
  };
}

function auth(sid: string) {
  return {
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
    headers: { [CSRF_HEADER]: TEST_CSRF },
  };
}

describe("files in knowledge", () => {
  let h: Harness;

  /** Uploads one File as the owner and answers its id. */
  async function upload(): Promise<string> {
    const { headers, cookies } = auth(h.ownerSid);
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/files?filename=handbook.png",
      cookies,
      headers: { ...headers, "content-type": "image/png", "content-length": String(PNG.length) },
      payload: PNG,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /** A File the indexer could actually read text out of, for the paths that go through the route. */
  async function uploadText(): Promise<string> {
    const { headers, cookies } = auth(h.ownerSid);
    const body = Buffer.from("the refund window is fourteen days", "utf8");
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/files?filename=handbook.txt",
      cookies,
      headers: { ...headers, "content-type": "text/plain", "content-length": String(body.length) },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /**
   * Stands in for the worker: indexes the File's text with exactly the readers the File has now.
   * The worker does the same thing after extracting bytes, which this seam deliberately skips.
   */
  async function indexAs(fileId: string): Promise<string> {
    const readers = await h.files.readers(DEPLOYMENT_BUSINESS_ID, fileId, h.ownerId);
    const made = await h.knowledge.createSpace({ name: `Files ${randomUUID()}` });
    if (!made.ok) throw new Error("no space");
    const page = await h.knowledge.ingestSource({
      source: "file",
      sourceId: fileId,
      title: "handbook.png",
      content: "the refund window is fourteen days",
      readers,
      placement: { spaceId: made.space._id, path: `${fileId}.md` },
    });
    if (page === null) throw new Error("indexing produced no page");
    return page._id;
  }

  /** Which of these Pages the Principal may be answered from, right now. */
  async function readable(principalId: string, pageIds: string[]): Promise<string[]> {
    const { allowed } = await h.gate.readablePageIds(principalId, pageIds);
    return [...allowed];
  }

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.app.close();
    await h.db.close();
  });

  it("does not index a File merely because it was uploaded", async () => {
    await upload();
    expect(h.sent).toHaveLength(0);
    const res = await h.app.inject({
      method: "GET",
      url: "/api/v1/files",
      cookies: auth(h.ownerSid).cookies,
    });
    expect(res.json().files[0].inKnowledge).toBe(false);
  });

  it("enqueues extraction when the owner asks, and never runs it in this process", async () => {
    const id = await uploadText();
    const { headers, cookies } = auth(h.ownerSid);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/knowledge`,
      cookies,
      headers,
    });
    expect(res.statusCode).toBe(202);
    expect(h.sent).toEqual([
      { name: FILE_INDEX_QUEUE, data: expect.objectContaining({ fileId: id }) },
    ]);
  });

  it("refuses a type that carries no text, rather than accepting it and indexing nothing", async () => {
    // An image is the commonest upload in a chat product and can never be indexed, so a 202 here
    // would make "in knowledge" the ordinary lie rather than the rare one.
    const id = await upload();
    const { headers, cookies } = auth(h.ownerSid);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/knowledge`,
      cookies,
      headers,
    });
    expect(res.statusCode).toBe(415);
    expect(h.sent).toEqual([]);
  });

  it("refuses to index a File the caller does not own, as if it did not exist", async () => {
    const id = await upload();
    const { headers, cookies } = auth(h.readerSid);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/knowledge`,
      cookies,
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(h.sent).toHaveLength(0);
  });

  it("keeps an indexed File readable by its owner and by nobody else", async () => {
    const id = await upload();
    const pageId = await indexAs(id);
    expect(await readable(h.ownerId, [pageId])).toEqual([pageId]);
    expect(await readable(h.strangerId, [pageId])).toEqual([]);
  });

  it("lets a share reach the indexed text, and a revoke take it away again", async () => {
    const id = await upload();
    const pageId = await indexAs(id);
    const { headers, cookies } = auth(h.ownerSid);

    const shared = await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/shares`,
      cookies,
      headers,
      payload: { kind: "user", id: h.readerId },
    });
    expect(shared.statusCode).toBe(204);
    expect(await readable(h.readerId, [pageId])).toEqual([pageId]);

    const revoked = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/files/${id}/shares/user/${h.readerId}`,
      cookies,
      headers,
    });
    expect(revoked.statusCode).toBe(204);
    // No refresh, no wait: the next question reads these rows, so the revoke is already in force.
    expect(await readable(h.readerId, [pageId])).toEqual([]);
  });

  it("does not let a read-only recipient re-publish, rewrite or move the File's page", async () => {
    // Knowledge is a wiki: anyone who can read a Page may reshare it. Files promise the opposite —
    // a share conveys reading alone. Indexing a shared File puts a non-author in read on a
    // restricted Page, so without a guard the wiki policy would quietly win and a recipient could
    // publish a private document to the whole Business.
    const id = await upload();
    const pageId = await indexAs(id);
    const owner = auth(h.ownerSid);
    await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/shares`,
      cookies: owner.cookies,
      headers: owner.headers,
      payload: { kind: "user", id: h.readerId },
    });
    expect(await readable(h.readerId, [pageId])).toEqual([pageId]);

    const { headers, cookies } = auth(h.readerSid);
    const attempts = [
      { method: "DELETE" as const, url: `/api/v1/knowledge/pages/${pageId}/restriction` },
      {
        method: "PUT" as const,
        url: `/api/v1/knowledge/pages/${pageId}/restriction`,
        payload: { subjects: [{ kind: "user", id: h.readerId }] },
      },
      { method: "DELETE" as const, url: `/api/v1/knowledge/pages/${pageId}` },
      {
        method: "POST" as const,
        url: `/api/v1/knowledge/pages/${pageId}/revisions`,
        payload: { content: "the refund window is thirty days" },
      },
    ];
    for (const attempt of attempts) {
      const res = await h.app.inject({ ...attempt, cookies, headers });
      expect([res.statusCode, attempt.url]).toEqual([409, attempt.url]);
    }

    // Still restricted to exactly the two people the File says, and still saying what it said.
    expect(await readable(h.readerId, [pageId])).toEqual([pageId]);
    const page = await h.knowledge.getPage(pageId);
    expect(page?.active).toBe(true);
    expect(page?.content).toContain("fourteen days");
  });

  it("is findable by lexical search, which is the only arm a deployment always has", async () => {
    const id = await upload();
    const pageId = await indexAs(id);
    // No embedding provider here, on purpose: that is the configuration a fresh instance ships in,
    // and it is exactly the one in which an unplaced Page would be indexed and never seen again.
    const { results } = await h.knowledge.hybridSearchPages("refund window", {}, 10);
    expect(results.map((hit) => hit.pageId)).toContain(pageId);
  });

  it("takes the chunks out when the File is archived, so retrieval cannot quote it", async () => {
    const id = await upload();
    const pageId = await indexAs(id);
    const before = await h.chunks.listByPageForDiff(pageId);
    expect(before.length).toBeGreaterThan(0);

    const { headers, cookies } = auth(h.ownerSid);
    const res = await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/archive`,
      cookies,
      headers,
      payload: { expectedRevision: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(await h.chunks.listByPageForDiff(pageId)).toHaveLength(0);
    expect(await h.pages.getBySource("file", id)).toBeNull();
  });

  it("remembers Knowledge opt-in and re-enqueues after archive restore", async () => {
    const id = await uploadText();
    const owner = auth(h.ownerSid);
    await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/knowledge`,
      ...owner,
    });
    await indexAs(id);

    await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/archive`,
      ...owner,
      payload: { expectedRevision: 1 },
    });
    const restored = await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/restore`,
      ...owner,
      payload: { expectedRevision: 2 },
    });

    expect(restored.statusCode).toBe(200);
    expect(h.sent.filter((job) => job.name === FILE_INDEX_QUEUE)).toHaveLength(2);
  });

  it("does not archive when Knowledge removal fails", async () => {
    const broken = await harness((bridge) => {
      const failing = Object.create(bridge) as FileKnowledgeBridge;
      Object.defineProperty(failing, "remove", {
        value: async () => {
          throw new Error("knowledge unavailable");
        },
      });
      return failing;
    });
    const id = await (async () => {
      const { headers, cookies } = auth(broken.ownerSid);
      const res = await broken.app.inject({
        method: "POST",
        url: "/api/v1/files?filename=handbook.png",
        cookies,
        headers: { ...headers, "content-type": "image/png", "content-length": String(PNG.length) },
        payload: PNG,
      });
      return res.json().id as string;
    })();
    const readers = await broken.files.readers(DEPLOYMENT_BUSINESS_ID, id, broken.ownerId);
    const made = await broken.knowledge.createSpace({ name: `Files ${randomUUID()}` });
    if (!made.ok) throw new Error("no space");
    const page = await broken.knowledge.ingestSource({
      source: "file",
      sourceId: id,
      title: "handbook.png",
      content: "the refund window is fourteen days",
      readers,
      placement: { spaceId: made.space._id, path: `${id}.md` },
    });
    if (page === null) throw new Error("no page");

    const { headers, cookies } = auth(broken.ownerSid);
    const res = await broken.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/archive`,
      cookies,
      headers,
      payload: { expectedRevision: 1 },
    });
    expect(res.statusCode).toBe(500);
    expect(
      (await broken.files.read(DEPLOYMENT_BUSINESS_ID, id, broken.ownerId)).archivedAt
    ).toBeNull();
    expect(await broken.chunks.listByPageForDiff(page._id)).not.toHaveLength(0);
    await broken.app.close();
    await broken.db.close();
  });

  it("un-indexes a File whose revoke could not reach knowledge, rather than leaving it readable", async () => {
    // The File-level share is already gone by the time the ACL write fails. Surfacing the error and
    // stopping would leave the revoked reader able to retrieve the text through Knowledge.
    const broken = await harness((bridge) => {
      const failing = Object.create(bridge) as FileKnowledgeBridge;
      Object.defineProperty(failing, "syncReaders", {
        value: async () => {
          throw new Error("acl write failed");
        },
      });
      return failing;
    });
    const { headers, cookies } = auth(broken.ownerSid);
    const uploaded = await broken.app.inject({
      method: "POST",
      url: "/api/v1/files?filename=handbook.png",
      cookies,
      headers: { ...headers, "content-type": "image/png", "content-length": String(PNG.length) },
      payload: PNG,
    });
    const id = uploaded.json().id as string;
    await broken.app.inject({
      method: "POST",
      url: `/api/v1/files/${id}/shares`,
      cookies,
      headers,
      payload: { kind: "user", id: broken.readerId },
    });
    const readers = await broken.files.readers(DEPLOYMENT_BUSINESS_ID, id, broken.ownerId);
    const made = await broken.knowledge.createSpace({ name: `Files ${randomUUID()}` });
    if (!made.ok) throw new Error("no space");
    const page = await broken.knowledge.ingestSource({
      source: "file",
      sourceId: id,
      title: "handbook.png",
      content: "the refund window is fourteen days",
      readers,
      placement: { spaceId: made.space._id, path: `${id}.md` },
    });
    if (page === null) throw new Error("no page");

    const revoked = await broken.app.inject({
      method: "DELETE",
      url: `/api/v1/files/${id}/shares/user/${broken.readerId}`,
      cookies,
      headers,
    });
    expect(revoked.statusCode).toBe(500);
    // Readable by nobody now, which is always a subset of what the revoke asked for.
    expect(await broken.chunks.listByPageForDiff(page._id)).toHaveLength(0);
    await broken.app.close();
    await broken.db.close();
  });

  it("removes a File from knowledge without destroying the File", async () => {
    const id = await upload();
    const pageId = await indexAs(id);
    const { headers, cookies } = auth(h.ownerSid);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/files/${id}/knowledge`,
      cookies,
      headers,
    });
    expect(res.statusCode).toBe(204);
    expect(await h.chunks.listByPageForDiff(pageId)).toHaveLength(0);

    const still = await h.app.inject({
      method: "GET",
      url: `/api/v1/files/${id}`,
      cookies: auth(h.ownerSid).cookies,
    });
    expect(still.statusCode).toBe(200);
    expect(still.json().inKnowledge).toBe(false);
  });
});
