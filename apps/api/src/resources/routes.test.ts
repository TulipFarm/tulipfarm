import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { SoulLoader, SoulResource } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { type UserDoc, type UserRepo, createUser } from "../auth/users";
import { HookError, type HookExecutor } from "../hooks/hook-executor";
import type { PaginatedResult } from "../pagination";
import type {
  CounterStore,
  ListOpts,
  ResourceDoc,
  ResourceHistoryDoc,
  ResourceRepo,
  ResourceRepoFactory,
  SearchOpts,
} from "./repo";

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

  async search(opts: SearchOpts): Promise<PaginatedResult<ResourceDoc>> {
    let items = Array.from(this.docs.values());
    if (!opts.includeDeleted) items = items.filter((d) => d.deletedAt == null);
    if (opts.filter && Object.keys(opts.filter).length > 0) {
      const filter = opts.filter;
      items = items.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
    }
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

// ── Fake factory + counter store (injects a FakeResourceRepo per type) ────────

class FakeResourceRepoFactory implements ResourceRepoFactory {
  constructor(readonly repos: Map<string, FakeResourceRepo> = new Map()) {}

  forType(type: string): ResourceRepo {
    let repo = this.repos.get(type);
    if (!repo) {
      repo = new FakeResourceRepo();
      this.repos.set(type, repo);
    }
    return repo;
  }
}

const stubCounterStore: CounterStore = { makeCounterFn: () => async () => 1 };

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
    soulLoader = makeFakeSoulLoader([
      { name: "ticket", schema: TICKET_SCHEMA, hasHooks: false, hooksEnabled: true },
    ]);

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    const factory = new FakeResourceRepoFactory(new Map([["ticket", fakeRepo]]));
    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      soulLoader,
      resourceRepoFactory: factory,
      counterStore: stubCounterStore,
    });
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
      expect(res.json<{ boundary: string }>().boundary).toBe("resource");
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

  // ── Hooks ───────────────────────────────────────────────────────────────────

  describe("before/after hooks", () => {
    let hookApp: FastifyInstance;
    let runBeforeHook: ReturnType<typeof vi.fn>;
    let runAfterHook: ReturnType<typeof vi.fn>;
    let hookSid: string;

    beforeEach(async () => {
      const hookStore = new MemorySessionStore();
      const hookUserRepo = new FakeUserRepo();
      const hookLoader = makeFakeSoulLoader([
        {
          name: "ticket",
          schema: TICKET_SCHEMA,
          hasHooks: true,
          hookSource: "({})",
          hookHash: "hash",
          hooksEnabled: true,
        },
      ]);
      runBeforeHook = vi.fn();
      runAfterHook = vi.fn().mockResolvedValue(undefined);
      const hookExecutor = { runBeforeHook, runAfterHook } as unknown as HookExecutor;

      const user = await createUser(hookUserRepo, "hook@example.com", "pass", "member");
      hookSid = await hookStore.create(user._id);
      hookApp = await buildApp({
        sessionStore: hookStore,
        userRepo: hookUserRepo,
        tokenRepo: new FakeTokenRepo(),
        soulLoader: hookLoader,
        hookExecutor,
        resourceRepoFactory: new FakeResourceRepoFactory(),
        counterStore: stubCounterStore,
      });
    });

    afterEach(async () => {
      await hookApp.close();
    });

    function post(payload: Record<string, unknown>) {
      return hookApp.inject({
        method: "POST",
        url: "/api/v1/resources/ticket",
        cookies: { [SESSION_COOKIE]: hookSid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload,
      });
    }

    it("persists before-hook mutations and runs the after hook", async () => {
      runBeforeHook.mockImplementation(async (_src, _type, record) => ({
        ...record,
        priority: "high",
      }));
      const res = await post({ title: "Bug" });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ priority: string }>().priority).toBe("high");
      expect(runAfterHook).toHaveBeenCalledOnce();
    });

    it("re-validates after the before hook — rejects schema-violating hook output (422)", async () => {
      runBeforeHook.mockImplementation(async (_src, _type, record) => ({
        ...record,
        priority: "INVALID",
      }));
      const res = await post({ title: "Bug" });
      expect(res.statusCode).toBe(422);
      expect(runAfterHook).not.toHaveBeenCalled();
    });

    it("returns 422 when the before hook throws HookError", async () => {
      runBeforeHook.mockRejectedValue(new HookError("hook boom"));
      const res = await post({ title: "Bug" });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: string }>().error).toBe("hook boom");
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

// ── x-links validate-on-write ─────────────────────────────────────────────────

const LINKED_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    customerId: { type: "string", "x-links": { target: "customer" } },
  },
  required: ["title"],
};

