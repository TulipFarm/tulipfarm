/**
 * Seam 1 for Files: the real application, real HTTP, real Postgres, real blob store.
 *
 * Every assertion here is about a rejection or an authorization boundary, because those are the
 * behaviours that a passing typecheck says nothing about and that a person cannot verify by
 * reading the route.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  FILE_DRAFT_STATEMENTS,
  FILE_FOLDER_STATEMENTS,
  FILE_KNOWLEDGE_STATEMENTS,
  FILE_ORIGIN_STATEMENTS,
  FILE_SHARE_STATEMENTS,
  FILE_STORAGE_STATEMENTS,
  FILE_VERSION_STATEMENTS,
  type FileAssetOwnership,
  type FileOwnershipPort,
  FileService,
  MAX_FILE_BYTES,
  PgFileRepo,
} from "@tulipfarm/files";
import { FileSystemBlobPort } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";

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

class FakeFileOwnership implements FileOwnershipPort {
  readonly records = new Map<string, FileAssetOwnership>();
  readonly teamAccess = new Map<string, Set<string>>();

  async createPersonal(businessId: string, fileId: string, principalId: string) {
    this.records.set(fileId, {
      businessId,
      assetType: "file",
      assetId: fileId,
      owners: [{ kind: "principal", principalId, principalKind: "user" }],
      shares: [],
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async get(_businessId: string, fileId: string) {
    return this.records.get(fileId);
  }

  async accessFor(ownership: FileAssetOwnership, principalId: string) {
    const personal = ownership.owners.some(
      (owner) => owner.kind === "principal" && owner.principalId === principalId
    );
    const team = ownership.owners.some(
      (owner) => owner.kind === "team" && this.teamAccess.get(owner.teamId)?.has(principalId)
    );
    return {
      levels: personal
        ? (["view", "use", "edit"] as const)
        : team
          ? (["view", "use"] as const)
          : [],
      canManageOwnership: personal,
    };
  }

  async consumeDestructiveApproval() {}
}

interface Harness {
  app: FastifyInstance;
  database: PGlite;
  blobRoot: string;
  blobs: FileSystemBlobPort;
  files: FileService;
  roles: Map<string, string[]>;
  ownership: FakeFileOwnership;
  ownerSid: string;
  ownerId: string;
  strangerSid: string;
  strangerId: string;
}

async function appWith(): Promise<Harness> {
  const database = await PGlite.create({ extensions: { vector, citext, pg_trgm } });
  for (const sql of [
    ...FILE_STORAGE_STATEMENTS,
    ...FILE_ORIGIN_STATEMENTS,
    ...FILE_SHARE_STATEMENTS,
    ...FILE_KNOWLEDGE_STATEMENTS,
    ...FILE_VERSION_STATEMENTS,
    ...FILE_DRAFT_STATEMENTS,
    ...FILE_FOLDER_STATEMENTS,
  ]) {
    await database.exec(sql);
  }

  const roles = new Map<string, string[]>();
  const ownership = new FakeFileOwnership();
  const blobRoot = await mkdtemp(join(tmpdir(), "tulip-files-routes-"));
  const blobs = new FileSystemBlobPort(blobRoot);
  const sessionStore = new MemorySessionStore();
  const userRepo = new FakeUserRepo();
  const owner = await createUser(userRepo, "owner@example.com", "pass", "member");
  const stranger = await createUser(userRepo, "stranger@example.com", "pass", "member");

  const files = new FileService({
    repo: new PgFileRepo(database as never),
    blobs,
    newId: () => randomUUID(),
    rolesOf: async (_businessId, principalId) => roles.get(principalId) ?? [],
    ownership,
  });
  const app = await buildApp({
    sessionStore,
    userRepo,
    tokenRepo: new FakeTokenRepo(),
    fileService: files,
  });

  return {
    app,
    database,
    blobRoot,
    blobs,
    files,
    roles,
    ownership,
    ownerSid: await sessionStore.create(owner._id),
    ownerId: owner._id,
    strangerSid: await sessionStore.create(stranger._id),
    strangerId: stranger._id,
  };
}

function auth(sid: string) {
  return {
    cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
    headers: { [CSRF_HEADER]: TEST_CSRF },
  };
}

function upload(
  h: Harness,
  sid: string,
  body: Buffer,
  options: {
    filename?: string;
    contentType?: string;
    declaredBytes?: number;
    folderId?: string;
  } = {}
) {
  const { headers, cookies } = auth(sid);
  const query = new URLSearchParams({ filename: options.filename ?? "shot.png" });
  if (options.folderId) query.set("folderId", options.folderId);
  return h.app.inject({
    method: "POST",
    url: `/api/v1/files?${query}`,
    cookies,
    headers: {
      ...headers,
      "content-type": options.contentType ?? "image/png",
      "content-length": String(options.declaredBytes ?? body.byteLength),
    },
    payload: body,
  });
}

describe("file routes", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await appWith();
  });

  afterEach(async () => {
    await h.app.close();
    await h.database.close();
    await rm(h.blobRoot, { recursive: true, force: true });
  });

  /*
   * A listing long enough to cross the compression threshold. The handler used to call
   * `reply.send()` and resolve `undefined`, which left Fastify unsure whether the reply had been
   * handled; once compression turned the payload into a stream that ambiguity truncated the
   * response to `content-length: 0`. Every browser sends `accept-encoding: gzip`, so the Files page
   * failed to load while `curl` — which does not — looked healthy.
   */
  it("sends a complete body when the listing is large enough to be compressed", async () => {
    for (let i = 0; i < 12; i += 1) {
      const created = await upload(h, h.ownerSid, PNG, { filename: `shot-${i}.png` });
      expect(created.statusCode).toBe(201);
    }
    const { headers, cookies } = auth(h.ownerSid);
    const plain = await h.app.inject({
      method: "GET",
      url: "/api/v1/files?limit=50",
      cookies,
      headers: { ...headers, "accept-encoding": "identity" },
    });
    const gzipped = await h.app.inject({
      method: "GET",
      url: "/api/v1/files?limit=50",
      cookies,
      headers: { ...headers, "accept-encoding": "gzip" },
    });

    expect(plain.statusCode).toBe(200);
    expect(gzipped.statusCode).toBe(200);
    expect(gzipped.headers["content-encoding"]).toBe("gzip");
    expect(gzipped.rawPayload.length).toBeGreaterThan(0);
    expect(gunzipSync(gzipped.rawPayload).toString("utf8")).toBe(plain.body);
  });

  it("accepts an image and answers with the sniffed type", async () => {
    const response = await upload(h, h.ownerSid, PNG, { contentType: "application/octet-stream" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      filename: "shot.png",
      mediaType: "image/png",
      sizeBytes: PNG.byteLength,
    });
  });

  it("creates nested folders, uploads into one, and moves a File", async () => {
    const parent = await h.app.inject({
      method: "POST",
      url: "/api/v1/file-folders",
      ...auth(h.ownerSid),
      payload: { name: "Engineering", parentId: null },
    });
    expect(parent.statusCode).toBe(201);

    const child = await h.app.inject({
      method: "POST",
      url: "/api/v1/file-folders",
      ...auth(h.ownerSid),
      payload: { name: "Reports", parentId: parent.json().id },
    });
    expect(child.statusCode).toBe(201);

    const uploaded = await upload(h, h.ownerSid, PNG, { folderId: child.json().id });
    expect(uploaded.json()).toMatchObject({ folderId: child.json().id });
    const moved = await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${uploaded.json().id}/move`,
      ...auth(h.ownerSid),
      payload: { folderId: parent.json().id, expectedRevision: 1 },
    });

    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ folderId: parent.json().id, revision: 2 });

    const folders = await h.app.inject({
      method: "GET",
      url: "/api/v1/file-folders",
      ...auth(h.ownerSid),
    });
    expect(folders.statusCode).toBe(200);
    expect(folders.json().folders).toEqual([
      expect.objectContaining({ name: "Engineering", parentId: null }),
      expect.objectContaining({ name: "Reports", parentId: parent.json().id }),
    ]);

    const strangerFolder = await h.app.inject({
      method: "POST",
      url: "/api/v1/file-folders",
      ...auth(h.strangerSid),
      payload: { name: "Private", parentId: null },
    });
    const refused = await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${uploaded.json().id}/move`,
      ...auth(h.ownerSid),
      payload: { folderId: strangerFolder.json().id, expectedRevision: 2 },
    });
    expect(refused.statusCode).toBe(404);
  });

  it("renames a folder, and refuses a name a sibling already holds", async () => {
    const folder = await h.app.inject({
      method: "POST",
      url: "/api/v1/file-folders",
      ...auth(h.ownerSid),
      payload: { name: "Enginering", parentId: null },
    });
    const sibling = await h.app.inject({
      method: "POST",
      url: "/api/v1/file-folders",
      ...auth(h.ownerSid),
      payload: { name: "Design", parentId: null },
    });

    const renamed = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/file-folders/${folder.json().id}`,
      ...auth(h.ownerSid),
      payload: { name: "Engineering" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Engineering" });

    const clash = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/file-folders/${sibling.json().id}`,
      ...auth(h.ownerSid),
      payload: { name: "engineering" },
    });
    expect(clash.statusCode).toBe(400);

    const stranger = await h.app.inject({
      method: "PATCH",
      url: `/api/v1/file-folders/${folder.json().id}`,
      ...auth(h.strangerSid),
      payload: { name: "Mine now" },
    });
    expect(stranger.statusCode).toBe(404);
  });

  it("deletes an empty folder but refuses one that still holds anything", async () => {
    const parent = await h.app.inject({
      method: "POST",
      url: "/api/v1/file-folders",
      ...auth(h.ownerSid),
      payload: { name: "Parent", parentId: null },
    });
    const child = await h.app.inject({
      method: "POST",
      url: "/api/v1/file-folders",
      ...auth(h.ownerSid),
      payload: { name: "Child", parentId: parent.json().id },
    });

    // A parent holding a nested folder must not vanish and strand it.
    const heldByChild = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/file-folders/${parent.json().id}`,
      ...auth(h.ownerSid),
    });
    expect(heldByChild.statusCode).toBe(400);

    const uploaded = await upload(h, h.ownerSid, PNG, { folderId: child.json().id });
    const heldByFile = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/file-folders/${child.json().id}`,
      ...auth(h.ownerSid),
    });
    expect(heldByFile.statusCode).toBe(400);

    await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${uploaded.json().id}/move`,
      ...auth(h.ownerSid),
      payload: { folderId: null, expectedRevision: 1 },
    });
    const emptied = await h.app.inject({
      method: "DELETE",
      url: `/api/v1/file-folders/${child.json().id}`,
      ...auth(h.ownerSid),
    });
    expect(emptied.statusCode).toBe(204);

    const remaining = await h.app.inject({
      method: "GET",
      url: "/api/v1/file-folders",
      ...auth(h.ownerSid),
    });
    expect(remaining.json().folders).toEqual([expect.objectContaining({ name: "Parent" })]);
  });

  it("creates immutable version one and points the stable File at it", async () => {
    const response = await upload(h, h.ownerSid, PNG);
    const id = response.json().id as string;
    const versions = await h.database.query(
      `SELECT version_number, reason, blob_hash FROM file_versions
         WHERE file_id = $1`,
      [id]
    );
    const files = await h.database.query(
      "SELECT current_version_id, revision, modified_at, archived_at FROM files WHERE id = $1",
      [id]
    );
    const file = files.rows[0] as {
      current_version_id: string;
      revision: number;
      modified_at: Date;
      archived_at: Date | null;
    };

    expect(versions.rows).toEqual([
      expect.objectContaining({ version_number: 1, reason: "created" }),
    ]);
    expect(file).toMatchObject({
      current_version_id: id,
      revision: 1,
      archived_at: null,
    });
    expect(file.modified_at).toBeTruthy();
  });

  async function draft() {
    return await h.files.generateDraft({
      businessId: DEPLOYMENT_BUSINESS_ID,
      creatorPrincipalId: h.ownerId,
      filename: "quarterly-summary",
      format: "json",
      content: '{"revenue":4600000}',
      authoredByAgentId: "finance-agent",
      sourceRunId: "00000000-0000-4000-8000-000000000086",
      sourceToolCallId: "call-file-create",
    });
  }

  it("lets only the creating person download a generated Chat draft", async () => {
    const created = await draft();
    const owned = await h.app.inject({
      method: "GET",
      url: `/api/v1/file-drafts/${created.id}/content`,
      ...auth(h.ownerSid),
    });
    const refused = await h.app.inject({
      method: "GET",
      url: `/api/v1/file-drafts/${created.id}/content`,
      ...auth(h.strangerSid),
    });

    expect(owned.statusCode).toBe(200);
    expect(owned.headers["content-type"]).toContain("application/json");
    expect(owned.body).toContain('"revenue": 4600000');
    expect(refused.statusCode).toBe(404);
  });

  it("saves a generated Chat draft once even when the browser retries", async () => {
    const created = await draft();
    const save = () =>
      h.app.inject({
        method: "POST",
        url: `/api/v1/file-drafts/${created.id}/save`,
        payload: {},
        ...auth(h.ownerSid),
      });

    const first = await save();
    const retried = await save();
    expect(first.statusCode).toBe(200);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().id).toBe(first.json().id);
    expect(
      (
        await h.database.query(
          "SELECT source_run_id, source_tool_call_id FROM files WHERE id = $1",
          [first.json().id]
        )
      ).rows
    ).toEqual([
      {
        source_run_id: "00000000-0000-4000-8000-000000000086",
        source_tool_call_id: "call-file-create",
      },
    ]);
  });

  it("moves an expired unsaved draft onto durable blob cleanup", async () => {
    const created = await draft();
    await h.database.query(
      "UPDATE file_generation_drafts SET expires_at = now() - interval '1 second' WHERE id = $1",
      [created.id]
    );

    expect(await h.files.cleanupExpiredDrafts()).toBe(1);
    const drafts = await h.database.query("SELECT id FROM file_generation_drafts WHERE id = $1", [
      created.id,
    ]);
    const cleanup = await h.database.query(
      "SELECT blob_hash FROM file_blob_cleanup WHERE blob_hash = $1",
      [created.blob.hash]
    );
    expect(drafts.rows).toHaveLength(0);
    expect(cleanup.rows).toHaveLength(1);
  });

  it("lets only the owner inspect immutable File versions", async () => {
    const response = await upload(h, h.ownerSid, PNG);
    const id = response.json().id as string;

    const owned = await h.app.inject({
      method: "GET",
      url: `/api/v1/files/${id}/versions`,
      ...auth(h.ownerSid),
    });
    const refused = await h.app.inject({
      method: "GET",
      url: `/api/v1/files/${id}/versions`,
      ...auth(h.strangerSid),
    });

    expect(owned.statusCode).toBe(200);
    expect(owned.json().versions).toEqual([
      expect.objectContaining({ id, versionNumber: 1, reason: "created" }),
    ]);
    expect(refused.statusCode).toBe(404);
  });

  it("refuses an anonymous upload", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/api/v1/files?filename=shot.png",
      headers: { "content-type": "image/png" },
      payload: PNG,
    });
    expect(response.statusCode).toBe(401);
  });

  // The declared length is checked before the body is read, so nothing reaches storage.
  it("refuses an oversized upload without writing anything", async () => {
    const response = await upload(h, h.ownerSid, PNG, { declaredBytes: MAX_FILE_BYTES + 1 });
    expect(response.statusCode).toBe(413);

    const hash = createHash("sha256").update(PNG).digest("hex");
    expect(await h.blobs.head({ key: hash, hash })).toBeNull();
  });

  it("refuses a file whose real type contradicts its declared type", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const response = await upload(h, h.ownerSid, html, { contentType: "image/png" });
    expect(response.statusCode).toBe(415);
  });

  it("refuses SVG", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const response = await upload(h, h.ownerSid, svg, {
      contentType: "image/svg+xml",
      filename: "logo.svg",
    });
    expect(response.statusCode).toBe(415);
  });

  it("refuses an empty body", async () => {
    const response = await upload(h, h.ownerSid, Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
  });

  it("keeps a traversal-shaped filename out of the storage key", async () => {
    const created = await upload(h, h.ownerSid, PNG, { filename: "../../etc/shadow.png" });
    expect(created.json().filename).toBe("shadow.png");

    const content = await h.app.inject({
      method: "GET",
      url: `/api/v1/files/${created.json().id}/content`,
      ...auth(h.ownerSid),
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-disposition"]).toContain('filename="shadow.png"');
  });

  it("serves the sniffed type inline for an image, with sniffing disabled", async () => {
    const created = await upload(h, h.ownerSid, PNG, { contentType: "application/octet-stream" });
    const response = await h.app.inject({
      method: "GET",
      url: `/api/v1/files/${created.json().id}/content`,
      ...auth(h.ownerSid),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload.equals(PNG)).toBe(true);
  });

  // Anything that is not an image gets a script context if the browser renders it on our origin.
  it("serves a non-image as an attachment, never inline", async () => {
    const text = Buffer.from("id,name\n1,ada\n");
    const created = await upload(h, h.ownerSid, text, {
      contentType: "text/csv",
      filename: "rows.csv",
    });
    const response = await h.app.inject({
      method: "GET",
      url: `/api/v1/files/${created.json().id}/content`,
      ...auth(h.ownerSid),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.rawPayload.equals(text)).toBe(true);
  });

  it("refuses a second person the bytes of a File they do not own", async () => {
    const created = await upload(h, h.ownerSid, PNG);
    const response = await h.app.inject({
      method: "GET",
      url: `/api/v1/files/${created.json().id}/content`,
      ...auth(h.strangerSid),
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a second person the metadata too", async () => {
    const created = await upload(h, h.ownerSid, PNG);
    const response = await h.app.inject({
      method: "GET",
      url: `/api/v1/files/${created.json().id}`,
      ...auth(h.strangerSid),
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists only the caller's own Files", async () => {
    await upload(h, h.ownerSid, PNG);
    const mine = await h.app.inject({ method: "GET", url: "/api/v1/files", ...auth(h.ownerSid) });
    const theirs = await h.app.inject({
      method: "GET",
      url: "/api/v1/files",
      ...auth(h.strangerSid),
    });

    expect(mine.json().files).toHaveLength(1);
    expect(theirs.json().files).toHaveLength(0);
  });

  it("searches filenames across owned and shared Files without exposing inaccessible Files", async () => {
    const owned = await upload(h, h.ownerSid, PNG, { filename: "pricing-owned.png" });
    const shared = await upload(h, h.strangerSid, PNG, { filename: "pricing-shared.png" });
    await upload(h, h.strangerSid, PNG, { filename: "pricing-private.png" });
    const { headers, cookies } = auth(h.strangerSid);
    await h.app.inject({
      method: "POST",
      url: `/api/v1/files/${shared.json().id}/shares`,
      cookies,
      headers: { ...headers, "content-type": "application/json" },
      payload: { kind: "user", id: h.ownerId },
    });

    const response = await h.app.inject({
      method: "GET",
      url: "/api/v1/files/search?q=PRICING",
      ...auth(h.ownerSid),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().files.map((file: { id: string }) => file.id)).toEqual(
      expect.arrayContaining([owned.json().id, shared.json().id])
    );
    expect(response.json().files).toHaveLength(2);
  });

  it("says who owns a File and where it came from, so the library can label it", async () => {
    await upload(h, h.ownerSid, PNG);
    const response = await h.app.inject({
      method: "GET",
      url: "/api/v1/files",
      ...auth(h.ownerSid),
    });

    expect(response.json().files[0]).toMatchObject({
      owner: h.ownerId,
      ownerName: "owner@example.com",
      origin: "uploaded",
    });
    expect(response.json().files[0].sourceChatId).toBeNull();
  });

  it("pages with a cursor rather than an offset, so a new upload cannot duplicate a row", async () => {
    for (let i = 0; i < 3; i += 1) await upload(h, h.ownerSid, PNG, { filename: `p${i}.png` });

    const first = await h.app.inject({
      method: "GET",
      url: "/api/v1/files?limit=2",
      ...auth(h.ownerSid),
    });
    expect(first.json().files).toHaveLength(2);
    expect(first.json().nextCursor).toBeTruthy();

    // A File arriving between pages sorts ahead of the cursor, so it cannot reshuffle page two.
    await upload(h, h.ownerSid, PNG, { filename: "late.png" });

    const second = await h.app.inject({
      method: "GET",
      url: `/api/v1/files?limit=2&after=${encodeURIComponent(first.json().nextCursor)}`,
      ...auth(h.ownerSid),
    });
    const seen = [...first.json().files, ...second.json().files].map((f: { id: string }) => f.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(second.json().files).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
  });

  it("refuses a cursor it did not issue instead of silently paging from the top", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: "/api/v1/files?after=not-a-real-cursor",
      ...auth(h.ownerSid),
    });
    expect(response.statusCode).toBe(400);
  });

  // A route with no schema is absent from the generated document, which is how one ships unnoticed.
  it("publishes every file route in the OpenAPI document", async () => {
    const response = await h.app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const paths = response.json().paths as Record<string, Record<string, unknown>>;

    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/files",
        "/api/v1/file-folders",
        "/api/v1/files/search",
        "/api/v1/files/{id}",
        "/api/v1/files/{id}/versions",
        "/api/v1/files/{id}/versions/{versionId}/content",
        "/api/v1/files/{id}/versions/{versionId}/restore",
        "/api/v1/files/{id}/archive",
        "/api/v1/files/{id}/restore",
        "/api/v1/files/{id}/move",
        "/api/v1/files/{id}/content",
        "/api/v1/files/accepted-modalities",
      ])
    );
    // Named individually: an undocumented destructive route is the one a caller most needs the
    // schema for, and `arrayContaining` on the path alone would not notice it missing a verb.
    expect(Object.keys(paths["/api/v1/files/{id}"])).toEqual(
      expect.arrayContaining(["get", "delete"])
    );
    expect(Object.keys(paths["/api/v1/files/{id}/content"])).toEqual(
      expect.arrayContaining(["get", "put"])
    );
    expect(Object.keys(paths["/api/v1/files"].post as object)).toContain("responses");
    const post = paths["/api/v1/files"].post as { responses: Record<string, unknown> };
    expect(Object.keys(post.responses)).toEqual(
      expect.arrayContaining(["201", "400", "401", "403", "413", "415"])
    );
  });
  describe("accepted modalities", () => {
    it("reports text only for an instance with no models configured", async () => {
      const response = await h.app.inject({
        method: "GET",
        url: "/api/v1/files/accepted-modalities",
        ...auth(h.ownerSid),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().acceptedInputModalities).toEqual(["text"]);
    });

    it("does not answer an unauthenticated caller", async () => {
      const response = await h.app.inject({
        method: "GET",
        url: "/api/v1/files/accepted-modalities",
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("sharing", () => {
    async function share(sid: string, id: string, body: { kind: string; id: string }) {
      const { headers, cookies } = auth(sid);
      return await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/shares`,
        cookies,
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
    }

    async function ownedFile(): Promise<string> {
      return JSON.parse((await upload(h, h.ownerSid, PNG)).body).id as string;
    }

    it("lets a stranger read a File only after its owner shares it", async () => {
      const id = await ownedFile();

      const before = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(before.statusCode).toBe(404);

      expect((await share(h.ownerSid, id, { kind: "user", id: h.strangerId })).statusCode).toBe(
        204
      );

      const after = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(after.statusCode).toBe(200);
      expect(JSON.parse(after.body).id).toBe(id);
    });

    it("reads Team-owned Files through the same gate and revokes on the next request", async () => {
      const id = await ownedFile();
      h.ownership.records.set(id, {
        businessId: DEPLOYMENT_BUSINESS_ID,
        assetType: "file",
        assetId: id,
        owners: [{ kind: "team", teamId: "team-support" }],
        shares: [],
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      h.ownership.teamAccess.set("team-support", new Set([h.strangerId]));

      const allowed = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(allowed.statusCode).toBe(200);

      h.ownership.teamAccess.get("team-support")?.delete(h.strangerId);
      const revoked = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(revoked.statusCode).toBe(404);
    });

    it("stops the stranger reading the bytes the moment the share is revoked", async () => {
      const id = await ownedFile();
      await share(h.ownerSid, id, { kind: "user", id: h.strangerId });

      const granted = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}/content`,
        ...auth(h.strangerSid),
      });
      expect(granted.statusCode).toBe(200);

      const { headers, cookies } = auth(h.ownerSid);
      const revoked = await h.app.inject({
        method: "DELETE",
        url: `/api/v1/files/${id}/shares/user/${h.strangerId}`,
        cookies,
        headers,
      });
      expect(revoked.statusCode).toBe(204);

      const after = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}/content`,
        ...auth(h.strangerSid),
      });
      expect(after.statusCode).toBe(404);
    });

    it("resolves a Role share against the Roles the reader holds on this request", async () => {
      const id = await ownedFile();
      await share(h.ownerSid, id, { kind: "role", id: "support" });

      const withoutRole = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(withoutRole.statusCode).toBe(404);

      h.roles.set(h.strangerId, ["support"]);
      const withRole = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(withRole.statusCode).toBe(200);

      // Losing the Role removes the File on the very next request: nothing was expanded at share
      // time, so there is no stale grant to wait out.
      h.roles.set(h.strangerId, []);
      const lost = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(lost.statusCode).toBe(404);
    });

    it("refuses to let a recipient re-share, or see who else holds the File", async () => {
      const id = await ownedFile();
      await share(h.ownerSid, id, { kind: "user", id: h.strangerId });

      const reshared = await share(h.strangerSid, id, { kind: "role", id: "everyone" });
      expect(reshared.statusCode).toBe(404);

      const shares = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}/shares`,
        ...auth(h.strangerSid),
      });
      expect(shares.statusCode).toBe(404);

      const owned = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}/shares`,
        ...auth(h.ownerSid),
      });
      expect(owned.statusCode).toBe(200);
      expect(JSON.parse(owned.body).shares).toEqual([
        { kind: "user", id: h.strangerId, sharedBy: h.ownerId, sharedAt: expect.any(String) },
      ]);
    });

    it("answers a share of a File the caller does not own exactly as a missing File", async () => {
      const id = await ownedFile();
      expect((await share(h.strangerSid, id, { kind: "user", id: "someone" })).statusCode).toBe(
        404
      );
      expect(
        (
          await share(h.strangerSid, "00000000-0000-4000-8000-000000000000", {
            kind: "user",
            id: "someone",
          })
        ).statusCode
      ).toBe(404);
    });

    it("says on the listing how many grants a File carries, and never for one you do not own", async () => {
      const id = await ownedFile();
      await share(h.ownerSid, id, { kind: "user", id: h.strangerId });
      await share(h.ownerSid, id, { kind: "role", id: "support" });

      const owned = await h.app.inject({
        method: "GET",
        url: "/api/v1/files",
        ...auth(h.ownerSid),
      });
      expect(JSON.parse(owned.body).files[0].sharedWithCount).toBe(2);

      // The recipient sees the same File on their own listing, with the count withheld — how many
      // others hold it is the owner's business, and 0 would be a different and false answer.
      const received = await h.app.inject({
        method: "GET",
        url: "/api/v1/files/shared-with-me",
        ...auth(h.strangerSid),
      });
      expect(JSON.parse(received.body).files[0].sharedWithCount).toBeNull();
    });

    it("lists a File once when two grants the caller holds both reach it", async () => {
      // Direct share plus a Role share is two rows in `file_shares` for one reader. A join would
      // emit the File twice, which both repeats it and pushes a different File off the page.
      const first = JSON.parse((await upload(h, h.strangerSid, PNG)).body).id as string;
      const second = JSON.parse((await upload(h, h.strangerSid, PNG)).body).id as string;
      await share(h.strangerSid, first, { kind: "user", id: h.ownerId });
      await share(h.strangerSid, first, { kind: "role", id: "support" });
      await share(h.strangerSid, second, { kind: "user", id: h.ownerId });
      h.roles.set(h.ownerId, ["support"]);

      const page = await h.app.inject({
        method: "GET",
        url: "/api/v1/files/shared-with-me?limit=2",
        ...auth(h.ownerSid),
      });
      expect(page.statusCode).toBe(200);
      const body = JSON.parse(page.body) as { files: { id: string }[]; nextCursor: string | null };
      expect(body.files.map((f) => f.id).sort()).toEqual([first, second].sort());
      expect(body.nextCursor).toBeNull();
    });

    it("lists Files shared with the caller, and never the caller's own", async () => {
      const mine = await ownedFile();
      const theirs = JSON.parse((await upload(h, h.strangerSid, PNG)).body).id as string;
      await share(h.strangerSid, theirs, { kind: "user", id: h.ownerId });

      const response = await h.app.inject({
        method: "GET",
        url: "/api/v1/files/shared-with-me",
        ...auth(h.ownerSid),
      });
      expect(response.statusCode).toBe(200);
      const ids = JSON.parse(response.body).files.map((f: { id: string }) => f.id);
      expect(ids).toEqual([theirs]);
      expect(ids).not.toContain(mine);
    });
  });
  describe("version lifecycle", () => {
    async function replace(
      sid: string,
      id: string,
      expectedRevision: number,
      body: Buffer,
      contentType: string
    ) {
      const { headers, cookies } = auth(sid);
      return await h.app.inject({
        method: "PUT",
        url: `/api/v1/files/${id}/content?expectedRevision=${expectedRevision}`,
        cookies,
        headers: {
          ...headers,
          "content-type": contentType,
          "content-length": String(body.byteLength),
        },
        payload: body,
      });
    }

    it("atomically replaces same-format content and keeps legacy columns synchronized", async () => {
      const originalBytes = Buffer.from("one");
      const original = await upload(h, h.ownerSid, originalBytes, {
        filename: "notes.txt",
        contentType: "text/plain",
      });
      const id = original.json().id as string;
      const replacementBytes = Buffer.from("two");

      const response = await replace(h.ownerSid, id, 1, replacementBytes, "text/plain");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id, revision: 2, sizeBytes: 3 });
      const versions = await h.database.query<{
        version_number: number;
        reason: string;
        blob_hash: string;
      }>(
        `SELECT version_number, reason, blob_hash FROM file_versions
         WHERE file_id = $1 ORDER BY version_number`,
        [id]
      );
      const file = await h.database.query<{
        current_version_id: string;
        media_type: string;
        size_bytes: number;
        blob_hash: string;
      }>(
        `SELECT current_version_id, media_type, size_bytes, blob_hash
         FROM files WHERE id = $1`,
        [id]
      );
      expect(versions.rows.map((version) => version.reason)).toEqual(["created", "replaced"]);
      expect(file.rows[0]).toMatchObject({
        current_version_id: expect.not.stringMatching(id),
        media_type: "text/plain",
        size_bytes: 3,
        blob_hash: versions.rows[1]?.blob_hash,
      });
    });

    it("rejects stale and cross-format replacements without appending history", async () => {
      const original = await upload(h, h.ownerSid, Buffer.from("one"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
      const id = original.json().id as string;

      expect((await replace(h.ownerSid, id, 2, Buffer.from("two"), "text/plain")).statusCode).toBe(
        409
      );
      expect((await replace(h.ownerSid, id, 1, PNG, "image/png")).statusCode).toBe(415);

      const versions = await h.database.query("SELECT id FROM file_versions WHERE file_id = $1", [
        id,
      ]);
      expect(versions.rows).toHaveLength(1);
    });

    it("restores an old version as a new latest version without copying bytes", async () => {
      const original = await upload(h, h.ownerSid, Buffer.from("one"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
      const id = original.json().id as string;
      const firstVersionId = id;
      expect((await replace(h.ownerSid, id, 1, Buffer.from("two"), "text/plain")).statusCode).toBe(
        200
      );

      const restored = await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/versions/${firstVersionId}/restore`,
        ...auth(h.ownerSid),
        payload: { expectedRevision: 2 },
      });

      expect(restored.statusCode).toBe(200);
      expect(restored.json().revision).toBe(3);
      const versions = await h.database.query<{
        version_number: number;
        reason: string;
        blob_hash: string;
        restored_from_version_id: string | null;
      }>(
        `SELECT version_number, reason, blob_hash, restored_from_version_id
         FROM file_versions WHERE file_id = $1 ORDER BY version_number`,
        [id]
      );
      expect(versions.rows[2]).toMatchObject({
        version_number: 3,
        reason: "restored",
        blob_hash: versions.rows[0]?.blob_hash,
        restored_from_version_id: firstVersionId,
      });
      const content = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}/content`,
        ...auth(h.ownerSid),
      });
      expect(content.rawPayload.equals(Buffer.from("one"))).toBe(true);
    });

    it("lets only the owner download historical version bytes", async () => {
      const original = await upload(h, h.ownerSid, Buffer.from("one"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
      const id = original.json().id as string;
      await replace(h.ownerSid, id, 1, Buffer.from("two"), "text/plain");

      const owned = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}/versions/${id}/content`,
        ...auth(h.ownerSid),
      });
      const refused = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}/versions/${id}/content`,
        ...auth(h.strangerSid),
      });

      expect(owned.statusCode).toBe(200);
      expect(owned.rawPayload.equals(Buffer.from("one"))).toBe(true);
      expect(refused.statusCode).toBe(404);
    });
  });

  describe("archive lifecycle", () => {
    async function archive(sid: string, id: string, expectedRevision: number) {
      return await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/archive`,
        ...auth(sid),
        payload: { expectedRevision },
      });
    }

    it("hides an archived File from discovery while current readers can still open it", async () => {
      const created = await upload(h, h.ownerSid, PNG, { filename: "archived.png" });
      const id = created.json().id as string;
      const { headers, cookies } = auth(h.ownerSid);
      await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/shares`,
        cookies,
        headers: { ...headers, "content-type": "application/json" },
        payload: { kind: "user", id: h.strangerId },
      });

      const archived = await archive(h.ownerSid, id, 1);

      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ revision: 2, archivedAt: expect.any(String) });
      const listed = await h.app.inject({
        method: "GET",
        url: "/api/v1/files",
        ...auth(h.ownerSid),
      });
      const searched = await h.app.inject({
        method: "GET",
        url: "/api/v1/files/search?q=archived",
        ...auth(h.ownerSid),
      });
      expect(listed.json().files).toEqual([]);
      expect(searched.json().files).toEqual([]);
      expect(
        (
          await h.app.inject({
            method: "GET",
            url: `/api/v1/files/${id}/content`,
            ...auth(h.strangerSid),
          })
        ).statusCode
      ).toBe(200);
    });

    it("restores an archived File and rejects stale lifecycle writes", async () => {
      const created = await upload(h, h.ownerSid, PNG);
      const id = created.json().id as string;
      expect((await archive(h.ownerSid, id, 2)).statusCode).toBe(409);
      expect((await archive(h.ownerSid, id, 1)).statusCode).toBe(200);

      const restored = await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/restore`,
        ...auth(h.ownerSid),
        payload: { expectedRevision: 2 },
      });

      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ revision: 3, archivedAt: null });
      const listed = await h.app.inject({
        method: "GET",
        url: "/api/v1/files",
        ...auth(h.ownerSid),
      });
      expect(listed.json().files).toHaveLength(1);
    });

    it("lists only the caller's own archived Files", async () => {
      const mine = await upload(h, h.ownerSid, PNG, { filename: "mine.png" });
      const theirs = await upload(h, h.strangerSid, PNG, { filename: "theirs.png" });
      await archive(h.ownerSid, mine.json().id, mine.json().revision);
      await archive(h.strangerSid, theirs.json().id, theirs.json().revision);

      const response = await h.app.inject({
        method: "GET",
        url: "/api/v1/files/archived",
        ...auth(h.ownerSid),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().files).toEqual([
        expect.objectContaining({
          id: mine.json().id,
          filename: "mine.png",
          archivedAt: expect.any(String),
        }),
      ]);
    });
  });

  describe("deleting", () => {
    async function ownedFile(filename = "shot.png"): Promise<{ id: string; revision: number }> {
      return JSON.parse((await upload(h, h.ownerSid, PNG, { filename })).body) as {
        id: string;
        revision: number;
      };
    }

    async function archive(id: string, expectedRevision: number) {
      return await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/archive`,
        ...auth(h.ownerSid),
        payload: { expectedRevision },
      });
    }

    async function destroy(sid: string, id: string, expectedRevision: number) {
      const { headers, cookies } = auth(sid);
      return await h.app.inject({
        method: "DELETE",
        url: `/api/v1/files/${id}?expectedRevision=${expectedRevision}`,
        cookies,
        headers,
      });
    }

    it("requires archive, then removes the row and bytes durably", async () => {
      const file = await ownedFile();
      const id = file.id;
      const hash = createHash("sha256").update(PNG).digest("hex");

      expect((await destroy(h.ownerSid, id, file.revision)).statusCode).toBe(409);
      const archived = await archive(id, file.revision);
      expect((await destroy(h.ownerSid, id, archived.json().revision)).statusCode).toBe(204);

      expect(await h.blobs.head({ key: hash, hash })).toBeNull();
      const after = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.ownerSid),
      });
      expect(after.statusCode).toBe(404);
      expect((await destroy(h.ownerSid, id, archived.json().revision)).statusCode).toBe(404);
    });

    it("refuses a stranger, and refuses a recipient the File was shared with", async () => {
      const file = await ownedFile();
      const id = file.id;
      const { headers, cookies } = auth(h.ownerSid);
      await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/shares`,
        cookies,
        headers: { ...headers, "content-type": "application/json" },
        payload: { kind: "user", id: h.strangerId },
      });
      const archived = await archive(id, file.revision);

      expect((await destroy(h.strangerSid, id, archived.json().revision)).statusCode).toBe(404);

      const still = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(still.statusCode).toBe(200);
    });

    it("takes the share rows with it, so no grant outlives the File", async () => {
      const file = await ownedFile();
      const id = file.id;
      const { headers, cookies } = auth(h.ownerSid);
      await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/shares`,
        cookies,
        headers: { ...headers, "content-type": "application/json" },
        payload: { kind: "user", id: h.strangerId },
      });

      const archived = await archive(id, file.revision);
      await destroy(h.ownerSid, id, archived.json().revision);

      const rows = await h.database.query("SELECT 1 FROM file_shares WHERE file_id = $1", [id]);
      expect(rows.rows).toHaveLength(0);
    });

    it("refuses an anonymous delete", async () => {
      const { id } = await ownedFile();
      const response = await h.app.inject({
        method: "DELETE",
        url: `/api/v1/files/${id}?expectedRevision=1`,
      });
      expect(response.statusCode).toBe(401);
    });

    // Deduplication and deletion are the same fact seen twice: identical bytes are one object, so
    // destroying one File must never reach into another's.
    it("leaves a byte-identical File owned by someone else readable", async () => {
      const mine = await ownedFile();
      const theirs = JSON.parse((await upload(h, h.strangerSid, PNG)).body).id as string;

      const archived = await archive(mine.id, mine.revision);
      expect((await destroy(h.ownerSid, mine.id, archived.json().revision)).statusCode).toBe(204);

      const response = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${theirs}/content`,
        ...auth(h.strangerSid),
      });
      expect(response.statusCode).toBe(200);
      expect(Buffer.from(response.rawPayload).equals(PNG)).toBe(true);
    });

    it("drops a destroyed File out of the owner's library listing", async () => {
      const kept = await ownedFile("kept.png");
      const gone = JSON.parse(
        (await upload(h, h.ownerSid, Buffer.from([...PNG, 9]), { filename: "gone.png" })).body
      ) as { id: string; revision: number };

      const archived = await archive(gone.id, gone.revision);
      await destroy(h.ownerSid, gone.id, archived.json().revision);

      const page = await h.app.inject({
        method: "GET",
        url: "/api/v1/files",
        ...auth(h.ownerSid),
      });
      const ids = page.json().files.map((file: { id: string }) => file.id);
      expect(ids).toContain(kept.id);
      expect(ids).not.toContain(gone.id);
    });

    it("cleans every unreferenced historical blob after permanent deletion", async () => {
      const created = await upload(h, h.ownerSid, Buffer.from("one"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
      const id = created.json().id as string;
      const { headers, cookies } = auth(h.ownerSid);
      await h.app.inject({
        method: "PUT",
        url: `/api/v1/files/${id}/content?expectedRevision=1`,
        cookies,
        headers: {
          ...headers,
          "content-type": "text/plain",
          "content-length": "3",
        },
        payload: Buffer.from("two"),
      });
      const versions = await h.database.query<{ blob_key: string; blob_hash: string }>(
        "SELECT blob_key, blob_hash FROM file_versions WHERE file_id = $1 ORDER BY version_number",
        [id]
      );
      const archived = await archive(id, 2);

      expect((await destroy(h.ownerSid, id, archived.json().revision)).statusCode).toBe(204);
      for (const version of versions.rows) {
        expect(await h.blobs.head({ key: version.blob_key, hash: version.blob_hash })).toBeNull();
      }
      const pending = await h.database.query("SELECT 1 FROM file_blob_cleanup");
      expect(pending.rows).toHaveLength(0);
    });

    it("retains failed cleanup work and succeeds on a later retry", async () => {
      const created = await ownedFile();
      const archived = await archive(created.id, created.revision);
      const realDelete = h.blobs.delete.bind(h.blobs);
      h.blobs.delete = async () => {
        throw new Error("storage unavailable");
      };

      expect((await destroy(h.ownerSid, created.id, archived.json().revision)).statusCode).toBe(
        204
      );
      expect(
        (await h.database.query("SELECT attempts, last_error FROM file_blob_cleanup")).rows
      ).toEqual([expect.objectContaining({ attempts: 1, last_error: "storage unavailable" })]);

      h.blobs.delete = realDelete;
      await h.database.query("UPDATE file_blob_cleanup SET next_attempt_at = now()");
      await h.files.cleanupBlobs("test-retry");

      expect((await h.database.query("SELECT 1 FROM file_blob_cleanup")).rows).toHaveLength(0);
    });
  });
});
