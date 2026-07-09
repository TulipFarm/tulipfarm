import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { ApprovalsRepo } from "./repo";

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

/**
 * routine_state approvals require the routes to be registered with routineDeps, which
 * app.ts only wires when BOTH approvalsRepo and routines options are present. The chat
 * deps (llmService/conversationRepo/messageRepo) gate route registration — fake the
 * minimum surface.
 */
describe("approval routes — routine_state kind", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let sid: string;
  let approvals: ApprovalsRepo;
  let wakes: Array<Record<string, unknown>>;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    approvals = new ApprovalsRepo(db);
    wakes = [];

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    sid = await store.create(user._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      approvalsRepo: approvals,
      // minimal chat deps so the approvals routes register
      llmService: { getModel: vi.fn() } as never,
      conversationRepo: {} as never,
      messageRepo: {} as never,
      routines: {
        registry: { list: () => [], getEntry: () => undefined, get: () => undefined } as never,
        runs: {} as never,
        triggerService: {} as never,
        enqueuers: {
          enqueueRun: async () => {},
          enqueueWake: async (job: Record<string, unknown>) => {
            wakes.push(job);
          },
        } as never,
        getSecret: async () => "",
      },
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const authed = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const csrf = { [CSRF_HEADER]: TEST_CSRF };

  async function insertRoutineApproval(runId = randomUUID()) {
    const id = randomUUID();
    await approvals.insert({
      id,
      kind: "routine_state",
      payload: {
        routineSlug: "expense-report",
        runId,
        stateName: "Gate",
        channels: ["ui"],
        summary: { amount: 900 },
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { id, runId };
  }

  it("lists pending routine_state approvals with kind discrimination", async () => {
    const { id } = await insertRoutineApproval();
    const res = await app.inject({ method: "GET", url: "/api/v1/approvals", cookies: authed() });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<Record<string, unknown>> };
    const item = items.find((i) => i.approvalId === id);
    expect(item).toMatchObject({
      kind: "routine_state",
      routineSlug: "expense-report",
      stateName: "Gate",
      summary: { amount: 900 },
    });
  });

  it("decide approves a routine_state approval and wakes the run", async () => {
    const { id, runId } = await insertRoutineApproval();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${id}/decide`,
      cookies: authed(),
      headers: csrf,
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(200);
    expect((await approvals.findById(id))?.status).toBe("approved");
    expect(wakes).toEqual([
      expect.objectContaining({ runId, reason: "approval", decision: "approved" }),
    ]);
  });

  it("decide denies and wakes with denied", async () => {
    const { id, runId } = await insertRoutineApproval();
    await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${id}/decide`,
      cookies: authed(),
      headers: csrf,
      payload: { decision: "deny" },
    });
    expect((await approvals.findById(id))?.status).toBe("denied");
    expect(wakes[0]).toMatchObject({ runId, decision: "denied" });
  });

  it("404s on already-settled approvals", async () => {
    const { id } = await insertRoutineApproval();
    await approvals.settle(id, "approved");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${id}/decide`,
      cookies: authed(),
      headers: csrf,
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(404);
    expect(wakes).toHaveLength(0);
  });
});
