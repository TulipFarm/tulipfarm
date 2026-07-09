import type { PGlite } from "@electric-sql/pglite";
import type { SoulLoader, SoulRoutine } from "@tulipfarm/soul";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { StreamHub } from "../chat/stream-hub";
import type { PaginatedResult } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import type { RoutineRunJob, RoutineWakeJob } from "./jobs";
import { RoutineRegistry } from "./registry";
import { RoutineRunsRepo } from "./repo";
import { WEBHOOK_SECRET_HEADER } from "./routes";
import { RoutineTriggerService } from "./trigger-service";

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

const ROUTINE_CONFIG: Record<string, unknown> = {
  id: "expense-report",
  version: "1.0",
  name: "Expense Report",
  start: "Record",
  "x-triggers": [
    { type: "manual" },
    { type: "webhook", secret_ref: "expense-hook-secret" },
    { type: "agent" },
  ],
  "x-inputs": {
    type: "object",
    additionalProperties: false,
    required: ["amount"],
    properties: { amount: { type: "number" }, memo: { type: "string" } },
  },
  functions: [{ name: "record", operation: "tool:resource_create" }],
  states: [
    {
      name: "Record",
      type: "operation",
      actions: [{ functionRef: { refName: "record" } }],
      end: true,
    },
  ],
};

function makeSoulLoader(routines: Record<string, Record<string, unknown>>): SoulLoader {
  const map = new Map<string, SoulRoutine>();
  for (const [name, config] of Object.entries(routines)) {
    map.set(name, { name, config, hasHooks: false });
  }
  return { routines: map, reload: vi.fn() } as unknown as SoulLoader;
}

