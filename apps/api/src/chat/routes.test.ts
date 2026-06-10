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
import { WorkingMemoryService } from "../memory/service";
import {
  type WorkingMemoryDoc,
  type WorkingMemoryRepo,
  assertValidEntry,
} from "../memory/working-memory";
import { type PaginatedResult, encodeCursor } from "../pagination";
import { ToolRegistry } from "../tools/registry";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import type { MessageDoc, MessagePart, MessageRepo } from "./messages";
import { buildTurnLog, parseLastEventId } from "./routes";
import { StreamHub } from "./stream-hub";
import { MemoryStreamResumeRepo } from "./stream-resume";

const TEST_CSRF = "a".repeat(64);

// Captures the `prompt` (converted CoreMessages) that streamText hands the model
// on each call, so history-rebuild assertions can inspect the outgoing messages.
const capturedPrompts: unknown[][] = [];

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

// Stream that emits provider-level tool-call parts (args is a JSON string) then a tool-calls finish,
// so streamText invokes the bound tool's execute and (with maxSteps>1) requests a continuation.
function makeToolCallStreamResult(
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>
) {
  const chunks = [
    ...toolCalls.map((tc) => ({
      type: "tool-call",
      toolCallType: "function",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: JSON.stringify(tc.args),
    })),
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { promptTokens: 1, completionTokens: 1 },
    },
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
    doStream: vi.fn(async (options: { prompt: unknown[] }) => {
      capturedPrompts.push(options.prompt);
      return stream();
    }),
    doGenerate: vi.fn(async () => {
      throw new Error("doGenerate unused");
    }),
  } as unknown as LanguageModelV1;
}

// Model that calls a tool on its first step, then returns text on the continuation step.
function makeToolThenTextModel(
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>,
  followupText: string
): LanguageModelV1 {
  let call = 0;
  return makeFakeModel("claude-opus-4-8", () => {
    call += 1;
    return call === 1
      ? (makeToolCallStreamResult(toolCalls) as ReturnType<typeof makeStreamResult>)
      : makeStreamResult([followupText]);
  });
}

// ── Fake conversation repo ────────────────────────────────────────────────────
class FakeConversationRepo implements ConversationRepo {
  docs: Map<string, ConversationDoc> = new Map();

  async create(doc: ConversationDoc): Promise<void> {
    this.docs.set(doc._id, { ...doc });
  }
  async findById(id: string): Promise<ConversationDoc | null> {
    return this.docs.get(id) ?? null;
  }
  async touch(id: string): Promise<void> {
    const doc = this.docs.get(id);
    if (doc) doc.updatedAt = new Date();
  }
}

// ── Fake message repo ─────────────────────────────────────────────────────────
class FakeMessageRepo implements MessageRepo {
  messages: MessageDoc[] = [];

  async create(doc: MessageDoc): Promise<void> {
    this.messages.push(doc);
  }

  async listByConversation(
    conversationId: string,
    limit: number,
    after?: { createdAt: Date; _id: string }
  ): Promise<PaginatedResult<MessageDoc>> {
    const sorted = this.messages
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        return byTime !== 0 ? byTime : a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
      });

    const start = after
      ? sorted.findIndex(
          (m) =>
            m.createdAt.getTime() > after.createdAt.getTime() ||
            (m.createdAt.getTime() === after.createdAt.getTime() && m._id > after._id)
        )
      : 0;
    const window = start === -1 ? [] : sorted.slice(start, start + limit + 1);

    const hasMore = window.length > limit;
    const items = hasMore ? window.slice(0, limit) : window;
    const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;
    return { items, nextCursor };
  }

  byConversation(conversationId: string): MessageDoc[] {
    return this.messages.filter((m) => m.conversationId === conversationId);
  }
}

