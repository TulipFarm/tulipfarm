import { randomUUID } from "node:crypto";
import { LlmNotConfiguredError, type LlmService, UnknownModelError } from "@tulipfarm/llm";
import type { LanguageModelV1 } from "ai";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { TokenDoc, TokenRepo } from "../auth/api-tokens";
import { CSRF_COOKIE, CSRF_HEADER } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MemorySessionStore } from "../auth/session-store";
import { type UserDoc, type UserRepo, createUser } from "../auth/users";
import type { PaginatedResult } from "../pagination";
import type { ConversationDoc, ConversationMessage, ConversationRepo } from "./conversations";
import { buildTurnLog } from "./routes";

const TEST_CSRF = "a".repeat(64);

// ── Deterministic fake LanguageModelV1 (no network) ───────────────────────────
// Yields v4 stream parts: one text-delta then a finish part, so streamText
// produces text "Hello" and onFinish fires with { text: "Hello" }.
function makeStreamResult(textDeltas: string[]) {
  const chunks = [
    ...textDeltas.map((textDelta) => ({ type: "text-delta", textDelta })),
    { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } },
  ];
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  return { stream, rawCall: { rawPrompt: null, rawSettings: {} } };
}

// Stream that emits one delta then an error part — how a v4 provider signals a
// mid-stream failure (finishReason "error"); proves the assistant reply is not persisted.
function makeErrorStreamResult() {
  const chunks = [
    { type: "text-delta", textDelta: "partial" },
    { type: "error", error: new Error("provider exploded") },
  ];
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  return { stream, rawCall: { rawPrompt: null, rawSettings: {} } };
}

function makeFakeModel(
  modelId: string,
  stream: () => ReturnType<typeof makeStreamResult> = () => makeStreamResult(["Hello"])
): LanguageModelV1 {
  return {
    specificationVersion: "v1",
    provider: "test",
    modelId,
    defaultObjectGenerationMode: undefined,
    doStream: vi.fn(async () => stream()),
    doGenerate: vi.fn(async () => {
      throw new Error("doGenerate unused");
    }),
  } as unknown as LanguageModelV1;
}

// ── Fake conversation repo ────────────────────────────────────────────────────
class FakeConversationRepo implements ConversationRepo {
  docs: Map<string, ConversationDoc> = new Map();

  async create(doc: ConversationDoc): Promise<void> {
    this.docs.set(doc._id, { ...doc, messages: [...doc.messages] });
  }
  async findById(id: string): Promise<ConversationDoc | null> {
    return this.docs.get(id) ?? null;
  }
  async appendMessage(id: string, message: ConversationMessage): Promise<void> {
    const doc = this.docs.get(id);
    if (doc) doc.messages.push(message);
  }
}

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

