import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { DurableWaitManager, RunResumeGateway } from "@tulipfarm/run-kernel";
import { RunStore, WaitStore } from "@tulipfarm/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { type Queryable, transactionPort } from "../db";
import type { PaginatedResult } from "../pagination";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import { ApprovalsRepo } from "./runtime-repo";
import { ToolApprovalService } from "./tool-approvals";

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

/**
 * The same route, deciding an approval a Worker-executed turn parked on.
 *
 * The whole surface is one endpoint on purpose — an operator decides an approval without knowing
 * which process is waiting for it. What the route must get right is the order: the in-process gate
 * settles any pending row it is shown and reports success, so asking it first would record the
 * decision and leave the Run parked with nothing left to resume it.
 */
describe("approval routes — durable tool_call kind", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let sid: string;
  let approvals: ApprovalsRepo;
  let toolApprovals: ToolApprovalService;
  let runs: RunStore;
  let userId: string;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    approvals = new ApprovalsRepo(db);

    const transactions = transactionPort(db as unknown as Queryable);
    runs = new RunStore(transactions);
    toolApprovals = new ToolApprovalService({
      repo: approvals,
      waits: new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)),
    });

    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    userId = user._id;
    sid = await store.create(user._id);

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      approvalsRepo: approvals,
      toolApprovals,
      llmService: { getModel: vi.fn() } as never,
      conversationRepo: {} as never,
      messageRepo: {} as never,
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const authed = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });
  const csrf = { [CSRF_HEADER]: TEST_CSRF };

  /** A Run parked on an approval, as the Worker leaves it. */
  async function parkedRun(subjectId = userId): Promise<{ runId: string; approvalId: string }> {
    const runId = randomUUID();
    await runs.start({
      id: runId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      createdAt: new Date().toISOString(),
      bundle: { digest: "bundle-digest", routineId: "chat", routineVersion: "1" },
      identity: {
        initiator: { kind: "user", id: subjectId },
        effectiveSubject: { kind: "user", id: subjectId },
        guardrailContextRef: "guardrails:1",
      },
      bounds: { wallTimeMs: 60_000, activeTimeMs: 60_000, attempts: 1, sideEffects: 8 },
      states: [
        {
          key: "invoke",
          definitionRef: "published:agent:assistant",
          resolvedInput: { payloadRef: `artifact:${runId}:request` },
        },
      ],
    });

    const decision = await toolApprovals.decide({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      toolCallId: "call-1",
      toolName: "record_delete",
      args: { id: "record-1" },
    });
    if (decision.status !== "pending") throw new Error("expected a pending approval");

    await toolApprovals.registerWait({
      businessId: DEPLOYMENT_BUSINESS_ID,
      runId,
      stateKey: "invoke",
      approvalId: decision.approvalId,
      subject: { kind: "user", id: subjectId },
    });
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "running",
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 2,
      expectedStatus: "running",
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return { runId, approvalId: decision.approvalId };
  }

  it("requeues the parked Run rather than letting the in-process gate settle it", async () => {
    const { runId, approvalId } = await parkedRun();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decide`,
      cookies: authed(),
      headers: csrf,
      payload: { decision: "approve" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "approve" });
    expect((await approvals.findById(approvalId))?.status).toBe("approved");
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "queued" });
  });

  it("refuses a decision from someone the Run does not act as", async () => {
    const { runId, approvalId } = await parkedRun("someone-else");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decide`,
      cookies: authed(),
      headers: csrf,
      payload: { decision: "approve" },
    });

    expect(res.statusCode).toBe(403);
    expect((await approvals.findById(approvalId))?.status).toBe("pending");
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "waiting" });
  });

  it("404s a replayed decision without resuming the Run twice", async () => {
    const { runId, approvalId } = await parkedRun();
    const decide = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/approvals/${approvalId}/decide`,
        cookies: authed(),
        headers: csrf,
        payload: { decision: "approve" },
      });

    expect((await decide()).statusCode).toBe(200);
    // The Worker has picked the Run back up by the time the second click lands.
    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 4,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-2",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect((await decide()).statusCode).toBe(404);
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "claimed" });
  });
});