// ── Fake working-memory repo ──────────────────────────────────────────────────
class FakeWorkingMemoryRepo implements WorkingMemoryRepo {
  docs: WorkingMemoryDoc[] = [];
  async upsert(doc: WorkingMemoryDoc): Promise<void> {
    assertValidEntry(doc);
    const i = this.docs.findIndex((d) => d.userId === doc.userId && d.key === doc.key);
    if (i >= 0) this.docs[i] = { ...doc };
    else this.docs.push({ ...doc });
  }
  async deleteByKey(userId: string, key: string): Promise<boolean> {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !(d.userId === userId && d.key === key));
    return this.docs.length < before;
  }
  async listByUser(userId: string): Promise<WorkingMemoryDoc[]> {
    return this.docs.filter((d) => d.userId === userId).map((d) => ({ ...d }));
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

function userMessage(conversationId: string, text: string, createdAt: Date): MessageDoc {
  return { _id: randomUUID(), conversationId, role: "user", content: text, createdAt };
}

function assistantMessage(conversationId: string, text: string, createdAt: Date): MessageDoc {
  return { _id: randomUUID(), conversationId, role: "assistant", content: text, createdAt };
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

describe("parseLastEventId", () => {
  it("prefers a valid Last-Event-ID header", () => {
    expect(parseLastEventId("5", undefined)).toBe(5);
    expect(parseLastEventId(["7", "1"], undefined)).toBe(7);
  });
  it("falls back to the query, then to 0", () => {
    expect(parseLastEventId(undefined, 3)).toBe(3);
    expect(parseLastEventId(undefined, undefined)).toBe(0);
    expect(parseLastEventId("", undefined)).toBe(0);
    expect(parseLastEventId("garbage", undefined)).toBe(0);
  });
});

// ── Route tests ───────────────────────────────────────────────────────────────
describe("chat routes", () => {
  let app: FastifyInstance;
  let store: MemorySessionStore;
  let userRepo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let repo: FakeConversationRepo;
  let messageRepo: FakeMessageRepo;
  let workingMemoryRepo: FakeWorkingMemoryRepo;
  let streamRepo: MemoryStreamResumeRepo;
  let streamHub: StreamHub;
  let sid: string;
  let userId: string;
  let otherSid: string;
  let select: ReturnType<typeof vi.fn>;
  let llmService: LlmService;

  beforeEach(async () => {
    capturedPrompts.length = 0;
    store = new MemorySessionStore();
    userRepo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();
    repo = new FakeConversationRepo();
    messageRepo = new FakeMessageRepo();
    workingMemoryRepo = new FakeWorkingMemoryRepo();
    streamRepo = new MemoryStreamResumeRepo();
    streamHub = new StreamHub();

    const user = await createUser(userRepo, "user@example.com", "pass", "member");
    userId = user._id;
    sid = await store.create(user._id);

    const other = await createUser(userRepo, "other@example.com", "pass", "member");
    otherSid = await store.create(other._id);

    select = vi.fn(() => makeFakeModel("claude-opus-4-8"));
    llmService = { select } as unknown as LlmService;

    app = await buildApp({
      sessionStore: store,
      userRepo,
      tokenRepo,
      llmService,
      conversationRepo: repo,
      messageRepo,
      streamResumeRepo: streamRepo,
      streamHub,
      workingMemoryService: new WorkingMemoryService(workingMemoryRepo),
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

  function get(
    url: string,
    opts: { session?: string | null } = {}
  ): Promise<LightMyRequestResponse> {
    const { session = sid } = opts;
    const cookies: Record<string, string> = {};
    if (session) cookies[SESSION_COOKIE] = session;
    return app.inject({ method: "GET", url, cookies });
  }

  const userMsg = (content: string) => ({ role: "user" as const, content });

  describe("POST /api/v1/chat", () => {
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

    // AC3 — unknown model id → 400, no assistant message persisted
    it("returns 400 for an unknown model id and persists no assistant message", async () => {
      select.mockImplementation(() => {
        throw new UnknownModelError("bogus-model");
      });
      const res = await post({ message: userMsg("hi"), model: "bogus-model" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/bogus-model/);
      // A new conversation may be created, but no assistant message persisted.
      expect(messageRepo.messages.some((m) => m.role === "assistant")).toBe(false);
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

    // Persistence — user then assistant stored via the message repo
    it("persists the user message then the assistant reply", async () => {
      const res = await post({ message: userMsg("hi there") });
      expect(res.statusCode).toBe(200);
      const id = res.headers["x-conversation-id"] as string;
      await waitFor(() => messageRepo.byConversation(id).length >= 2);
      const msgs = messageRepo.byConversation(id);
      expect(msgs[0]).toMatchObject({ role: "user", content: "hi there" });
      expect(msgs[1]).toMatchObject({ role: "assistant", content: "Hello" });
    });

    it("persists agentId on a newly created conversation", async () => {
      const res = await post({ message: userMsg("hi"), agentId: "agent-x" });
      expect(res.statusCode).toBe(200);
      const id = res.headers["x-conversation-id"] as string;
      expect(repo.docs.get(id)?.agentId).toBe("agent-x");
    });

    it("touches an existing conversation's updatedAt", async () => {
      const convoId = randomUUID();
      const stale = new Date(Date.now() - 60_000);
      await repo.create({
        _id: convoId,
        userId,
        model: undefined,
        createdAt: stale,
        updatedAt: stale,
      });
      const res = await post({ conversationId: convoId, message: userMsg("hi") });
      expect(res.statusCode).toBe(200);
      const updatedAt = repo.docs.get(convoId)?.updatedAt;
      expect(updatedAt?.getTime()).toBeGreaterThan(stale.getTime());
    });

    // History rebuild — stored turns are replayed to the model with the new user message.
    it("rebuilds history from stored messages for the outgoing model prompt", async () => {
      const convoId = randomUUID();
      const base = new Date(Date.now() - 10_000);
      await repo.create({
        _id: convoId,
        userId,
        model: undefined,
        createdAt: base,
        updatedAt: base,
      });
      messageRepo.messages.push(userMessage(convoId, "earlier question", base));
      messageRepo.messages.push(
        assistantMessage(convoId, "earlier answer", new Date(base.getTime() + 1000))
      );

      const res = await post({ conversationId: convoId, message: userMsg("follow up") });
      expect(res.statusCode).toBe(200);
      await waitFor(() => capturedPrompts.length >= 1);

      const prompt = capturedPrompts[0] as Array<{ role: string; content: unknown }>;
      const texts = prompt.map((m) => JSON.stringify(m.content));
      expect(texts.some((t) => t.includes("earlier question"))).toBe(true);
      expect(texts.some((t) => t.includes("earlier answer"))).toBe(true);
      expect(texts.some((t) => t.includes("follow up"))).toBe(true);
    });

    // Context engine — the assembled system prompt (CONTEXT-ENGINE §1) leads the model prompt.
    it("prepends the assembled system prompt carrying working memory", async () => {
      const now = new Date();
      await workingMemoryRepo.upsert({
        _id: randomUUID(),
        userId,
        key: "plan",
        value: "enterprise",
        createdAt: now,
        lastWrittenAt: now,
      });

      const res = await post({ message: userMsg("hi") });
      expect(res.statusCode).toBe(200);
      await waitFor(() => capturedPrompts.length >= 1);

      const prompt = capturedPrompts[0] as Array<{ role: string; content: unknown }>;
      expect(prompt[0]?.role).toBe("system");
      expect(JSON.stringify(prompt[0]?.content)).toContain("<memory>\\n- plan: enterprise");
    });

    it("404 when conversationId is not found", async () => {
      const res = await post({ conversationId: randomUUID(), message: userMsg("hi") });
      expect(res.statusCode).toBe(404);
    });

    it("404 when conversation is owned by another user (owner-scoped write)", async () => {
      const convoId = randomUUID();
      await repo.create({
        _id: convoId,
        userId: "someone-else",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await post({ conversationId: convoId, message: userMsg("hi") });
      expect(res.statusCode).toBe(404);
      expect(messageRepo.byConversation(convoId).length).toBe(0);
    });

    // Aborted/errored stream — user persisted, assistant not (onFinish gating)
    it("does not persist an assistant message when the stream errors", async () => {
      select.mockImplementation(() => makeFakeModel("claude-opus-4-8", makeErrorStreamResult));
      const res = await post({ message: userMsg("hi") });
      const id = res.headers["x-conversation-id"] as string;
      await waitFor(() => messageRepo.byConversation(id).length >= 1);
      const msgs = messageRepo.byConversation(id);
      expect(msgs.some((m) => m.role === "user")).toBe(true);
      expect(msgs.some((m) => m.role === "assistant")).toBe(false);
    });

    // Memory tool loop — update_memory is bound, executed, and the whole loop is persisted.
    it("runs the update_memory tool loop and persists user → assistant(tool-call) → tool → assistant(text)", async () => {
      select.mockImplementation(() =>
        makeToolThenTextModel(
          [
            {
              toolCallId: "call_1",
              toolName: "update_memory",
              args: { key: "plan", value: "enterprise" },
            },
          ],
          "Saved your plan."
        )
      );

      const res = await post({ message: userMsg("remember my plan is enterprise") });
      expect(res.statusCode).toBe(200);
      const id = res.headers["x-conversation-id"] as string;
      await waitFor(() => messageRepo.byConversation(id).length >= 4);

      const msgs = messageRepo.byConversation(id);
      expect(msgs[0]).toMatchObject({ role: "user" });
      expect(msgs[1].role).toBe("assistant");
      const parts = msgs[1].content as MessagePart[];
      expect(parts.some((p) => p.type === "tool-call" && p.toolName === "update_memory")).toBe(
        true
      );
      expect(msgs[2].role).toBe("tool");
      expect(msgs[3]).toMatchObject({ role: "assistant", content: "Saved your plan." });

      // The fact landed in working memory, scoped to the authenticated user.
      expect(workingMemoryRepo.docs).toHaveLength(1);
      expect(workingMemoryRepo.docs[0]).toMatchObject({
        userId,
        key: "plan",
        value: "enterprise",
      });
    });
  });

  describe("POST /api/v1/chat (SSE framing)", () => {
    it("returns X-Stream-Id and streams id/event-framed SSE events", async () => {
      const res = await post({ message: userMsg("hi") });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.headers["x-stream-id"]).toBeDefined();
      expect(res.body).toMatch(/id: 1\nevent: text\ndata: /);
      expect(res.body).toContain("event: finish");
    });

    // reply.hijack() bypasses @fastify/cors, so the SSE response must carry CORS headers itself or a
    // cross-origin browser fetch is blocked (and X-Conversation-Id is unreadable without expose-headers).
    it("carries CORS headers on the hijacked SSE response for a cross-origin request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/chat",
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF, origin: "http://localhost:4000" },
        payload: { message: userMsg("hi") },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:4000");
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
      expect(String(res.headers["access-control-expose-headers"])).toMatch(/x-conversation-id/i);
    });

    it("buffers the turn's events in the stream repo for replay", async () => {
      const res = await post({ message: userMsg("hi") });
      const streamId = res.headers["x-stream-id"] as string;
      await waitFor(() => streamRepo.rows.some((r) => r.eventType === "finish"), 2000);
      const events = await streamRepo.listAfter(streamId, 0);
      expect(events[0].eventType).toBe("text");
      expect(events.at(-1)?.eventType).toBe("finish");
    });
  });

  // ── Live tool-approval round-trip: approval-required + a mutating tool suspends the stream until
  //    a decide POST resolves it. App is rebuilt with a custom registry holding one mutating tool. ──
  describe("POST /api/v1/chat (live approval round-trip)", () => {
    beforeEach(async () => {
      await app.close();
      const reg = new ToolRegistry();
      reg.register({
        name: "write_thing",
        tier: "platform",
        mutating: true,
        description: "writes a thing",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: false,
        },
        execute: async () => ({ success: true as const, data: "wrote" }),
      });
      select.mockImplementation(() =>
        makeToolThenTextModel(
          [{ toolCallId: "call_1", toolName: "write_thing", args: { value: "x" } }],
          "done"
        )
      );
      app = await buildApp({
        sessionStore: store,
        userRepo,
        tokenRepo,
        llmService,
        conversationRepo: repo,
        messageRepo,
        streamResumeRepo: streamRepo,
        streamHub,
        workingMemoryService: new WorkingMemoryService(workingMemoryRepo),
        toolRegistry: reg,
      });
    });

    function decide(
      approvalId: string,
      decision: "approve" | "deny"
    ): Promise<LightMyRequestResponse> {
      return app.inject({
        method: "POST",
        url: `/api/v1/chat/approvals/${approvalId}/decide`,
        cookies: { [SESSION_COOKIE]: sid, [CSRF_COOKIE]: TEST_CSRF },
        headers: { [CSRF_HEADER]: TEST_CSRF },
        payload: { decision },
      });
    }

    const bufferedApprovalId = (): string =>
      (
        streamRepo.rows.find((r) => r.eventType === "approval-request")?.data as {
          approvalId: string;
        }
      ).approvalId;

    it("emits approval-request, resumes on approve, and runs the tool", async () => {
      // Fire WITHOUT awaiting — a suspended stream won't let app.inject resolve until decide lands.
      const chat = post({ message: userMsg("write it"), autonomy: "approval-required" });
      await waitFor(() => streamRepo.rows.some((r) => r.eventType === "approval-request"), 2000);

      const approvalId = bufferedApprovalId();
      expect(typeof approvalId).toBe("string");

      const d = await decide(approvalId, "approve");
      expect(d.statusCode).toBe(200);
      expect(d.json()).toMatchObject({ status: "approve" });

      const res = await chat;
      expect(res.statusCode).toBe(200);
      await waitFor(() => streamRepo.rows.some((r) => r.eventType === "finish"), 2000);

      const types = streamRepo.rows.map((r) => r.eventType);
      expect(types).toContain("approval-request");
      expect(types).toContain("approval-resolved");
      expect(types).toContain("tool-result");

      const resolved = streamRepo.rows.find((r) => r.eventType === "approval-resolved");
      expect((resolved?.data as { outcome: string }).outcome).toBe("approved");
      const toolResult = streamRepo.rows.find((r) => r.eventType === "tool-result");
      expect((toolResult?.data as { result: { success: boolean } }).result.success).toBe(true);
    });

    it("deny resumes the stream with an internal_error tool-result", async () => {
      const chat = post({ message: userMsg("write it"), autonomy: "approval-required" });
      await waitFor(() => streamRepo.rows.some((r) => r.eventType === "approval-request"), 2000);

      const d = await decide(bufferedApprovalId(), "deny");
      expect(d.statusCode).toBe(200);

      const res = await chat;
      expect(res.statusCode).toBe(200);
      await waitFor(() => streamRepo.rows.some((r) => r.eventType === "finish"), 2000);

      const resolved = streamRepo.rows.find((r) => r.eventType === "approval-resolved");
      expect((resolved?.data as { outcome: string }).outcome).toBe("denied");
      const toolResult = streamRepo.rows.find((r) => r.eventType === "tool-result");
      expect(
        (toolResult?.data as { result: { success: boolean; error?: { code: string } } }).result
      ).toMatchObject({ success: false, error: { code: "internal_error" } });
    });

    it("does not gate when autonomy is not approval-required", async () => {
      const res = await post({ message: userMsg("write it"), autonomy: "full" });
      expect(res.statusCode).toBe(200);
      await waitFor(() => streamRepo.rows.some((r) => r.eventType === "finish"), 2000);
      const types = streamRepo.rows.map((r) => r.eventType);
      expect(types).not.toContain("approval-request");
      expect(types).toContain("tool-result");
    });

    it("404 for an unknown approval id", async () => {
      const d = await decide(randomUUID(), "approve");
      expect(d.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/chat/streams/:streamId (resume)", () => {
    function seedStream(streamId: string): void {
      const now = new Date();
      streamRepo.rows.push(
        { streamId, seq: 1, eventType: "text", data: { delta: "a" }, createdAt: now },
        { streamId, seq: 2, eventType: "text", data: { delta: "b" }, createdAt: now },
        { streamId, seq: 3, eventType: "finish", data: { reason: "stop" }, createdAt: now }
      );
    }

    it("401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: `/api/v1/chat/streams/${randomUUID()}` });
      expect(res.statusCode).toBe(401);
    });

    it("404 for an unknown stream", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/chat/streams/${randomUUID()}`,
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(404);
    });

    it("replays events after Last-Event-ID then finishes", async () => {
      const streamId = randomUUID();
      seedStream(streamId);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/chat/streams/${streamId}`,
        cookies: { [SESSION_COOKIE]: sid },
        headers: { "last-event-id": "1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("id: 2");
      expect(res.body).toContain("id: 3");
      expect(res.body).not.toMatch(/id: 1\n/);
      expect(res.body).toContain("event: finish");
    });

    it("replays the whole buffer when no Last-Event-ID is given", async () => {
      const streamId = randomUUID();
      seedStream(streamId);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/chat/streams/${streamId}`,
        cookies: { [SESSION_COOKIE]: sid },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/id: 1\n/);
      expect(res.body).toContain("id: 3");
    });
  });

  describe("GET /api/v1/conversations/:id", () => {
    it("401 without auth", async () => {
      const res = await get(`/api/v1/conversations/${randomUUID()}`, { session: null });
      expect(res.statusCode).toBe(401);
    });

    it("200 returns the conversation metadata for a seeded convo", async () => {
      const convoId = randomUUID();
      const now = new Date();
      await repo.create({
        _id: convoId,
        userId,
        agentId: "agent-x",
        model: "claude-opus-4-8",
        createdAt: now,
        updatedAt: now,
      });
      const res = await get(`/api/v1/conversations/${convoId}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: convoId,
        userId,
        agentId: "agent-x",
        model: "claude-opus-4-8",
      });
      expect(res.json().createdAt).toBeDefined();
      expect(res.json().updatedAt).toBeDefined();
    });

    it("404 for a missing conversation", async () => {
      const res = await get(`/api/v1/conversations/${randomUUID()}`);
      expect(res.statusCode).toBe(404);
    });

    // tenant-open: reads are NOT owner-scoped (distinct from the POST write path).
    it("200 for a different authenticated user (tenant-open read)", async () => {
      const convoId = randomUUID();
      const now = new Date();
      await repo.create({ _id: convoId, userId, createdAt: now, updatedAt: now });
      const res = await get(`/api/v1/conversations/${convoId}`, { session: otherSid });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(convoId);
    });
  });

  describe("GET /api/v1/conversations/:id/messages", () => {
    function seedMessages(convoId: string, n: number): void {
      const base = Date.now();
      for (let i = 0; i < n; i++) {
        messageRepo.messages.push(userMessage(convoId, `m${i}`, new Date(base + i * 1000)));
      }
    }

    it("401 without auth", async () => {
      const res = await get(`/api/v1/conversations/${randomUUID()}/messages`, { session: null });
      expect(res.statusCode).toBe(401);
    });

    it("404 for a missing conversation", async () => {
      const res = await get(`/api/v1/conversations/${randomUUID()}/messages`);
      expect(res.statusCode).toBe(404);
    });

    it("400 for a present-but-garbage cursor", async () => {
      const convoId = randomUUID();
      const now = new Date();
      await repo.create({ _id: convoId, userId, createdAt: now, updatedAt: now });
      const res = await get(`/api/v1/conversations/${convoId}/messages?cursor=not-base64!!`);
      expect(res.statusCode).toBe(400);
    });

    it("paginates with limit and follows nextCursor to page 2", async () => {
      const convoId = randomUUID();
      const now = new Date();
      await repo.create({ _id: convoId, userId, createdAt: now, updatedAt: now });
      seedMessages(convoId, 5);

      const page1 = await get(`/api/v1/conversations/${convoId}/messages?limit=2`);
      expect(page1.statusCode).toBe(200);
      const body1 = page1.json();
      expect(body1.messages).toHaveLength(2);
      expect(body1.nextCursor).not.toBeNull();
      expect(body1.messages.map((m: MessageDoc) => m.content)).toEqual(["m0", "m1"]);

      const page2 = await get(
        `/api/v1/conversations/${convoId}/messages?limit=2&cursor=${encodeURIComponent(
          body1.nextCursor
        )}`
      );
      expect(page2.statusCode).toBe(200);
      const body2 = page2.json();
      expect(body2.messages.map((m: MessageDoc) => m.content)).toEqual(["m2", "m3"]);
    });

    // tenant-open: a different authenticated user can read the messages.
    it("200 for a different authenticated user (tenant-open read)", async () => {
      const convoId = randomUUID();
      const now = new Date();
      await repo.create({ _id: convoId, userId, createdAt: now, updatedAt: now });
      seedMessages(convoId, 2);
      const res = await get(`/api/v1/conversations/${convoId}/messages`, { session: otherSid });
      expect(res.statusCode).toBe(200);
      expect(res.json().messages).toHaveLength(2);
    });
  });
});