async function waitFor(predicate: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── buildTurnLog unit (AC4) ───────────────────────────────────────────────────
describe("buildTurnLog (AC4 observability)", () => {
  it("records the override and the resolved model id", () => {
    const log = buildTurnLog({
      conversationId: "c1",
      userId: "u1",
      requestedModel: "claude-opus-4-8",
      resolvedModelId: "claude-opus-4-8",
      isNewConversation: true,
    });
    expect(log).toEqual({
      conversationId: "c1",
      userId: "u1",
      requestedModel: "claude-opus-4-8",
      overrideApplied: true,
      resolvedModelId: "claude-opus-4-8",
      isNewConversation: true,
    });
  });

  it("marks overrideApplied false when no model param given", () => {
    const log = buildTurnLog({
      conversationId: "c1",
      userId: "u1",
      requestedModel: undefined,
      resolvedModelId: "claude-sonnet-4-6",
      isNewConversation: false,
    });
    expect(log.overrideApplied).toBe(false);
    expect(log.requestedModel).toBeNull();
  });
});

// ── Route tests ───────────────────────────────────────────────────────────────
describe("POST /api/v1/chat", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let repo: FakeConversationRepo;
  let sid: string;
  let userId: string;
  let select: ReturnType<typeof vi.fn>;
  let llmService: LlmService;

  beforeEach(async () => {
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    repo = new FakeConversationRepo();

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    userId = user._id;
    sid = await store.create(user._id);

    select = vi.fn(() => makeFakeModel("claude-opus-4-8"));
    llmService = { select } as unknown as LlmService;

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      llmService,
      conversationRepo: repo,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function post(
    payload: InjectOptions["payload"],
    opts: { auth?: boolean; csrf?: boolean } = {}
  ): Promise<LightMyRequestResponse> {
    const { auth = true, csrf = true } = opts;
    const cookies: Record<string, string> = {};
    const headers: Record<string, string> = {};
    if (auth) cookies[SESSION_COOKIE] = sid;
    if (csrf) {
      cookies[CSRF_COOKIE] = TEST_CSRF;
      headers[CSRF_HEADER] = TEST_CSRF;
    }
    return app.inject({ method: "POST", url: "/api/v1/chat", cookies, headers, payload });
  }

  const userMsg = (content: string) => ({ role: "user" as const, content });

  it("401 without auth", async () => {
    const res = await post({ message: userMsg("hi") }, { auth: false, csrf: false });
    expect(res.statusCode).toBe(401);
  });

  it("403 when CSRF header missing (session auth)", async () => {
    const res = await post({ message: userMsg("hi") }, { csrf: false });
    expect(res.statusCode).toBe(403);
  });

  it("400 when message missing (body validation)", async () => {
    const res = await post({ model: "claude-opus-4-8" });
    expect(res.statusCode).toBe(400);
  });

  it("400 when message.role is not user", async () => {
    const res = await post({ message: { role: "assistant", content: "hi" } });
    expect(res.statusCode).toBe(400);
  });

  // AC1 — override applies for the turn
  it("uses the overridden model and returns a new conversation id", async () => {
    const res = await post({ message: userMsg("hi"), model: "claude-opus-4-8" });
    expect(res.statusCode).toBe(200);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ sessionModel: "claude-opus-4-8" })
    );
    expect(res.headers["x-conversation-id"]).toBeDefined();
    expect(res.body).toContain("Hello");
  });

  // AC3 — unknown model id → 400, nothing persisted
  it("returns 400 for an unknown model id and persists nothing", async () => {
    select.mockImplementation(() => {
      throw new UnknownModelError("bogus-model");
    });
    const res = await post({ message: userMsg("hi"), model: "bogus-model" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/bogus-model/);
    // New conversation may be created, but no assistant message persisted.
    for (const doc of repo.docs.values()) {
      expect(doc.messages.some((m) => m.role === "assistant")).toBe(false);
    }
  });

  it("returns 503 when the LLM is not configured", async () => {
    select.mockImplementation(() => {
      throw new LlmNotConfiguredError();
    });
    const res = await post({ message: userMsg("hi") });
    expect(res.statusCode).toBe(503);
  });

  // AC2 — next turn without model reverts; override never persisted
  it("reverts to the configured/tier model on a turn without an override", async () => {
    const convoId = randomUUID();
    await repo.create({
      _id: convoId,
      userId,
      model: undefined,
      messages: [{ role: "user", content: "earlier", createdAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const r1 = await post({ conversationId: convoId, message: userMsg("again") });
    expect(r1.statusCode).toBe(200);
    expect(select).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionModel: undefined, model: undefined })
    );

    const r2 = await post({ conversationId: convoId, message: userMsg("now opus"), model: "x" });
    expect(r2.statusCode).toBe(200);
    expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ sessionModel: "x" }));

    // Override never written back to the conversation's stored default.
    expect(repo.docs.get(convoId)?.model).toBeUndefined();
  });

  // Persistence — user then assistant appended
  it("persists the user message then the assistant reply", async () => {
    const res = await post({ message: userMsg("hi there") });
    expect(res.statusCode).toBe(200);
    const id = res.headers["x-conversation-id"] as string;
    await waitFor(() => (repo.docs.get(id)?.messages.length ?? 0) >= 2);
    const msgs = repo.docs.get(id)?.messages ?? [];
    expect(msgs[0]).toMatchObject({ role: "user", content: "hi there" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "Hello" });
  });

  it("404 when conversationId is not found", async () => {
    const res = await post({ conversationId: randomUUID(), message: userMsg("hi") });
    expect(res.statusCode).toBe(404);
  });

  it("404 when conversation is owned by another user", async () => {
    const convoId = randomUUID();
    await repo.create({
      _id: convoId,
      userId: "someone-else",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await post({ conversationId: convoId, message: userMsg("hi") });
    expect(res.statusCode).toBe(404);
    expect(repo.docs.get(convoId)?.messages.length).toBe(0);
  });

  // Aborted stream — user persisted, assistant not (onFinish gating)
  it("does not persist an assistant message when the stream errors", async () => {
    select.mockImplementation(() => makeFakeModel("claude-opus-4-8", makeErrorStreamResult));
    const res = await post({ message: userMsg("hi") });
    const id = res.headers["x-conversation-id"] as string;
    await waitFor(() => (repo.docs.get(id)?.messages.length ?? 0) >= 1);
    const msgs = repo.docs.get(id)?.messages ?? [];
    expect(msgs.some((m) => m.role === "user")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant")).toBe(false);
  });
});
