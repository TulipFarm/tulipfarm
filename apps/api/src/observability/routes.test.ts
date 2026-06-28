import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { PgObsRepo } from "./repo";
import { ObservabilityService } from "./service";

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
  async create(_t: TokenDoc): Promise<void> {}
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

describe("observability routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let service: ObservabilityService;
  let adminSid: string;
  let memberSid: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    service = new ObservabilityService(new PgObsRepo(db));

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const tokenRepo = new FakeTokenRepo();
    const admin = await createUser(userRepo, "admin@example.com", "pass", "admin");
    adminSid = await store.create(admin._id);
    const member = await createUser(userRepo, "member@example.com", "pass", "member");
    memberSid = await store.create(member._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      observabilityService: service,
      observabilityConfig: {
        enabled: true,
        retentionDays: 30,
        captureContent: false,
        spendAlertUsd: 50,
        otlp: { endpoint: "https://otlp.grafana.net/otlp", instanceId: "1", token: "secret-ref" },
        pricingOverrides: {},
      },
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/observability/summary" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/observability/summary",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns export config status for an admin without leaking the token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/observability/config",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true,
      otlpConfigured: true,
      endpoint: "https://otlp.grafana.net/otlp",
      retentionDays: 30,
      captureContent: false,
      spendAlertUsd: 50,
    });
    // The token must never appear in the response.
    expect(JSON.stringify(body)).not.toContain("secret-ref");
  });

  it("gates the config endpoint to admins", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/observability/config",
      cookies: { [SESSION_COOKIE]: memberSid },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns an aggregated summary for an admin", async () => {
    await service.record({
      type: "llm_call",
      model: "claude-opus-4-8",
      agentId: "support-agent",
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.06,
      status: "ok",
    });
    await service.record({ type: "turn", agentId: "support-agent", status: "ok" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/observability/summary?range=7d",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totals: { costUsd: number; turns: number };
      byModel: { model: string; calls: number }[];
    };
    expect(body.totals.costUsd).toBeCloseTo(0.06, 6);
    expect(body.totals.turns).toBe(1);
    expect(body.byModel[0].model).toBe("claude-opus-4-8");
  });

  it("serializes recent turns + a conversation trace for an admin", async () => {
    const convo = "33333333-3333-3333-3333-333333333333";
    await service.record({
      type: "llm_call",
      conversationId: convo,
      model: "claude-opus-4-8",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.02,
      durationMs: 900,
      status: "ok",
    });
    await service.record({
      type: "turn",
      conversationId: convo,
      agentId: "support-agent",
      status: "ok",
      attributes: { steps: 1 },
    });

    const recent = await app.inject({
      method: "GET",
      url: "/api/v1/observability/recent?limit=5",
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(recent.statusCode).toBe(200);
    const turns = recent.json() as Array<{ conversationId: string; steps: number; status: string }>;
    expect(turns[0]).toMatchObject({ conversationId: convo, steps: 1, status: "ok" });

    const trace = await app.inject({
      method: "GET",
      url: `/api/v1/observability/trace/${convo}`,
      cookies: { [SESSION_COOKIE]: adminSid },
    });
    expect(trace.statusCode).toBe(200);
    const events = trace.json() as Array<{
      type: string;
      model: string | null;
      costUsd: number | null;
    }>;
    expect(events.map((e) => e.type)).toEqual(["llm_call", "turn"]);
    expect(events[0]).toMatchObject({ model: "claude-opus-4-8", costUsd: 0.02 });
  });

  it("gates recent + trace to admins", async () => {
    for (const url of ["/api/v1/observability/recent", "/api/v1/observability/trace/x"]) {
      const res = await app.inject({
        method: "GET",
        url,
        cookies: { [SESSION_COOKIE]: memberSid },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});
