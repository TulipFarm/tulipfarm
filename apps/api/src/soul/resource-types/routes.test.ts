import type { GitSyncService, SoulLoader, SoulResource } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import type { TokenDoc, TokenRepo } from "../../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../../auth/csrf";
import { SESSION_COOKIE } from "../../auth/middleware";
import { MemorySessionStore } from "../../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../../auth/users";
import type { PaginatedResult } from "../../pagination";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { existsSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";

const TEST_CSRF = "a".repeat(64);

const VALID_SCHEMA_YAML = `type: object
properties:
  title:
    type: string
required:
  - title
`;

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((u) => u.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(user: UserDoc): Promise<void> {
    this.users.push(user);
  }
}

class FakeTokenRepo implements TokenRepo {
  private tokens: TokenDoc[] = [];
  async create(token: TokenDoc): Promise<void> {
    this.tokens.push(token);
  }
  async findByHash(hash: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }
  async findByUserId(userId: string): Promise<TokenDoc[]> {
    return this.tokens.filter((t) => t.userId === userId);
  }
  async findAll(): Promise<TokenDoc[]> {
    return [...this.tokens];
  }
  async findById(id: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t._id === id) ?? null;
  }
  async deleteById(id: string): Promise<void> {
    this.tokens = this.tokens.filter((t) => t._id !== id);
  }
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

function makeFakeGitSync(soulPath = "/fake/soul"): GitSyncService {
  return {
    path: soulPath,
    commit: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 1 }),
    push: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
  } as unknown as GitSyncService;
}

function makeFakeSoulLoader(resources: SoulResource[] = []): SoulLoader {
  return {
    resources: new Map(resources.map((r) => [r.name, r])),
    reload: vi.fn().mockResolvedValue(undefined),
  } as unknown as SoulLoader;
}

