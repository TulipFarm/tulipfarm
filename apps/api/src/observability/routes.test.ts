import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { type LogEventRecord, PgResourceWriter } from "@tulipfarm/observability";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { makeMigratedPglite } from "../test/pglite";
import { type LogEventView, PgLogRepo } from "./log-repo";
import { PgObsRepo } from "./repo";
import { PgResourceRepo, type ResourceUsage } from "./resource-repo";
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
    db = await makeMigratedPglite();
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
      logRepo: new PgLogRepo(db),
      resourceRepo: new PgResourceRepo(db),
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
      totals: { cost: number; turns: number };
      byModel: { model: string; calls: number }[];
      byMember: { memberId: string; member: string; cost: number }[];
    };
    expect(body.totals.cost).toBeCloseTo(0.06, 6);
    expect(body.totals.turns).toBe(1);
    expect(body.byModel[0].model).toBe("claude-opus-4-8");
    expect(body.byMember).toEqual([{ memberId: "system", member: "System", cost: 0.06 }]);
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

  describe("logs", () => {
    const seed = async (rows: Array<Partial<LogEventRecord> & { message: string }>) => {
      await new PgLogRepo(db).insertMany(
        rows.map((row, i) => ({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          ts: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
          level: "error" as const,
          service: "api" as const,
          stack: null,
          requestId: null,
          runId: null,
          conversationId: null,
          attributes: {},
          ...row,
        }))
      );
    };

    const get = (query: string, sid = adminSid) =>
      app.inject({
        method: "GET",
        url: `/api/v1/observability/logs${query}`,
        cookies: { [SESSION_COOKIE]: sid },
      });

    it("returns records newest first with the stack and attributes intact", async () => {
      await seed([
        { message: "older failure" },
        {
          message: "newer failure",
          level: "fatal",
          stack: "Error: boom\n  at x",
          attributes: { route: "/x" },
        },
      ]);

      const res = await get("");
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: LogEventView[]; nextCursor: string | null };
      expect(body.items.map((i) => i.message)).toEqual(["newer failure", "older failure"]);
      expect(body.items[0]).toMatchObject({
        level: "fatal",
        service: "api",
        stack: "Error: boom\n  at x",
        attributes: { route: "/x" },
      });
      expect(body.nextCursor).toBeNull();
    });

    it("filters by level, service and message search", async () => {
      await seed([
        { message: "database timeout" },
        { message: "slack delivery failed", service: "integration-worker" },
        { message: "run crashed", level: "fatal", service: "worker" },
      ]);

      const byLevel = (await get("?level=fatal")).json() as { items: LogEventView[] };
      expect(byLevel.items.map((i) => i.message)).toEqual(["run crashed"]);

      const byService = (await get("?service=integration-worker")).json() as {
        items: LogEventView[];
      };
      expect(byService.items.map((i) => i.message)).toEqual(["slack delivery failed"]);

      const bySearch = (await get("?q=TIMEOUT")).json() as { items: LogEventView[] };
      expect(bySearch.items.map((i) => i.message)).toEqual(["database timeout"]);
    });

    it("treats search wildcards as literal text", async () => {
      await seed([{ message: "100% failure" }, { message: "unrelated" }]);

      const res = (await get("?q=100%25")).json() as { items: LogEventView[] };
      expect(res.items.map((i) => i.message)).toEqual(["100% failure"]);
    });

    it("pages through records with a stable cursor", async () => {
      await seed([{ message: "one" }, { message: "two" }, { message: "three" }]);

      const first = (await get("?limit=2")).json() as {
        items: LogEventView[];
        nextCursor: string | null;
      };
      expect(first.items.map((i) => i.message)).toEqual(["three", "two"]);
      expect(first.nextCursor).not.toBeNull();

      const second = (
        await get(`?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)
      ).json() as { items: LogEventView[]; nextCursor: string | null };
      expect(second.items.map((i) => i.message)).toEqual(["one"]);
      expect(second.nextCursor).toBeNull();
    });

    it("falls back to the first page on a tampered cursor instead of erroring", async () => {
      await seed([{ message: "still visible" }]);

      // The id is bound against a `uuid` column, so a non-UUID reaches Postgres as a type error
      // unless the cursor is rejected first.
      for (const cursor of [
        "2030-01-01T00:00:00.000Z|not-a-uuid",
        "garbage",
        "|",
        "not-a-date|x",
      ]) {
        const res = await get(`?cursor=${encodeURIComponent(cursor)}`);
        expect(res.statusCode).toBe(200);
        expect((res.json() as { items: LogEventView[] }).items).toHaveLength(1);
      }
    });

    it("gates logs to admins", async () => {
      expect((await get("", memberSid)).statusCode).toBe(403);
      const anon = await app.inject({ method: "GET", url: "/api/v1/observability/logs" });
      expect(anon.statusCode).toBe(401);
    });
  });
  describe("resources", () => {
    const sample = async (
      offsetMinutes: number,
      service: string,
      cpuPct: number,
      rssBytes: number,
      instance = "host:1"
    ) => {
      await new PgResourceWriter(db).write({
        id: randomUUID(),
        ts: new Date(Date.now() - offsetMinutes * 60_000),
        service: service as "api",
        instance,
        cpuPct,
        rssBytes,
      });
    };

    const get = (query = "", sid = adminSid) =>
      app.inject({
        method: "GET",
        url: `/api/v1/observability/resources${query}`,
        cookies: { [SESSION_COOKIE]: sid },
      });

    it("returns one aligned series per service over a shared bucket axis", async () => {
      await sample(3, "api", 10, 1000);
      await sample(3, "worker", 20, 2000);
      await sample(1, "api", 30, 3000);
      await sample(1, "worker", 40, 4000);

      const body = get("?window=1h").then((r) => r.json() as ResourceUsage);
      const usage = await body;
      expect(usage.window).toBe("1h");
      expect(usage.bucketSeconds).toBe(60);
      expect(usage.buckets).toHaveLength(2);
      expect(usage.series.map((s) => s.service)).toEqual(["api", "worker"]);
      for (const series of usage.series) {
        expect(series.cpuPct).toHaveLength(usage.buckets.length);
        expect(series.rssBytes).toHaveLength(usage.buckets.length);
      }
      // Buckets ascend, so the older sample is first.
      expect(usage.series[0].cpuPct).toEqual([10, 30]);
      expect(usage.series[1].rssBytes).toEqual([2000, 4000]);
    });

    it("leaves a null where a service produced no sample, so the chart draws a gap", async () => {
      await sample(3, "api", 10, 1000);
      await sample(1, "api", 30, 3000);
      // The worker only reported in the newest bucket — it was down for the older one.
      await sample(1, "worker", 40, 4000);

      const usage = (await get("?window=1h")).json() as ResourceUsage;
      const worker = usage.series.find((s) => s.service === "worker");
      expect(worker?.cpuPct).toEqual([null, 40]);
      expect(worker?.rssBytes).toEqual([null, 4000]);
    });

    it("averages replicas of one service rather than summing them", async () => {
      await sample(1, "api", 10, 1000, "host:1");
      await sample(1, "api", 30, 3000, "host:2");

      const usage = (await get("?window=1h")).json() as ResourceUsage;
      // Summing would report 40% and make a two-pod fleet look like one burning process.
      expect(usage.series[0].cpuPct).toEqual([20]);
      expect(usage.series[0].rssBytes).toEqual([2000]);
    });

    it("widens the bucket for longer windows and excludes samples outside them", async () => {
      await sample(30, "api", 10, 1000);
      await sample(300, "api", 20, 2000);

      const hour = (await get("?window=1h")).json() as ResourceUsage;
      expect(hour.buckets).toHaveLength(1);

      const sixHours = (await get("?window=6h")).json() as ResourceUsage;
      expect(sixHours.bucketSeconds).toBe(300);
      expect(sixHours.buckets).toHaveLength(2);

      const day = (await get("?window=24h")).json() as ResourceUsage;
      expect(day.bucketSeconds).toBe(900);
    });

    it("defaults to the narrowest window when the parameter is absent", async () => {
      const res = await get("");
      expect(res.statusCode).toBe(200);
      expect((res.json() as ResourceUsage).window).toBe("1h");
    });

    it("rejects an unknown window rather than silently charting a different one", async () => {
      for (const query of ["?window=nonsense", "?window=7d"]) {
        expect((await get(query)).statusCode).toBe(400);
      }
    });

    it("returns an empty axis rather than failing when nothing has been sampled", async () => {
      const usage = (await get("?window=1h")).json() as ResourceUsage;
      expect(usage.buckets).toEqual([]);
      expect(usage.series).toEqual([]);
    });

    it("gates resources to admins", async () => {
      expect((await get("", memberSid)).statusCode).toBe(403);
      const anon = await app.inject({ method: "GET", url: "/api/v1/observability/resources" });
      expect(anon.statusCode).toBe(401);
    });
  });
});
