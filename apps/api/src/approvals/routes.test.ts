import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { DurableWaitManager, RunResumeGateway } from "@tulipfarm/run-kernel";
import type { PaginatedResult } from "@tulipfarm/storage";
import { RunStore, WaitStore } from "@tulipfarm/storage";
import { ApprovalsRepo, ToolApprovalService } from "@tulipfarm/tool-host";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { type Queryable, transactionPort, withTransaction } from "../db";
import { InternalRoutineApprovalHost } from "../internal/routine-approval-host";
import { makeMigratedPglite } from "../test/pglite";
import { RoutineApprovalService } from "./routine-approvals";

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
 * `routine_state` rows on the shared list surface. Listing needs only the approvals repo — the
 * decide path for this kind is exercised against its durable owner in the "decided by role" block.
 */
describe("approval routes — routine_state kind", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let sid: string;
  let approvals: ApprovalsRepo;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    approvals = new ApprovalsRepo(db);

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
    });
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const authed = () => ({ [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF });

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

  it("does not disclose routine_state approvals without the service that authorizes them", async () => {
    const { id } = await insertRoutineApproval();
    const res = await app.inject({ method: "GET", url: "/api/v1/approvals", cookies: authed() });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<Record<string, unknown>> };
    expect(items.find((item) => item.approvalId === id)).toBeUndefined();
  });
});

/** Worker-parked approvals must resume before any in-process gate can consume the decision. */
describe("approval routes — durable tool_call kind", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let sid: string;
  let approvals: ApprovalsRepo;
  let toolApprovals: ToolApprovalService;
  let runs: RunStore;
  let userId: string;

  beforeEach(async () => {
    db = await makeMigratedPglite();
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
      source: "chat",
      createdAt: new Date().toISOString(),
      bundle: { digest: "bundle-digest", routineId: "chat", routineVersion: "1" },
      identity: {
        initiator: { kind: "user", id: subjectId },
        effectiveSubject: { kind: "user", id: subjectId },
        guardrailContextRef: "guardrails:1",
      },
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
      requesterPrincipalId: `user:${subjectId}`,
      demand: {
        demandedBy: "guardrail_rule",
        guardrailRevision: "gr-1",
        reason: "approval_required",
        ruleId: "rule-1",
      },
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

describe("approval routes — routine_state kind, decided by role", () => {
  let app: FastifyInstance;
  let db: PGlite;
  let approvals: ApprovalsRepo;
  let runs: RunStore;
  let host: InternalRoutineApprovalHost;

  /** Signs in a user carrying `role`, so the decide route derives that role from the session. */
  async function signIn(role: "admin" | "member"): Promise<{ app: FastifyInstance; sid: string }> {
    const store = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, `${role}@example.com`, "pass", role);
    const sid = await store.create(user._id);

    const queryable = db as unknown as Queryable;
    const transactions = transactionPort(queryable);
    const built = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      approvalsRepo: approvals,
      routineApprovals: new RoutineApprovalService({
        repo: approvals,
        waits: new DurableWaitManager(new WaitStore(transactions), new RunResumeGateway(runs)),
      }),
      llmService: { getModel: vi.fn() } as never,
      conversationRepo: {} as never,
      messageRepo: {} as never,
    });
    return { app: built, sid };
  }

  beforeEach(async () => {
    db = await makeMigratedPglite();
    approvals = new ApprovalsRepo(db);

    const queryable = db as unknown as Queryable;
    const transactions = transactionPort(queryable);
    runs = new RunStore(transactions);
    host = new InternalRoutineApprovalHost({
      runs,
      db: queryable,
      withTransaction: (operation) => withTransaction(queryable, operation),
      resume: new RunResumeGateway(runs),
    });
  });

  afterEach(async () => {
    await app?.close();
    await db.close();
  });

  /** A Routine Run parked on an approval its State authored for `role`. */
  async function parkedRun(role: string): Promise<{ runId: string; approvalId: string }> {
    const runId = randomUUID();
    const now = new Date();
    await runs.start({
      id: runId,
      businessId: DEPLOYMENT_BUSINESS_ID,
      source: "routine",
      createdAt: now.toISOString(),
      bundle: { digest: "bundle-digest", routineId: "routine-1", routineVersion: "1" },
      identity: {
        initiator: { kind: "user", id: "author" },
        effectiveSubject: { kind: "user", id: "author" },
        guardrailContextRef: "guardrails:1",
      },
      states: [
        {
          key: "Approve",
          definitionRef: "published:routine:invoice#1",
          resolvedInput: { payloadRef: `artifact:${runId}:request` },
        },
      ],
    });
    for (const step of [
      { expectedVersion: 0, expectedStatus: "queued" as const, status: "claimed" as const },
      { expectedVersion: 1, expectedStatus: "claimed" as const, status: "running" as const },
    ]) {
      await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
        ...step,
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }

    const opened = await host.open(DEPLOYMENT_BUSINESS_ID, runId, {
      stateKey: "Approve",
      stateName: "Approve",
      wait: {
        id: randomUUID(),
        stateKey: "Approve",
        kind: "approval",
        aggregation: "first",
        schemaRef: "wait:approval:Approve",
        allowedPrincipals: [`role:${role}`],
        expectedSignals: 1,
        quorum: null,
        deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
        createdAt: now.toISOString(),
      },
    });

    await runs.transitionRun(DEPLOYMENT_BUSINESS_ID, runId, {
      expectedVersion: 2,
      expectedStatus: "running",
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    return { runId, approvalId: opened.approvalId };
  }

  async function decide(sid: string, approvalId: string): Promise<number> {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decide`,
      cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
      headers: { [CSRF_HEADER]: TEST_CSRF },
      payload: { decision: "approve" },
    });
    return res.statusCode;
  }

  it("requeues the parked Run for a decider holding the role the State authored", async () => {
    const { runId, approvalId } = await parkedRun("admin");
    const session = await signIn("admin");
    app = session.app;

    expect(await decide(session.sid, approvalId)).toBe(200);
    expect((await approvals.findById(approvalId))?.status).toBe("approved");
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "queued" });
  });

  it("refuses a decider holding no role the State named, leaving the Run parked", async () => {
    const { runId, approvalId } = await parkedRun("admin");
    const session = await signIn("member");
    app = session.app;

    expect(await decide(session.sid, approvalId)).toBe(403);
    expect((await approvals.findById(approvalId))?.status).toBe("pending");
    expect(await runs.find(DEPLOYMENT_BUSINESS_ID, runId)).toMatchObject({ status: "waiting" });
  });

  it("hides a pending routine approval from a user without the State's approver role", async () => {
    const { approvalId } = await parkedRun("admin");
    const member = await signIn("member");
    app = member.app;

    const hidden = await app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      cookies: { [SESSION_COOKIE]: member.sid },
    });

    expect(hidden.statusCode).toBe(200);
    expect(
      (hidden.json() as { items: Array<{ approvalId: string }> }).items.find(
        (item) => item.approvalId === approvalId
      )
    ).toBeUndefined();
    await app.close();

    const admin = await signIn("admin");
    app = admin.app;
    const visible = await app.inject({
      method: "GET",
      url: "/api/v1/approvals",
      cookies: { [SESSION_COOKIE]: admin.sid },
    });

    expect(visible.statusCode).toBe(200);
    expect(
      (visible.json() as { items: Array<{ approvalId: string }> }).items.find(
        (item) => item.approvalId === approvalId
      )
    ).toBeDefined();
  });
});
