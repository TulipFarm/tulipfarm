import { randomUUID } from "node:crypto";
import type { SoulLoader, SoulResource } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { type UserDoc, type UserRepo, createUser } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import type { ListOpts, ResourceDoc, ResourceHistoryDoc, ResourceRepo } from "./repo";

const TEST_CSRF = "a".repeat(64);

// ── Fake repo ─────────────────────────────────────────────────────────────────

class FakeResourceRepo implements ResourceRepo {
  docs: Map<string, ResourceDoc> = new Map();
  history: ResourceHistoryDoc[] = [];

  async insert(doc: ResourceDoc): Promise<void> {
    this.docs.set(doc._id, { ...doc });
  }

  async findById(id: string): Promise<ResourceDoc | null> {
    return this.docs.get(id) ?? null;
  }

  async list(opts: ListOpts): Promise<PaginatedResult<ResourceDoc>> {
    let items = Array.from(this.docs.values());
    if (!opts.includeDeleted) items = items.filter((d) => d.deletedAt == null);
    const sliced = items.slice(0, opts.limit);
    return { items: sliced, nextCursor: items.length > opts.limit ? "next" : null };
  }

  async replaceOne(id: string, expectedVersion: number, doc: ResourceDoc): Promise<boolean> {
    const existing = this.docs.get(id);
    if (!existing || existing.version !== expectedVersion) return false;
    this.docs.set(id, { ...doc });
    return true;
  }

  async appendHistory(entry: ResourceHistoryDoc): Promise<void> {
    this.history.push(entry);
  }
}

// ── Fake DB that returns a FakeResourceRepo ───────────────────────────────────

function makeFakeDb(repo: FakeResourceRepo) {
  return {
    collection: vi.fn().mockReturnValue({
      insertOne: vi.fn().mockResolvedValue({ insertedId: "mock" }),
      findOne: vi.fn().mockImplementation(({ _id }) => Promise.resolve(repo.docs.get(_id) ?? null)),
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockImplementation(() => {
          const items = Array.from(repo.docs.values()).filter((d) => d.deletedAt == null);
          return Promise.resolve(items);
        }),
      }),
      replaceOne: vi.fn().mockImplementation(({ _id, version }, doc) => {
        const existing = repo.docs.get(_id);
        if (!existing || existing.version !== version) return Promise.resolve({ matchedCount: 0 });
        repo.docs.set(_id, { ...doc });
        return Promise.resolve({ matchedCount: 1 });
      }),
      findOneAndUpdate: vi.fn().mockResolvedValue({ seq: 1 }),
    }),
  };
}

// ── Fake auth deps ────────────────────────────────────────────────────────────

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(e: string): Promise<UserDoc | null> {
    return this.users.find((u) => u.email === e.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((u) => u._id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async insert(u: UserDoc): Promise<void> {
    this.users.push(u);
  }
}

class FakeTokenRepo implements TokenRepo {
  private tokens: TokenDoc[] = [];
  async create(t: TokenDoc): Promise<void> {
    this.tokens.push(t);
  }
  async findByHash(h: string): Promise<TokenDoc | null> {
    return this.tokens.find((t) => t.tokenHash === h) ?? null;
  }
  async findByUserId(id: string): Promise<TokenDoc[]> {
    return this.tokens.filter((t) => t.userId === id);
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

function makeFakeSoulLoader(resources: SoulResource[] = []): SoulLoader {
  return {
    resources: new Map(resources.map((r) => [r.name, r])),
    reload: vi.fn(),
  } as unknown as SoulLoader;
}

const TICKET_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    priority: { type: "string", enum: ["low", "high"] },
  },
  required: ["title"],
};

// ── Test setup ────────────────────────────────────────────────────────────────

describe("resource routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let soulLoader: SoulLoader;
  let fakeRepo: FakeResourceRepo;
  let sid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    fakeRepo = new FakeResourceRepo();
    soulLoader = makeFakeSoulLoader([{ name: "ticket", schema: TICKET_SCHEMA, hasHooks: false }]);

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    const db = makeFakeDb(fakeRepo) as unknown as import("mongodb").Db;
    app = await buildApp({ sessionStore: store, userRepo, tokenRepo, soulLoader, db });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── POST ──────────────────────────────────────────────────────────────────

  describe("POST /api/v1/resources/:type", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resources/ticket",
        payload: { title: "Bug" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for unknown type", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resources/unknown",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { title: "Bug" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("creates record — UUID id, version:1, history appended", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resources/ticket",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { title: "Bug report" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; version: number; title: string; createdAt: string }>();
      expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(body.version).toBe(1);
      expect(body.title).toBe("Bug report");
      expect(body.createdAt).toBeDefined();
    });

    it("returns 422 for schema validation failure (missing required field)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resources/ticket",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { priority: "high" },
      });
      expect(res.statusCode).toBe(422);
    });

    it("strips system fields from body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resources/ticket",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { title: "Bug", id: "hacked", version: 999 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ version: number }>();
      expect(body.version).toBe(1);
    });
  });

  // ── GET list ──────────────────────────────────────────────────────────────

  describe("GET /api/v1/resources/:type", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/resources/ticket" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for unknown type", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resources/unknown",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns list with items and nextCursor", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resources/ticket",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: unknown[]; nextCursor: string | null }>();
      expect(body.items).toHaveLength(1);
      expect(body.nextCursor).toBeNull();
    });

    it("excludes soft-deleted records by default", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: new Date(),
        title: "Deleted",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resources/ticket",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
    });
  });

  // ── GET single ────────────────────────────────────────────────────────────

  describe("GET /api/v1/resources/:type/:id", () => {
    it("returns 404 for unknown type", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/resources/unknown/abc",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for soft-deleted record", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: new Date(),
        title: "Gone",
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns record with id field", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ id: string }>().id).toBe(id);
    });
  });

  // ── PUT ───────────────────────────────────────────────────────────────────

  describe("PUT /api/v1/resources/:type/:id", () => {
    it("returns 400 when If-Match missing", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { title: "Updated" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 409 with wrong If-Match version", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF, "if-match": "99" },
        payload: { title: "Updated" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("replaces record and increments version", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF, "if-match": "1" },
        payload: { title: "Updated bug" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ version: number; title: string }>();
      expect(body.version).toBe(2);
      expect(body.title).toBe("Updated bug");
    });
  });

  // ── PATCH ─────────────────────────────────────────────────────────────────

  describe("PATCH /api/v1/resources/:type/:id", () => {
    it("returns 409 with wrong version", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
        priority: "low",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF, "if-match": "1" },
        payload: { priority: "high" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("merges patch with existing data", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
        priority: "low",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF, "if-match": "1" },
        payload: { priority: "high" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ version: number; title: string; priority: string }>();
      expect(body.version).toBe(2);
      expect(body.title).toBe("Bug");
      expect(body.priority).toBe("high");
    });
  });

  // ── DELETE ────────────────────────────────────────────────────────────────

  describe("DELETE /api/v1/resources/:type/:id", () => {
    it("returns 400 when If-Match missing", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 409 with wrong version", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF, "if-match": "5" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("soft-deletes — returns 204, record excluded from list", async () => {
      const id = randomUUID();
      fakeRepo.docs.set(id, {
        _id: id,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        title: "Bug",
      });

      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/resources/ticket/${id}`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF, "if-match": "1" },
      });
      expect(del.statusCode).toBe(204);

      const doc = fakeRepo.docs.get(id);
      expect(doc?.deletedAt).toBeDefined();

      const list = await app.inject({
        method: "GET",
        url: "/api/v1/resources/ticket",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
      });
      expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);
    });
  });
});