describe("resource-type routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let gitSync: GitSyncService;
  let soulLoader: SoulLoader;
  let sid: string;
  let adminSid: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);

    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    gitSync = makeFakeGitSync();
    soulLoader = makeFakeSoulLoader();

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    adminSid = await store.create(admin._id);

    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync, soulLoader });
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /api/v1/resource-types", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        payload: { name: "ticket", schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(401);
    });

    it("creates resource type — writes raw YAML, commits, reloads, returns YAML schema", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "ticket", schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ name: "ticket", schema: VALID_SCHEMA_YAML, hasHooks: false });
      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("resources/ticket"), {
        recursive: true,
      });
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("schema.yml"),
        VALID_SCHEMA_YAML,
        "utf8"
      );
      expect(gitSync.commit).toHaveBeenCalledWith(
        "soul: add resource type ticket",
        expect.objectContaining({ email: "user@example.com" })
      );
      expect(soulLoader.reload).toHaveBeenCalledOnce();
    });

    it("returns 400 for empty name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "", schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid resource type name" });
    });

    it("returns 400 for name with uppercase", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "MyType", schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid resource type name" });
    });

    it("returns 400 for name starting with digit", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "123bad", schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid resource type name" });
    });

    it("returns 409 if resource type already exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "ticket", schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "resource type already exists" });
      expect(mkdir).not.toHaveBeenCalled();
    });

    it("returns 422 for invalid YAML", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "ticket", schema: "{ unclosed: [bracket" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("invalid YAML") });
      expect(mkdir).not.toHaveBeenCalled();
    });

    it("returns 422 for YAML that is not an object", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "ticket", schema: "- item1\n- item2\n" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("YAML object") });
      expect(mkdir).not.toHaveBeenCalled();
    });

    it("returns 422 for invalid JSON Schema (type must be string)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "ticket", schema: "type: 123\n" },
      });
      expect(res.statusCode).toBe(422);
      expect(mkdir).not.toHaveBeenCalled();
    });

    it("returns 422 for unknown x-normalize value", async () => {
      const yaml = `type: object
properties:
  phone:
    type: string
    x-normalize:
      - unknown-normalizer
`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "ticket", schema: yaml },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining("unknown normalizer"),
        boundary: "resource",
      });
      expect(mkdir).not.toHaveBeenCalled();
    });

    it("returns 422 for unknown x-computed fn", async () => {
      const yaml = `type: object
x-computed:
  - field: digest
    from:
      - title
    fn: unknown-fn
`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { name: "ticket", schema: yaml },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining("unknown computed fn"),
        boundary: "resource",
      });
    });
  });

  describe("GET /api/v1/resource-types", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/resource-types" });
      expect(res.statusCode).toBe(401);
    });

    it("returns empty types array when no resources loaded", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ types: [] });
    });

    it("returns resource types with YAML schema strings", async () => {
      await app.close();
      soulLoader = makeFakeSoulLoader([
        { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
        { name: "customer", schema: { type: "object" }, hasHooks: true, hooksEnabled: true },
      ]);
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync, soulLoader });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resource-types",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      const { types } = res.json<{
        types: { name: string; schema: string; hasHooks: boolean }[];
      }>();
      expect(types).toHaveLength(2);
      const ticket = types.find((t) => t.name === "ticket");
      const customer = types.find((t) => t.name === "customer");
      expect(ticket?.hasHooks).toBe(false);
      expect(ticket?.schema).toContain("type: object");
      expect(customer?.hasHooks).toBe(true);
      expect(customer?.schema).toContain("type: object");
    });
  });

  describe("PUT /api/v1/resource-types/:name", () => {
    const put = (payload: { schema: string }) => ({
      method: "PUT" as const,
      url: "/api/v1/resource-types/ticket",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload,
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/resource-types/ticket",
        payload: { schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 when the type does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const res = await app.inject(put({ schema: VALID_SCHEMA_YAML }));
      expect(res.statusCode).toBe(404);
    });

    it("updates the schema — writes YAML, commits, reloads", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const res = await app.inject(put({ schema: VALID_SCHEMA_YAML }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "ticket", schema: VALID_SCHEMA_YAML });
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("schema.yml"),
        VALID_SCHEMA_YAML,
        "utf8"
      );
      expect(gitSync.commit).toHaveBeenCalledWith(
        "soul: update resource type ticket",
        expect.objectContaining({ email: "user@example.com" })
      );
      expect(soulLoader.reload).toHaveBeenCalledOnce();
    });

    it("returns 422 for a schema that is not a YAML object", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const res = await app.inject(put({ schema: "- a\n- b\n" }));
      expect(res.statusCode).toBe(422);
    });
  });

  describe("DELETE /api/v1/resource-types/:name", () => {
    const del = () => ({
      method: "DELETE" as const,
      url: "/api/v1/resource-types/ticket",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "DELETE", url: "/api/v1/resource-types/ticket" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 when the type does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const res = await app.inject(del());
      expect(res.statusCode).toBe(404);
    });

    it("removes the type dir, commits, and reloads (Postgres table left intact)", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const res = await app.inject(del());
      expect(res.statusCode).toBe(204);
      expect(rm).toHaveBeenCalledWith(expect.stringContaining("resources/ticket"), {
        recursive: true,
        force: true,
      });
      expect(gitSync.commit).toHaveBeenCalledWith(
        "soul: remove resource type ticket",
        expect.objectContaining({ email: "user@example.com" })
      );
      expect(soulLoader.reload).toHaveBeenCalledOnce();
    });
  });

  /** Only admins may set Resource domains; members get full CRUD on domainless Resource types. */
  describe("domain is admin-only", () => {
    const auth = (session: string) => ({
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });

    it("refuses a member setting a domain on create", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        ...auth(sid),
        payload: { name: "salary-review", schema: VALID_SCHEMA_YAML, domain: "hr" },
      });
      expect(res.statusCode).toBe(403);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("lets an admin set a domain on create, writing the canonical envelope", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        ...auth(adminSid),
        payload: { name: "salary-review", schema: VALID_SCHEMA_YAML, domain: "hr" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: "salary-review", domain: "hr" });
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("resource.yaml"),
        expect.stringContaining("domain: hr"),
        "utf8"
      );
    });

    it("still lets a member create a domainless type", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        ...auth(sid),
        payload: { name: "ticket", schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(201);
    });

    it("refuses a member re-domaining an existing type", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      soulLoader.resources.set("salary-review", {
        name: "salary-review",
        domain: "hr",
        schema: { type: "object" },
        hasHooks: false,
        hooksEnabled: true,
      } as unknown as SoulResource);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/resource-types/salary-review",
        ...auth(sid),
        payload: { schema: VALID_SCHEMA_YAML, domain: "engineering" },
      });
      expect(res.statusCode).toBe(403);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("lets a member edit the schema of a domained type without changing its domain", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      soulLoader.resources.set("salary-review", {
        name: "salary-review",
        domain: "hr",
        schema: { type: "object" },
        hasHooks: false,
        hooksEnabled: true,
      } as unknown as SoulResource);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/resource-types/salary-review",
        ...auth(sid),
        payload: { schema: VALID_SCHEMA_YAML },
      });
      expect(res.statusCode).toBe(200);

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("resource.yaml"),
        expect.stringContaining("domain: hr"),
        "utf8"
      );
    });

    // Prevent deleting and recreating a protected type as domainless.
    it("refuses a member deleting a domained type", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      soulLoader.resources.set("salary-review", {
        name: "salary-review",
        domain: "hr",
        schema: { type: "object" },
        hasHooks: false,
        hooksEnabled: true,
      } as unknown as SoulResource);

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/resource-types/salary-review",
        ...auth(sid),
      });
      expect(res.statusCode).toBe(403);
      expect(rm).not.toHaveBeenCalled();
    });

    it("still lets a member delete a domainless type", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/resource-types/ticket",
        ...auth(sid),
      });
      expect(res.statusCode).toBe(204);
    });

    /** Refuse envelopes that checkSchemaYaml accepts but the loader would reject. */
    it("refuses a domained schema the Resource envelope would reject", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource-types",
        ...auth(adminSid),
        payload: { name: "salary-review", schema: "type: object\n", domain: "hr" },
      });
      expect(res.statusCode).toBe(422);
      expect(writeFile).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/v1/resource-types/:name/hooks", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resource-types/ticket/hooks",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 when resource type does not exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resource-types/ghost/hooks",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns hook source when hooks exist", async () => {
      const hookSource = "({ async before(ctx) { ctx.patch({ x: 1 }); } })";
      await app.close();
      soulLoader = makeFakeSoulLoader([
        {
          name: "ticket",
          schema: { type: "object" },
          hasHooks: true,
          hookSource,
          hooksEnabled: true,
        },
      ]);
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync, soulLoader });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resource-types/ticket/hooks",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: "ticket", hasHooks: true, source: hookSource });
    });

    it("returns null source when no hooks exist", async () => {
      await app.close();
      soulLoader = makeFakeSoulLoader([
        { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
      ]);
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync, soulLoader });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resource-types/ticket/hooks",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ name: "ticket", hasHooks: false, source: null });
    });
  });

  describe("PUT /api/v1/resource-types/:name/hooks", () => {
    const VALID_HOOK =
      "({ async before(ctx) { ctx.patch({ upper: ctx.record.title.toUpperCase() }); } })";

    const putHook = (payload: { source: string }) => ({
      method: "PUT" as const,
      url: "/api/v1/resource-types/ticket/hooks",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload,
    });

    beforeEach(async () => {
      await app.close();
      soulLoader = makeFakeSoulLoader([
        { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
      ]);
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync, soulLoader });
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/resource-types/ticket/hooks",
        payload: { source: VALID_HOOK },
      });
      expect(res.statusCode).toBe(401);
    });

    it("writes hooks.ts, commits, and reloads", async () => {
      const res = await app.inject(putHook({ source: VALID_HOOK }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "ticket", hasHooks: true, source: VALID_HOOK });
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("hooks.ts"),
        VALID_HOOK,
        "utf8"
      );
      expect(gitSync.commit).toHaveBeenCalledWith(
        "soul: add hooks for resource type ticket",
        expect.objectContaining({ email: "user@example.com" })
      );
      expect(soulLoader.reload).toHaveBeenCalledOnce();
    });

    it("returns 404 when resource type does not exist", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/resource-types/ghost/hooks",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { source: VALID_HOOK },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 422 for banned pattern (require)", async () => {
      const res = await app.inject(putHook({ source: "({ before() { require('fs'); } })" }));
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining("banned pattern"),
      });
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("returns 422 when source is not parenthesized", async () => {
      const res = await app.inject(putHook({ source: "{ before() {} }" }));
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining("parenthesized"),
      });
    });
  });

  describe("DELETE /api/v1/resource-types/:name/hooks", () => {
    const delHooks = () => ({
      method: "DELETE" as const,
      url: "/api/v1/resource-types/ticket/hooks",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
    });

    beforeEach(async () => {
      await app.close();
      soulLoader = makeFakeSoulLoader([
        { name: "ticket", schema: { type: "object" }, hasHooks: true, hooksEnabled: true },
      ]);
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync, soulLoader });
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/resource-types/ticket/hooks",
      });
      expect(res.statusCode).toBe(401);
    });

    it("deletes hooks.ts, commits, and reloads", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const res = await app.inject(delHooks());
      expect(res.statusCode).toBe(204);
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining("hooks.ts"));
      expect(gitSync.commit).toHaveBeenCalledWith(
        "soul: remove hooks for resource type ticket",
        expect.objectContaining({ email: "user@example.com" })
      );
      expect(soulLoader.reload).toHaveBeenCalledOnce();
    });

    it("returns 404 when hooks.ts does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const res = await app.inject(delHooks());
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining("no hooks found"),
      });
      expect(unlink).not.toHaveBeenCalled();
    });

    it("returns 404 when resource type does not exist", async () => {
      await app.close();
      soulLoader = makeFakeSoulLoader();
      app = await buildApp({ sessionStore: store, userRepo, tokenRepo, gitSync, soulLoader });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/resource-types/ghost/hooks",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
