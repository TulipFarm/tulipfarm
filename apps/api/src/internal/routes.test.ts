import { textContent } from "@tulipfarm/schema";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { HostedAgent } from "@tulipfarm/tool-host";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/routes";
import { MemorySessionStore } from "../auth/session-store";
import { createUser, type UserDoc, type UserRepo } from "../auth/users";
import { createApiClient, formatApiClientCredential } from "../identity/api-clients";
import { MemoryApiClientRepo } from "../identity/fakes";
import {
  BUSINESS_ID,
  CONVERSATION_ID,
  CREATED_AT,
  FakeConversationStore,
  fakeRuns,
  RUN_ID,
  TURN_ID,
  turn,
} from "../test/turn-host-fixtures";
import type {
  InternalRoutineApprovalHost,
  OpenRoutineApprovalInput,
  RoutineApprovalDecision,
  RoutineApprovalDenial,
} from "./routine-approval-host";
import { RoutineApprovalDeniedError } from "./routine-approval-host";
import {
  type HostedRunReader,
  type HostedToolCall,
  InternalTurnHost,
  type RunAuthority,
} from "./turn-host";

const TEST_CSRF = "a".repeat(64);

class FakeUserRepo implements UserRepo {
  private users: UserDoc[] = [];
  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.users.find((user) => user.email === email.trim().toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<UserDoc | null> {
    return this.users.find((user) => user._id === id) ?? null;
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

describe("/api/v1/internal/turns", () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let workerCredential: string;
  let store: FakeConversationStore;
  let runs: HostedRunReader;
  let llmConfig: unknown;
  let pricingOverrides: Record<string, { in: number; out: number }> = {};
  let dispatched: { authority: RunAuthority; call: HostedToolCall }[];
  let parked: { authority: RunAuthority; stateKey: string; approvalId: string }[];
  let hostedAgent: HostedAgent | undefined;

  beforeEach(async () => {
    const sessions = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "admin");
    sessionCookie = await sessions.create(user._id);

    const apiClientRepo = new MemoryApiClientRepo();
    const { doc, secret } = await createApiClient(apiClientRepo, {
      name: "worker",
      ownerUserId: user._id,
    });
    workerCredential = formatApiClientCredential(doc.clientId, secret);

    store = new FakeConversationStore();
    store.turns.push(turn());
    runs = fakeRuns({ subject: { kind: "integration", id: "slack" } });
    llmConfig = undefined;
    dispatched = [];
    parked = [];
    hostedAgent = undefined;

    app = await buildApp({
      sessionStore: sessions,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      identity: { apiClientRepo },
      internalTurns: {
        host: new InternalTurnHost({
          get runs() {
            return runs;
          },
          store,
          context: {
            async resolve(authority) {
              return {
                agentId: "assistant",
                subjectId: authority.subject.id,
                modelProfileId: "model-1",
                modelPolicy: { residency: "eu", dataRetention: "none" as const },
                principal: { kind: authority.subject.kind, id: authority.subject.id },
                contextDigest: "context-digest",
                guardrailDigest: "guardrail-digest",
                guardrailPolicy: { input: [] },
                messages: [{ role: "user", content: textContent(`as ${authority.subject.id}`) }],
                tools: [
                  {
                    name: "record_create",
                    inputSchema: { type: "object" },
                    tier: "business",
                    mutating: true,
                  },
                ],
                limits: { maxIterations: 25, maxToolCalls: 25, maxRepairAttempts: 2 },
                compacted: false,
              };
            },
          },
          tools: {
            async dispatch(authority, call) {
              dispatched.push({ authority, call });
              return { status: "succeeded", output: { ok: true } };
            },
          },
          approvals: {
            async registerWait(authority, input) {
              parked.push({ authority, ...input });
              return { waitId: "wait-1" };
            },
          },
          agentForRun: async () => hostedAgent,
          newId: () => "message-1",
          now: () => CREATED_AT,
        }),
        llmConfig: () => llmConfig,
        pricingOverrides: () => pricingOverrides,
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const asWorker = () => ({ authorization: `Bearer ${workerCredential}` });

  it("names the Turn a Run is answering, so the Worker can key its events", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/internal/turns/${RUN_ID}`,
      headers: asWorker(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ turnId: TURN_ID, conversationId: CONVERSATION_ID, attempt: 1 });
  });

  it("serves the LLM configuration by reference, and says so when none is published", async () => {
    const absent = await app.inject({
      method: "GET",
      url: "/api/v1/internal/llm/config",
      headers: asWorker(),
    });
    expect(absent.statusCode).toBe(204);

    // Credentials are named, never carried — the Worker resolves the ref against the secret store.
    llmConfig = { tiers: { fast: { providers: [{ provider: "anthropic", api_key_ref: "key" }] } } };
    const published = await app.inject({
      method: "GET",
      url: "/api/v1/internal/llm/config",
      headers: asWorker(),
    });
    expect(published.json()).toEqual(llmConfig);
  });

  it("serves operator price corrections, so the Worker charges what this app reports", async () => {
    const none = await app.inject({
      method: "GET",
      url: "/api/v1/internal/observability/pricing",
      headers: asWorker(),
    });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ overrides: {} });

    // The Worker owns the branch that charges the Run budget. An override that reached only the
    // reporting side corrected the report and left enforcement on the uncorrected price.
    pricingOverrides = { "claude-opus-4-8": { in: 1, out: 2 } };
    const corrected = await app.inject({
      method: "GET",
      url: "/api/v1/internal/observability/pricing",
      headers: asWorker(),
    });
    expect(corrected.json()).toEqual({ overrides: pricingOverrides });
  });

  it("refuses price corrections to anything but a service principal", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/internal/observability/pricing",
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("serves the turn's Context to a service principal", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/context`,
      headers: asWorker(),
    });

    expect(res.statusCode).toBe(200);
    // The subject came from the Run, and the worker never named one.
    expect(res.json()).toMatchObject({
      contextDigest: "context-digest",
      messages: [{ role: "user", content: textContent("as slack") }],
    });
  });

  it("carries the Agent's model governance to the Worker", async () => {
    // Fastify strips undeclared properties on serialization, so an omission in the response
    // schema would drop the governance demand here with no error anywhere.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/context`,
      headers: asWorker(),
    });

    expect(res.json().modelPolicy).toEqual({ residency: "eu", dataRetention: "none" });
  });

  it("carries each Tool's mutating flag to the Worker", async () => {
    // Skill narrowing may hide a read and never a write (#419); stripped here, every Tool reaches
    // the loop looking like a read and the write vanishes from the offer with no error anywhere.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/context`,
      headers: asWorker(),
    });

    expect(res.json().tools).toEqual([
      { name: "record_create", inputSchema: { type: "object" }, tier: "business", mutating: true },
    ]);
  });

