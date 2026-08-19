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
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  FILE_ORIGIN_STATEMENTS,
  FILE_SHARE_STATEMENTS,
  FILE_STORAGE_STATEMENTS,
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

interface Harness {
  app: FastifyInstance;
  database: PGlite;
  blobRoot: string;
  blobs: FileSystemBlobPort;
  roles: Map<string, string[]>;
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
  ]) {
    await database.exec(sql);
  }

  const roles = new Map<string, string[]>();
  const blobRoot = await mkdtemp(join(tmpdir(), "tulip-files-routes-"));
  const blobs = new FileSystemBlobPort(blobRoot);
  const sessionStore = new MemorySessionStore();
  const userRepo = new FakeUserRepo();
  const owner = await createUser(userRepo, "owner@example.com", "pass", "member");
  const stranger = await createUser(userRepo, "stranger@example.com", "pass", "member");

  const app = await buildApp({
    sessionStore,
    userRepo,
    tokenRepo: new FakeTokenRepo(),
    fileService: new FileService({
      repo: new PgFileRepo(database as never),
      blobs,
      newId: () => randomUUID(),
      rolesOf: async (_businessId, principalId) => roles.get(principalId) ?? [],
    }),
  });

  return {
    app,
    database,
    blobRoot,
    blobs,
    roles,
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
  options: { filename?: string; contentType?: string; declaredBytes?: number } = {}
) {
  const { headers, cookies } = auth(sid);
  return h.app.inject({
    method: "POST",
    url: `/api/v1/files?filename=${encodeURIComponent(options.filename ?? "shot.png")}`,
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

  it("accepts an image and answers with the sniffed type", async () => {
    const response = await upload(h, h.ownerSid, PNG, { contentType: "application/octet-stream" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      filename: "shot.png",
      mediaType: "image/png",
      sizeBytes: PNG.byteLength,
    });
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

  it("says who owns a File and where it came from, so the library can label it", async () => {
    await upload(h, h.ownerSid, PNG);
    const response = await h.app.inject({
      method: "GET",
      url: "/api/v1/files",
      ...auth(h.ownerSid),
    });

    expect(response.json().files[0]).toMatchObject({ owner: h.ownerId, origin: "uploaded" });
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
        "/api/v1/files/{id}",
        "/api/v1/files/{id}/content",
        "/api/v1/files/accepted-modalities",
      ])
    );
    // Named individually: an undocumented destructive route is the one a caller most needs the
    // schema for, and `arrayContaining` on the path alone would not notice it missing a verb.
    expect(Object.keys(paths["/api/v1/files/{id}"])).toEqual(
      expect.arrayContaining(["get", "delete"])
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
  describe("deleting", () => {
    async function ownedFile(filename = "shot.png"): Promise<string> {
      return JSON.parse((await upload(h, h.ownerSid, PNG, { filename })).body).id as string;
    }

    async function destroy(sid: string, id: string) {
      const { headers, cookies } = auth(sid);
      return await h.app.inject({ method: "DELETE", url: `/api/v1/files/${id}`, cookies, headers });
    }

    it("removes the row and the bytes, and a second attempt reads as never having existed", async () => {
      const id = await ownedFile();
      const hash = createHash("sha256").update(PNG).digest("hex");

      expect((await destroy(h.ownerSid, id)).statusCode).toBe(204);

      expect(await h.blobs.head({ key: hash, hash })).toBeNull();
      const after = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.ownerSid),
      });
      expect(after.statusCode).toBe(404);
      expect((await destroy(h.ownerSid, id)).statusCode).toBe(404);
    });

    it("refuses a stranger, and refuses a recipient the File was shared with", async () => {
      const id = await ownedFile();
      const { headers, cookies } = auth(h.ownerSid);
      await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/shares`,
        cookies,
        headers: { ...headers, "content-type": "application/json" },
        payload: { kind: "user", id: h.strangerId },
      });

      expect((await destroy(h.strangerSid, id)).statusCode).toBe(404);

      const still = await h.app.inject({
        method: "GET",
        url: `/api/v1/files/${id}`,
        ...auth(h.strangerSid),
      });
      expect(still.statusCode).toBe(200);
    });

    it("takes the share rows with it, so no grant outlives the File", async () => {
      const id = await ownedFile();
      const { headers, cookies } = auth(h.ownerSid);
      await h.app.inject({
        method: "POST",
        url: `/api/v1/files/${id}/shares`,
        cookies,
        headers: { ...headers, "content-type": "application/json" },
        payload: { kind: "user", id: h.strangerId },
      });

      await destroy(h.ownerSid, id);

      const rows = await h.database.query("SELECT 1 FROM file_shares WHERE file_id = $1", [id]);
      expect(rows.rows).toHaveLength(0);
    });

    it("refuses an anonymous delete", async () => {
      const id = await ownedFile();
      const response = await h.app.inject({ method: "DELETE", url: `/api/v1/files/${id}` });
      expect(response.statusCode).toBe(401);
    });

    // Deduplication and deletion are the same fact seen twice: identical bytes are one object, so
    // destroying one File must never reach into another's.
    it("leaves a byte-identical File owned by someone else readable", async () => {
      const mine = await ownedFile();
      const theirs = JSON.parse((await upload(h, h.strangerSid, PNG)).body).id as string;

      expect((await destroy(h.ownerSid, mine)).statusCode).toBe(204);

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
      ).id as string;

      await destroy(h.ownerSid, gone);

      const page = await h.app.inject({
        method: "GET",
        url: "/api/v1/files",
        ...auth(h.ownerSid),
      });
      const ids = page.json().files.map((file: { id: string }) => file.id);
      expect(ids).toContain(kept);
      expect(ids).not.toContain(gone);
    });
  });
});