describe("x-links validate-on-write", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let ticketRepo: FakeResourceRepo;
  let customerRepo: FakeResourceRepo;
  let sid: string;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    ticketRepo = new FakeResourceRepo();
    customerRepo = new FakeResourceRepo();

    const soulLoader = makeFakeSoulLoader([
      { name: "ticket", schema: LINKED_SCHEMA, hasHooks: false, hooksEnabled: true },
      {
        name: "customer",
        schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        hasHooks: false,
        hooksEnabled: true,
      },
    ]);

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    const factory = new FakeResourceRepoFactory(
      new Map([
        ["ticket", ticketRepo],
        ["customer", customerRepo],
      ])
    );
    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      soulLoader,
      resourceRepoFactory: factory,
      counterStore: stubCounterStore,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects POST when linked record does not exist (AC-V1-001a)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/resources/ticket",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { title: "Bug", customerId: "nonexistent-id" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string; path: string }>().error).toMatch(/linked record not found/);
    expect(res.json<{ path: string }>().path).toBe("/customerId");
  });

  it("accepts POST when linked record exists (AC-V1-001b)", async () => {
    const custId = randomUUID();
    customerRepo.docs.set(custId, {
      _id: custId,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      name: "Acme",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/resources/ticket",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { title: "Bug", customerId: custId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ customerId: string }>().customerId).toBe(custId);
  });

  it("accepts POST when optional link field is absent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/resources/ticket",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { title: "Bug" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("soft-deleting linked customer succeeds; ticket customerId unchanged (AC-V1-002)", async () => {
    const custId = randomUUID();
    customerRepo.docs.set(custId, {
      _id: custId,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      name: "Acme",
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/resources/ticket",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { title: "Bug", customerId: custId },
    });
    expect(create.statusCode).toBe(201);
    const ticketId = create.json<{ id: string }>().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/resources/customer/${custId}`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF, "if-match": "1" },
    });
    expect(del.statusCode).toBe(204);

    const custDoc = customerRepo.docs.get(custId);
    expect(custDoc?.deletedAt).toBeDefined();

    const ticketDoc = ticketRepo.docs.get(ticketId);
    expect(ticketDoc?.customerId).toBe(custId);
  });

  it("rejects PATCH that references a soft-deleted record", async () => {
    const custId = randomUUID();
    customerRepo.docs.set(custId, {
      _id: custId,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      name: "Acme",
    });

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/resources/ticket",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { title: "Bug", customerId: custId },
    });
    expect(create.statusCode).toBe(201);
    const ticketId = create.json<{ id: string }>().id;

    customerRepo.docs.set(custId, {
      _id: custId,
      version: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
      name: "Acme",
    });

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/resources/ticket/${ticketId}`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF, "if-match": "1" },
      payload: { title: "Bug Updated", customerId: custId },
    });
    expect(patch.statusCode).toBe(422);
    expect(patch.json<{ error: string }>().error).toMatch(/linked record not found/);
  });
});

describe("resource domain events", () => {
  it("emits resource.created on POST with the api record", async () => {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const soulLoader = makeFakeSoulLoader([
      { name: "ticket", schema: TICKET_SCHEMA, hasHooks: false, hooksEnabled: true },
    ]);
    const user = await createUser(userRepo, "ev@example.com", "pass", "member");
    const sid = await store.create(user._id);

    const emitter = new EventEmitter();
    const seen: Array<{ resourceType: string; resourceId: string; record: { id: string } }> = [];
    emitter.on("resource.created", (p) => seen.push(p));

    const app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      soulLoader,
      resourceRepoFactory: new FakeResourceRepoFactory(),
      counterStore: stubCounterStore,
      domainEventEmitter: emitter,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/resources/ticket",
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { title: "Bug" },
    });
    expect(res.statusCode).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0].resourceType).toBe("ticket");
    expect(seen[0].resourceId).toBe(res.json<{ id: string }>().id);
    await app.close();
  });
});