  it("carries the acting principal to the Worker, kind included", async () => {
    // `subjectId` alone cannot name a principal, and a stripped principal would silently send
    // every model call back to acting as the deployment.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/context`,
      headers: asWorker(),
    });

    // The subject came from the Run, not from the caller — the worker never named one.
    expect(res.json().principal).toEqual({ kind: "integration", id: "slack" });
  });

  it("refuses a signed-in person, so a browser cannot reach the turn machinery", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/context`,
      cookies: { [SESSION_COOKIE]: sessionCookie, [CSRF_COOKIE]: TEST_CSRF },
      headers: { "x-csrf-token": TEST_CSRF },
    });

    expect(res.statusCode).toBe(403);
  });

  it("requires a credential at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/context`,
    });

    expect(res.statusCode).toBe(401);
  });

  it("separates an unknown Run from one no executor may write for", async () => {
    runs = fakeRuns(null);
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/context`,
      headers: asWorker(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "run_not_found" });

    // A redelivered job, or a worker whose lease was already reclaimed.
    runs = fakeRuns({ status: "succeeded" });
    const settled = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/context`,
      headers: asWorker(),
    });
    expect(settled.statusCode).toBe(409);
    expect(settled.json()).toEqual({ error: "run_not_running" });
  });

  it("dispatches a Tool call under the Run's authority", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/tools`,
      headers: asWorker(),
      payload: { callId: "call-1", name: "record_create", arguments: { title: "x" } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "succeeded", output: { ok: true } });
    expect(dispatched[0]?.authority.subject).toEqual({ kind: "integration", id: "slack" });
    expect(dispatched[0]?.call).toEqual({
      callId: "call-1",
      name: "record_create",
      arguments: { title: "x" },
    });
  });

  it("parks a Run on an approval wait and tells the Worker only its id", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/approvals/approval-1/wait`,
      headers: asWorker(),
      payload: { stateKey: "invoke" },
    });

    expect(res.statusCode).toBe(200);
    // The resume token stays behind: what comes back can name the wait but never redeem it.
    expect(res.json()).toEqual({ waitId: "wait-1" });
    expect(parked[0]).toMatchObject({ stateKey: "invoke", approvalId: "approval-1" });
    // Who may decide follows from the Run's subject, which the Worker never supplied.
    expect(parked[0]?.authority.subject).toEqual({ kind: "integration", id: "slack" });
  });

  it("writes the reply, then completes the Turn, and replays what an attempt recorded", async () => {
    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/internal/turns/${RUN_ID}/completion?attempt=1`,
      headers: asWorker(),
    });
    expect(empty.statusCode).toBe(204);

    const appended = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/messages`,
      headers: asWorker(),
      payload: {
        attempt: 1,
        content: "the answer",
        metadata: {
          toolCalls: [
            {
              callId: "call-1",
              name: "record_create",
              argsDigest: "sha256:args",
              argsPreview: { json: '{"title":"x"}', bytes: 13 },
              resultPreview: { json: '{"ok":true}', bytes: 11 },
              durationMs: 25,
              outcome: "ok",
            },
          ],
        },
      },
    });
    expect(appended.json()).toEqual({ messageId: "message-1" });
    expect(store.messages[0]?.metadata).toEqual({
      toolCalls: [
        {
          callId: "call-1",
          name: "record_create",
          argsDigest: "sha256:args",
          argsPreview: { json: '{"title":"x"}', bytes: 13 },
          resultPreview: { json: '{"ok":true}', bytes: 11 },
          durationMs: 25,
          outcome: "ok",
        },
      ],
    });

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/internal/turns/${RUN_ID}/completion`,
      headers: asWorker(),
      payload: { attempt: 1, status: "succeeded", cursor: 12, messageId: "message-1" },
    });
    expect(completed.statusCode).toBe(200);

    // What a redelivered job asks before it produces a second answer.
    const recorded = await app.inject({
      method: "GET",
      url: `/api/v1/internal/turns/${RUN_ID}/completion?attempt=1`,
      headers: asWorker(),
    });
    expect(recorded.json()).toEqual({
      turnId: TURN_ID,
      attempt: 1,
      status: "succeeded",
      messageId: "message-1",
      cursor: 12,
    });
    expect(store.turns[0]).toMatchObject({ businessId: BUSINESS_ID, status: "succeeded" });
  });

  it("hands the Worker the Agent's capability restrictions with the Run's authority", async () => {
    hostedAgent = {
      name: "reporter",
      autonomy: "approval-required",
      capabilityRestrictions: {
        tools: { allowMutating: false },
        records: { actions: { allow: ["list", "read"] } },
      },
    };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/internal/turns/${RUN_ID}/authority`,
      headers: asWorker(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toEqual(hostedAgent);
  });

  it("names the Routine a Routine Run executes", async () => {
    runs = fakeRuns({ source: "routine", subject: { kind: "user", id: "user-1" } });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/internal/turns/${RUN_ID}/authority`,
      headers: asWorker(),
    });

    expect(res.statusCode).toBe(200);
    // Routine-only Tools — `complete_state`, `call_skill` — refuse a call that names no Routine,
    // so dropping this in the projection leaves a Routine Agent State unable to complete itself.
    expect(res.json().routineId).toBe("routine-id");
  });

  it("omits the Routine for a Run that executes none", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/internal/turns/${RUN_ID}/authority`,
      headers: asWorker(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().routineId).toBeUndefined();
  });

  it("omits the Agent when the control plane cannot name one", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/internal/turns/${RUN_ID}/authority`,
      headers: asWorker(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toBeUndefined();
  });
});

describe("/api/v1/internal/runs/:runId/routine-approvals", () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let workerCredential: string;
  let opened: { runId: string; input: OpenRoutineApprovalInput }[];
  let decision: RoutineApprovalDecision | "absent";
  let denial: RoutineApprovalDenial | null;

  const wait = {
    id: "wait-1",
    stateKey: "Fanout#0/Approve",
    kind: "approval",
    aggregation: "first",
    schemaRef: "wait:approval:Approve",
    allowedPrincipals: ["role:finance"],
    expectedSignals: 1,
    quorum: null,
    deadlineAt: "2026-08-02T00:01:00.000Z",
    createdAt: "2026-08-02T00:00:00.000Z",
  };

  beforeEach(async () => {
    const sessions = new MemorySessionStore();
    const userRepo = new FakeUserRepo();
    const user = await createUser(userRepo, "user@example.com", "pass", "admin");
    sessionCookie = await sessions.create(user._id);

    const apiClientRepo = new MemoryApiClientRepo();
    const { doc, secret } = await createApiClient(apiClientRepo, {
      name: "worker",
      ownerUserId: user._id,
    });
    workerCredential = formatApiClientCredential(doc.clientId, secret);

    opened = [];
    decision = "pending";
    denial = null;

    const refuse = () => {
      if (denial !== null) throw new RoutineApprovalDeniedError(denial);
    };
    const routineApprovals = {
      async open(_businessId: string, runId: string, input: OpenRoutineApprovalInput) {
        refuse();
        opened.push({ runId, input });
        return { approvalId: "wait-1", waitId: "wait-1", decision: "pending" as const };
      },
      async find() {
        refuse();
        if (decision === "absent") return undefined;
        return { approvalId: "wait-1", waitId: "wait-1", decision };
      },
    } as unknown as InternalRoutineApprovalHost;

    app = await buildApp({
      sessionStore: sessions,
      userRepo,
      tokenRepo: new FakeTokenRepo(),
      identity: { apiClientRepo },
      internalTurns: {
        // The turn host is required to register the area; nothing here reaches it.
        host: new InternalTurnHost({
          runs: fakeRuns({ subject: { kind: "user", id: "user-1" } }),
          store: new FakeConversationStore(),
          context: {
            async resolve() {
              throw new Error("not used");
            },
          },
          tools: {
            async dispatch() {
              throw new Error("not used");
            },
          },
        }),
        llmConfig: () => undefined,
        pricingOverrides: () => ({}),
        routineApprovals,
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const asWorker = () => ({ authorization: `Bearer ${workerCredential}` });

  it("opens the approval from the planned wait, taking the Run from the path", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-approvals`,
      headers: asWorker(),
      payload: { stateKey: "Fanout#0/Approve", stateName: "Approve", wait },
    });

    expect(res.statusCode).toBe(200);
    // The resume token stays here: what comes back names the wait but cannot redeem it.
    expect(res.json()).toEqual({ approvalId: "wait-1", waitId: "wait-1", decision: "pending" });
    expect(opened[0]?.runId).toBe(RUN_ID);
    expect(opened[0]?.input.wait).toEqual(wait);
  });

  it("drops a body claiming which business or Run the wait belongs to", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-approvals`,
      headers: asWorker(),
      payload: {
        stateKey: "Fanout#0/Approve",
        stateName: "Approve",
        wait: { ...wait, businessId: "someone-else", runId: "another-run" },
      },
    });

    // Which Run a wait belongs to is the Run's to state, so a body claiming it reaches nothing:
    // the schema strips both fields and the host registers the wait against the path's Run.
    expect(res.statusCode).toBe(200);
    expect(opened[0]?.runId).toBe(RUN_ID);
    expect(opened[0]?.input.wait).toEqual(wait);
  });

  it("serves the decision, and 204 when this State occurrence has no approval open", async () => {
    decision = "approved";
    const decided = await app.inject({
      method: "GET",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-approvals?stateKey=Fanout%230%2FApprove`,
      headers: asWorker(),
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ decision: "approved" });

    decision = "absent";
    const absent = await app.inject({
      method: "GET",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-approvals?stateKey=Fanout%230%2FApprove`,
      headers: asWorker(),
    });
    expect(absent.statusCode).toBe(204);
  });

  it("separates a Run that is gone from one no executor is holding", async () => {
    denial = "run_not_found";
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-approvals?stateKey=Approve`,
      headers: asWorker(),
    });
    expect(missing.statusCode).toBe(404);

    denial = "run_not_running";
    const parked = await app.inject({
      method: "GET",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-approvals?stateKey=Approve`,
      headers: asWorker(),
    });
    expect(parked.statusCode).toBe(409);

    denial = "not_a_routine";
    const other = await app.inject({
      method: "GET",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-approvals?stateKey=Approve`,
      headers: asWorker(),
    });
    expect(other.statusCode).toBe(400);
  });

  it("refuses a signed-in person, so a browser cannot open or read a Run's approval", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/internal/runs/${RUN_ID}/routine-approvals?stateKey=Approve`,
      headers: { cookie: `${SESSION_COOKIE}=${sessionCookie}; ${CSRF_COOKIE}=${TEST_CSRF}` },
    });

    expect(res.statusCode).toBe(403);
  });
});