describe("routine routes", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let sid: string;
  let runs: RoutineRunsRepo;
  let registry: RoutineRegistry;
  let enqueuedRuns: RoutineRunJob[];

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    const log = { error: vi.fn(), warn: vi.fn() };
    registry = new RoutineRegistry(
      makeSoulLoader({ "expense-report": ROUTINE_CONFIG, broken: { id: "broken" } }),
      log
    );
    registry.refresh();
    runs = new RoutineRunsRepo(db);
    enqueuedRuns = [];
    const enqueuers = {
      enqueueRun: async (job: RoutineRunJob) => {
        enqueuedRuns.push(job);
      },
      enqueueWake: async (_job: RoutineWakeJob & { startAfter?: Date }) => {},
    };
    const triggerService = new RoutineTriggerService({ registry, runs, enqueuers, log });

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      routines: {
        registry,
        runs,
        triggerService,
        enqueuers,
        getSecret: async (key: string) => {
          if (key === "expense-hook-secret") return "s3cret";
          throw new Error("secret not found");
        },
        hub: new StreamHub(),
      },
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const authed = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const csrf = { [CSRF_HEADER]: TEST_CSRF };

  it("GET /routines lists valid and invalid entries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/routines", cookies: authed() });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<Record<string, unknown>> };
    const valid = items.find((i) => i.slug === "expense-report");
    expect(valid).toMatchObject({ valid: true, name: "Expense Report" });
    expect(valid?.triggers).toHaveLength(3);
    const broken = items.find((i) => i.slug === "broken");
    expect(broken?.valid).toBe(false);
    expect(broken?.loadError).toBeTruthy();
  });

  it("401 without auth on the listing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/routines" });
    expect(res.statusCode).toBe(401);
  });

  it("POST manual run validates inputs against x-inputs and enqueues", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/routines/expense-report/runs",
      cookies: authed(),
      headers: csrf,
      payload: { inputs: { memo: "no amount" } },
    });
    expect(bad.statusCode).toBe(400);
    expect(enqueuedRuns).toHaveLength(0);

    const good = await app.inject({
      method: "POST",
      url: "/api/v1/routines/expense-report/runs",
      cookies: authed(),
      headers: csrf,
      payload: { inputs: { amount: 42 } },
    });
    expect(good.statusCode).toBe(202);
    const { runId } = good.json() as { runId: string };
    expect(enqueuedRuns).toHaveLength(1);

    const run = await runs.findById(runId);
    expect(run?.status).toBe("pending");
    expect(run?.definitionSnapshot.id).toBe("expense-report");
    expect(run?.context).toEqual({ amount: 42 });
    expect(run?.trigger.type).toBe("manual");
  });

  it("404 on manual run for unknown routine; 422 for invalid routine", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/routines/nope/runs",
      cookies: authed(),
      headers: csrf,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/routines/broken/runs",
      cookies: authed(),
      headers: csrf,
      payload: {},
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("GET run history and run detail with journal", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/routines/expense-report/runs",
      cookies: authed(),
      headers: csrf,
      payload: { inputs: { amount: 10 } },
    });
    const { runId } = created.json() as { runId: string };
    await runs.appendEvent({
      runId,
      seq: 1,
      type: "run.started",
      payload: {},
      createdAt: new Date(),
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/routines/expense-report/runs",
      cookies: authed(),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[] }).items).toHaveLength(1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/routines/expense-report/runs/${runId}`,
      cookies: authed(),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { run: Record<string, unknown>; events: unknown[] };
    expect(body.run.status).toBe("pending");
    expect(body.events).toHaveLength(1);

    const wrongSlug = await app.inject({
      method: "GET",
      url: `/api/v1/routines/broken/runs/${runId}`,
      cookies: authed(),
    });
    expect(wrongSlug.statusCode).toBe(404);
  });

  it("cancel endpoint cancels a pending run and 409s on terminal runs", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/routines/expense-report/runs",
      cookies: authed(),
      headers: csrf,
      payload: { inputs: { amount: 10 } },
    });
    const { runId } = created.json() as { runId: string };

    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/routines/expense-report/runs/${runId}/cancel`,
      cookies: authed(),
      headers: csrf,
    });
    expect(cancel.statusCode).toBe(200);
    expect((await runs.findById(runId))?.status).toBe("cancelled");

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/routines/expense-report/runs/${runId}/cancel`,
      cookies: authed(),
      headers: csrf,
    });
    expect(again.statusCode).toBe(409);
  });

  describe("run SSE stream (D7)", () => {
    it("replays journaled events over SSE and closes on the terminal event", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/routines/expense-report/runs",
        cookies: authed(),
        headers: csrf,
        payload: { inputs: { amount: 10 } },
      });
      const { runId } = created.json() as { runId: string };
      const at = new Date();
      await runs.appendEvent({ runId, seq: 1, type: "run.started", payload: {}, createdAt: at });
      await runs.appendEvent({
        runId,
        seq: 2,
        type: "finish",
        payload: { reason: "completed" },
        createdAt: at,
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/routines/expense-report/runs/${runId}/events`,
        cookies: authed(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body).toContain("event: run.started");
      expect(res.body).toContain("event: finish");
      expect(res.body).toContain("id: 2");
    });

    it("resumes from Last-Event-ID, skipping already-seen events", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/routines/expense-report/runs",
        cookies: authed(),
        headers: csrf,
        payload: { inputs: { amount: 10 } },
      });
      const { runId } = created.json() as { runId: string };
      const at = new Date();
      await runs.appendEvent({ runId, seq: 1, type: "run.started", payload: {}, createdAt: at });
      await runs.appendEvent({ runId, seq: 2, type: "state.entered", payload: {}, createdAt: at });
      await runs.appendEvent({ runId, seq: 3, type: "finish", payload: {}, createdAt: at });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/routines/expense-report/runs/${runId}/events`,
        cookies: authed(),
        headers: { "last-event-id": "2" },
      });
      expect(res.body).not.toContain("event: run.started");
      expect(res.body).toContain("event: finish");
    });

    it("404s for an unknown run", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/routines/expense-report/runs/00000000-0000-0000-0000-000000000000/events",
        cookies: authed(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("webhook seam (D6)", () => {
    it("rejects without or with a wrong secret header", async () => {
      const missing = await app.inject({
        method: "POST",
        url: "/api/v1/hooks/routines/expense-report",
        payload: { amount: 5 },
      });
      expect(missing.statusCode).toBe(401);

      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/hooks/routines/expense-report",
        headers: { [WEBHOOK_SECRET_HEADER]: "nope" },
        payload: { amount: 5 },
      });
      expect(wrong.statusCode).toBe(401);
      expect(enqueuedRuns).toHaveLength(0);
    });

    it("accepts with the right secret, no session/CSRF involved", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/hooks/routines/expense-report",
        headers: { [WEBHOOK_SECRET_HEADER]: "s3cret" },
        payload: { amount: 7 },
      });
      expect(res.statusCode).toBe(202);
      expect(enqueuedRuns).toHaveLength(1);
      const run = await runs.findById((res.json() as { runId: string }).runId);
      expect(run?.trigger.type).toBe("webhook");
      expect(run?.context).toEqual({ amount: 7 });
    });

    it("validates webhook payloads against x-inputs too (D8)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/hooks/routines/expense-report",
        headers: { [WEBHOOK_SECRET_HEADER]: "s3cret" },
        payload: { memo: "missing amount" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("404s when the routine has no webhook trigger", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/hooks/routines/broken",
        headers: { [WEBHOOK_SECRET_HEADER]: "s3cret" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects when the secret is unresolvable (never open)", async () => {
      const soul = makeSoulLoader({
        orphan: {
          ...ROUTINE_CONFIG,
          id: "orphan",
          "x-triggers": [{ type: "webhook", secret_ref: "missing-secret" }],
        },
      });
      const log = { error: vi.fn(), warn: vi.fn() };
      const orphanRegistry = new RoutineRegistry(soul, log);
      orphanRegistry.refresh();
      const orphanRuns = new RoutineRunsRepo(db);
      const enqueuers = {
        enqueueRun: async () => {},
        enqueueWake: async () => {},
      };
      const orphanApp = await buildApp({
        sessionStore: new MemorySessionStore(),
        userRepo: new FakeUserRepo(),
        tokenRepo: new FakeTokenRepo(),
        routines: {
          registry: orphanRegistry,
          runs: orphanRuns,
          triggerService: new RoutineTriggerService({
            registry: orphanRegistry,
            runs: orphanRuns,
            enqueuers,
            log,
          }),
          enqueuers,
          getSecret: async () => {
            throw new Error("secret not found");
          },
        },
      });
      try {
        const res = await orphanApp.inject({
          method: "POST",
          url: "/api/v1/hooks/routines/orphan",
          headers: { [WEBHOOK_SECRET_HEADER]: "anything" },
          payload: { amount: 1 },
        });
        expect(res.statusCode).toBe(401);
        expect((res.json() as { error: string }).error).toContain("not configured");
      } finally {
        await orphanApp.close();
      }
    });
  });
});
