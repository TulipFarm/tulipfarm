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
import type { PaginatedResult } from "../pagination";
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
import {
  type HostedRunReader,
  type HostedToolCall,
  InternalTurnHost,
  type TurnAuthority,
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
  let dispatched: { authority: TurnAuthority; call: HostedToolCall }[];
  let parked: { authority: TurnAuthority; stateKey: string; approvalId: string }[];

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
                contextDigest: "context-digest",
                guardrailDigest: "guardrail-digest",
                guardrailPolicy: { input: [] },
                messages: [{ role: "user", content: `as ${authority.subject.id}` }],
                tools: [],
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
          newId: () => "message-1",
          now: () => CREATED_AT,
        }),
        llmConfig: () => llmConfig,
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
      messages: [{ role: "user", content: "as slack" }],
    });
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
      payload: { attempt: 1, content: "the answer" },
    });
    expect(appended.json()).toEqual({ messageId: "message-1" });

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
});
