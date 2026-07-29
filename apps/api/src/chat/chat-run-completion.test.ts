import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { LlmService } from "@tulipfarm/llm";
import { RunLeaseManager } from "@tulipfarm/run-kernel";
import { describe, expect, it, vi } from "vitest";
import { DurableApprovalGate } from "../approvals/chat-gate";
import type { UserDoc } from "../auth/users";
import type { GuardrailsService } from "../guardrails";
import type { PaginatedResult } from "../pagination";
import { type ChatTurnContext, runChatTurn } from "../runtime/chat-run";
import { ChatRunLifecycle, subscribeChatRunCompletion } from "../runtime/chat-run-lifecycle";
import { MemorySurfaceArtifactStore } from "../surfaces/artifact-store";
import { FAKE_BUSINESS_ID, FAKE_RUN_ID, FakeRunStore } from "../test/fake-run-store";
import type { ConversationDoc, ConversationRepo } from "./conversations";
import { runHeadlessChatTurn } from "./headless-chat-turn";
import type { MessageDoc, MessageRepo } from "./messages";
import { MemoryPendingInteractionRepo } from "./pending-interactions";
import { StreamHub } from "./stream-hub";
import { MemoryStreamResumeRepo } from "./stream-resume";

const V3_USAGE = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, reasoning: undefined },
};

function makeStream(chunks: unknown[]) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function makeFakeModel(opts: { error?: boolean } = {}): LanguageModelV3 {
  const chunks: unknown[] = [
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "hello" },
    { type: "text-end", id: "t0" },
  ];
  if (opts.error) chunks.push({ type: "error", error: new Error("provider exploded") });
  else {
    chunks.push({
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: V3_USAGE,
    });
  }
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async () => ({ stream: makeStream(chunks) })),
  } as unknown as LanguageModelV3;
}

class FakeConversationRepo implements ConversationRepo {
  readonly docs = new Map<string, ConversationDoc>();
  async create(doc: ConversationDoc) {
    this.docs.set(doc._id, { ...doc });
  }
  async findById(id: string) {
    return this.docs.get(id) ?? null;
  }
  async touch(_id: string) {}
  async setAgent(id: string, agentId: string) {
    const doc = this.docs.get(id);
    if (doc) doc.agentId = agentId;
  }
  async setTitle(id: string, title: string) {
    const doc = this.docs.get(id);
    if (doc) doc.title = title;
  }
  async setStarred(_id: string, _starred: boolean) {}
  async list() {
    return [...this.docs.values()];
  }
}

class FakeMessageRepo implements MessageRepo {
  readonly docs: MessageDoc[] = [];
  async create(doc: MessageDoc) {
    this.docs.push(doc);
  }
  async listByConversation(conversationId: string): Promise<PaginatedResult<MessageDoc>> {
    return {
      items: this.docs.filter((d) => d.conversationId === conversationId),
      nextCursor: null,
    };
  }
}

const user: UserDoc = {
  _id: randomUUID(),
  email: "runs@example.com",
  passwordHash: "x",
  role: "member",
  status: "active" as const,
  createdAt: new Date(),
};

const log = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as import("fastify").FastifyBaseLogger;

/**
 * Wires a turn exactly as the chat route does after PR 1: the API claims the Run it minted, runs
 * the turn in-process, and completes the Run off TURN_FINISHED.
 */
async function runTurnWithRun(
  model: LanguageModelV3,
  options: { guardrails?: GuardrailsService } = {}
): Promise<FakeRunStore> {
  const store = new FakeRunStore();
  const lifecycle = new ChatRunLifecycle({
    leases: new RunLeaseManager(store),
    store,
    owner: "api:test",
  });
  const events = new EventEmitter();
  subscribeChatRunCompletion(events, lifecycle, { warn: () => {} });

  const ctx: ChatTurnContext = {
    ...(options.guardrails ? { guardrails: options.guardrails } : {}),
    llmService: {
      resolve: vi.fn(() => ({
        model,
        modelId: "test-model",
        tier: undefined,
        chain: [{ provider: "test", modelId: "test-model" }],
      })),
    } as unknown as LlmService,
    repo: new FakeConversationRepo(),
    messageRepo: new FakeMessageRepo(),
    streamRepo: new MemoryStreamResumeRepo(),
    hub: new StreamHub(),
    events,
    approvalRegistry: new DurableApprovalGate(),
    pendingInteractions: new MemoryPendingInteractionRepo(),
    surfaceStore: new MemorySurfaceArtifactStore(),
    streamControllers: new Map(),
  };

  await lifecycle.claim(FAKE_BUSINESS_ID, FAKE_RUN_ID);
  await runHeadlessChatTurn(ctx, {
    user,
    body: { message: { role: "user", content: "hi" } },
    log,
    runId: FAKE_RUN_ID,
    businessId: FAKE_BUSINESS_ID,
    abandonRun: async () => {
      await lifecycle.complete(FAKE_BUSINESS_ID, FAKE_RUN_ID, "failed");
    },
  });
  return store;
}

const BLOCKING_GUARDRAILS = {
  runInput: async () => ({
    blocked: true,
    guard: "prompt_injection",
    reason: "test",
    message: "blocked",
  }),
} as unknown as GuardrailsService;

describe("chat Run completion", () => {
  it("leaves no queued orphan: the Run the turn executed reaches succeeded", async () => {
    const store = await runTurnWithRun(makeFakeModel());

    await vi.waitFor(() => expect(store.run.status).toBe("succeeded"));
    expect(store.runStatuses).toEqual(["claimed", "running", "succeeded"]);
    expect(store.run.leaseOwner).toBeNull();
    expect(store.state?.status).toBe("succeeded");
  });

  it("fails the Run when the provider errors mid-stream", async () => {
    const store = await runTurnWithRun(makeFakeModel({ error: true }));

    await vi.waitFor(() => expect(store.run.status).toBe("failed"));
    expect(store.run.leaseOwner).toBeNull();
  });

  it("releases the Run when a guardrail blocks the input and no producer ever launches", async () => {
    const store = await runTurnWithRun(makeFakeModel(), { guardrails: BLOCKING_GUARDRAILS });

    // No TURN_FINISHED is emitted on this path, so a Run left `running` here would sit under an
    // expired lease until a worker parked it for an operator.
    expect(store.run.status).toBe("failed");
    expect(store.run.leaseOwner).toBeNull();
  });

  it("releases the Run when the turn fails validation before it starts", async () => {
    const store = new FakeRunStore();
    const lifecycle = new ChatRunLifecycle({
      leases: new RunLeaseManager(store),
      store,
      owner: "api:test",
    });
    const ctx = {
      repo: new FakeConversationRepo(),
    } as unknown as ChatTurnContext;
    const reply = {
      code: () => reply,
      send: () => reply,
    } as unknown as import("fastify").FastifyReply;
    const req = {
      user,
      body: { conversationId: "does-not-exist", message: { role: "user", content: "hi" } },
      log,
      id: "req-1",
    } as unknown as import("fastify").FastifyRequest;

    await lifecycle.claim(FAKE_BUSINESS_ID, FAKE_RUN_ID);
    await runChatTurn(req, reply, ctx, {
      runId: FAKE_RUN_ID,
      businessId: FAKE_BUSINESS_ID,
      abandonRun: async () => {
        await lifecycle.complete(FAKE_BUSINESS_ID, FAKE_RUN_ID, "failed");
      },
    });

    expect(store.run.status).toBe("failed");
    expect(store.run.leaseOwner).toBeNull();
  });
});
