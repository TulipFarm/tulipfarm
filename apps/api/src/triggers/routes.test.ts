import type { RegisteredTrigger } from "@tulipfarm/run-kernel";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { TriggerInvokeDeps } from "./routes";

const TEST_CSRF = "a".repeat(64);

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
  async create(): Promise<void> {}
  async findByHash(): Promise<TokenDoc | null> {
    return null;
  }
  async findByUserId(): Promise<TokenDoc[]> {
    return [];
  }
  async findAll(): Promise<TokenDoc[]> {
    return [];
  }
  async findById(): Promise<TokenDoc | null> {
    return null;
  }
  async deleteById(): Promise<void> {}
  async findAllPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
  async findByUserIdPaginated(): Promise<PaginatedResult<TokenDoc>> {
    return { items: [], nextCursor: null };
  }
}

const trigger: RegisteredTrigger = {
  triggerSlug: "run-digest",
  authoredVersion: 2,
  lifecycle: "published",
  type: "manual",
  eventType: "digest.requested",
  eventVersion: 1,
  routineRef: { name: "daily-digest", version: "1.0.0" },
  backgroundIdentity: { principalKind: "service", principalId: "digest-bot" },
  inputMappings: { window: "window" },
};

describe("POST /api/v1/triggers/:slug/invoke", () => {
  let app: FastifyInstance;
  let sid: string;
  let startRun: Mock<TriggerInvokeDeps["startRun"]>;
  let accept: Mock<TriggerInvokeDeps["sink"]["accept"]>;
  let resolveTrigger: Mock<TriggerInvokeDeps["resolveTrigger"]>;

  async function build(): Promise<void> {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "member@example.com", "pass", "member");
    sid = await store.create(user._id);

    startRun = vi.fn<TriggerInvokeDeps["startRun"]>(async () => ({
      runId: "run-1",
      outcome: "started",
    }));
    accept = vi.fn<TriggerInvokeDeps["sink"]["accept"]>(async () => ({ outcome: "accepted" }));
    resolveTrigger = vi.fn<TriggerInvokeDeps["resolveTrigger"]>(async () => trigger);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      triggerInvoke: {
        resolveTrigger,
        sink: { accept },
        startRun,
        nextEventId: () => "event-1",
        now: () => "2026-07-25T10:00:00.000Z",
      },
    });
  }

  function invoke(payload: Record<string, unknown>, slug = "run-digest") {
    return app.inject({
      method: "POST",
      url: `/api/v1/triggers/${slug}/invoke`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload,
    });
  }

  beforeEach(build);
  afterEach(async () => {
    await app.close();
  });

  it("refuses an unauthenticated invocation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/triggers/run-digest/invoke",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("starts the Run under the Trigger's identity, not the caller's", async () => {
    const response = await invoke({ data: { window: "7d" }, idempotencyKey: "manual-1" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ runId: "run-1", status: "started" });
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({
      routineRef: { name: "daily-digest", version: "1.0.0" },
      backgroundIdentity: { principalKind: "service", principalId: "digest-bot" },
      idempotencyKey: "run-digest:2:run-digest:manual-1",
      input: { window: "7d" },
    });
  });

  it("persists the canonical event before the Run is started", async () => {
    const order: string[] = [];
    accept.mockImplementation(async () => {
      order.push("event");
      return { outcome: "accepted" };
    });
    startRun.mockImplementation(async () => {
      order.push("run");
      return { runId: "run-1", outcome: "started" };
    });

    await invoke({ data: { window: "7d" }, idempotencyKey: "manual-1" });

    expect(order).toEqual(["event", "run"]);
  });

  it("returns the same Run for a repeated idempotency key", async () => {
    startRun.mockResolvedValue({ runId: "run-1", outcome: "duplicate" });

    const response = await invoke({ data: { window: "7d" }, idempotencyKey: "manual-1" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ runId: "run-1", status: "duplicate" });
  });

  it("refuses to invoke a Trigger that is not caller-invokable", async () => {
    resolveTrigger.mockResolvedValue({ ...trigger, type: "webhook" });

    const response = await invoke({ data: { window: "7d" } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "trigger not found" });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("refuses an unpublished Trigger with the same constant 404", async () => {
    resolveTrigger.mockResolvedValue({ ...trigger, lifecycle: "draft" });

    const response = await invoke({ data: { window: "7d" } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "trigger not found" });
  });

  it("rejects a payload that does not satisfy the Trigger's declared mappings", async () => {
    const response = await invoke({ data: {}, idempotencyKey: "manual-1" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "mapping_unresolved" });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("refuses to start a Run once the caller is over the rate limit", async () => {
    await app.close();

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "member@example.com", "pass", "member");
    sid = await store.create(user._id);
    const keys: string[] = [];

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      rateLimiter: {
        async check(key, limit) {
          keys.push(key);
          return { allowed: false, limit, remaining: 0, resetAt: Date.now() + 60_000 };
        },
      },
      triggerInvoke: {
        resolveTrigger,
        sink: { accept },
        startRun,
        nextEventId: () => "event-1",
        now: () => "2026-07-25T10:00:00.000Z",
      },
    });

    const response = await invoke({ data: { window: "7d" }, idempotencyKey: "manual-1" });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "rate_limit_exceeded" });
    // The bucket is the authenticated caller, so one caller cannot exhaust another's budget.
    expect(keys).toEqual([`rl:trigger-invoke:${user._id}`]);
    expect(startRun).not.toHaveBeenCalled();
  });
});
