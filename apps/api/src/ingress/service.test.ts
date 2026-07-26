import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserDoc } from "../auth/users";
import { runHeadlessChatTurn } from "../chat/headless-chat-turn";
import type { ChatTurnContext } from "../chat/turn";
import { DOMAIN_EVENTS } from "../domain-events";
import { HookError, type HookExecutor } from "../hooks/hook-executor";
import type { ToolRegistry } from "../tools/registry";
import type { ToolDef } from "../tools/types";
import type { IntegrationConversation } from "./repo";
import {
  handleIngressJob,
  type IngressDecision,
  type IngressServiceDeps,
  parseDecision,
} from "./service";

vi.mock("../chat/headless-chat-turn", () => ({
  runHeadlessChatTurn: vi.fn(async () => ({
    conversationId: "convo-1",
    text: "Here is your answer",
    status: "ok" as const,
  })),
}));

const mockTurn = vi.mocked(runHeadlessChatTurn);

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeUser(email: string, role: "admin" | "member" = "admin"): UserDoc {
  return {
    _id: randomUUID(),
    email,
    passwordHash: "x",
    role,
    status: "active",
    createdAt: new Date(),
  };
}

const HANDLER = { source: "({ classify(ctx) { return { kind: 'ignore' }; } })", hash: "h1" };

function makeIntegration(overrides: Record<string, unknown> = {}): SoulIntegration {
  return {
    slug: "chatapp",
    sourceIntegration: "chatapp",
    manifest: {
      name: "chatapp",
      egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } },
      ingress: {
        handler: "ingress.ts",
        webhook: {
          security: { type: "hmac_sha256", header: "X-Sig", secret_env: "SECRET" },
          dedup_key: "delivery_id",
        },
        chat: {
          thread_key: "{team}/{event.channel}/{event.thread_ts|event.ts}",
          reply: {
            default: { tool: "send_message", args: { channel_id: "{channel}", text: "{text}" } },
          },
        },
        events: {},
      },
    },
    connection: { enabled: true, env: { SECRET: "s" } },
    ingressHandler: HANDLER,
    ...overrides,
  } as SoulIntegration;
}

/** Programmable sandbox stand-in: each test sets what classify() "returns". */
function makeHookExecutor(impl: (invocation: Record<string, unknown>) => unknown): HookExecutor {
  return {
    runRoutineHook: vi.fn(async (_src, _fn, invocation: Record<string, unknown>) => {
      const value = impl(invocation);
      if (value instanceof Error) throw value;
      return value;
    }),
  } as unknown as HookExecutor;
}

function makeRegistry(execute: ToolDef["execute"]): ToolRegistry {
  return {
    getAll: () => [
      { name: "integration_chatapp_send_message", tier: "integration", execute } as ToolDef,
    ],
  } as unknown as ToolRegistry;
}

const CHAT_DECISION: IngressDecision = {
  kind: "chat",
  sender: "EXT-U1",
  text: "summarize",
  reply: { binding: "default", vars: { channel: "C1" } },
};

const BODY = {
  team: "T1",
  delivery_id: "D1",
  event: { channel: "C1", ts: "100.1" },
};

describe("handleIngressJob", () => {
  let admin: UserDoc;
  let mappings: Map<string, IntegrationConversation>;
  let insertedEvents: Array<Record<string, unknown>>;
  let sendTool: ReturnType<typeof vi.fn>;
  let bus: EventEmitter;
  let deps: IngressServiceDeps;

  function withDecision(decision: unknown) {
    deps.hookExecutor = makeHookExecutor(() => decision);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    admin = makeUser("admin@example.com");
    mappings = new Map();
    insertedEvents = [];
    sendTool = vi.fn(async () => ({ success: true as const, data: {} }));
    bus = new EventEmitter();

    deps = {
      soulLoader: {
        integrations: new Map([["chatapp", makeIntegration()]]),
      } as unknown as SoulLoader,
      conversations: {
        find: async (slug: string, key: string) => mappings.get(`${slug}:${key}`) ?? null,
        exists: async (slug: string, key: string) => mappings.has(`${slug}:${key}`),
        insert: async (doc: IntegrationConversation) => {
          mappings.set(`${doc.integrationSlug}:${doc.externalKey}`, doc);
        },
      } as IngressServiceDeps["conversations"],
      integrationEvents: {
        insert: async (doc: Record<string, unknown>) => {
          const record = { id: randomUUID(), ...doc };
          insertedEvents.push(record);
          return record;
        },
      } as unknown as IngressServiceDeps["integrationEvents"],
      identity: {
        resolve: async () => admin,
      },
      chatCtx: {} as ChatTurnContext,
      hookExecutor: makeHookExecutor(() => ({ kind: "ignore" })),
      toolRegistry: makeRegistry(sendTool as unknown as ToolDef["execute"]),
      events: bus,
      log,
    };
  });

  it("passes body + precomputed hasThreadMapping into the sandboxed classify()", async () => {
    const seen: Record<string, unknown>[] = [];
    deps.hookExecutor = makeHookExecutor((invocation) => {
      seen.push(invocation);
      return { kind: "ignore" };
    });
    mappings.set("chatapp:T1/C1/100.1", {
      integrationSlug: "chatapp",
      externalKey: "T1/C1/100.1",
      conversationId: "c",
      userId: admin._id,
    } as IntegrationConversation);
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(seen[0]).toEqual({ body: BODY, headers: {}, hasThreadMapping: true });
    const exec = deps.hookExecutor.runRoutineHook as ReturnType<typeof vi.fn>;
    expect(exec).toHaveBeenCalledWith(
      HANDLER.source,
      "classify",
      expect.anything(),
      null,
      "ingress:chatapp",
      { expectedHash: HANDLER.hash }
    );
  });

  it("forwards the payload's context headers into classify()", async () => {
    const seen: Record<string, unknown>[] = [];
    deps.hookExecutor = makeHookExecutor((invocation) => {
      seen.push(invocation);
      return { kind: "ignore" };
    });
    await handleIngressJob(
      { slug: "chatapp", body: BODY, headers: { "x-provider-event": "issues" } },
      deps
    );
    expect(seen[0]).toMatchObject({ headers: { "x-provider-event": "issues" } });
  });

  it("drops jobs for missing/disconnected/handlerless integrations", async () => {
    await handleIngressJob({ slug: "ghost", body: BODY }, deps);
    deps.soulLoader = {
      integrations: new Map([
        ["chatapp", makeIntegration({ connection: { enabled: false, env: {} } })],
      ]),
    } as unknown as SoulLoader;
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    deps.soulLoader = {
      integrations: new Map([["chatapp", makeIntegration({ ingressHandler: undefined })]]),
    } as unknown as SoulLoader;
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(mockTurn).not.toHaveBeenCalled();
    expect(insertedEvents).toHaveLength(0);
  });

  it("chat decision: identity → headless turn → mapping insert → reply binding with the answer", async () => {
    withDecision(CHAT_DECISION);
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);

    expect(mockTurn).toHaveBeenCalledTimes(1);
    const turnArgs = mockTurn.mock.calls[0][1];
    expect(turnArgs.user).toEqual(admin);
    expect(turnArgs.body).toMatchObject({
      message: { role: "user", content: "summarize" },
      autonomy: "full",
    });
    expect(mappings.get("chatapp:T1/C1/100.1")).toMatchObject({ conversationId: "convo-1" });
    expect(sendTool).toHaveBeenCalledWith(
      { channel_id: "C1", text: "Here is your answer" },
      expect.anything()
    );
  });

  it("denies an external sender whose mapped thread belongs to another user", async () => {
    const owner = makeUser("owner@example.com", "member");
    const sender = makeUser("sender@example.com", "member");
    deps.identity = {
      resolve: async () => sender,
    };
    mappings.set("chatapp:T1/C1/100.1", {
      integrationSlug: "chatapp",
      externalKey: "T1/C1/100.1",
      conversationId: "convo-9",
      userId: owner._id,
    } as IntegrationConversation);
    withDecision(CHAT_DECISION);
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);

    expect(mockTurn).not.toHaveBeenCalled();
    expect(sendTool).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      { slug: "chatapp" },
      "external sender does not own the mapped Conversation; denying"
    );
  });

  it("honors requireExistingThread: no mapping → ignored, mapping → chat", async () => {
    withDecision({ ...CHAT_DECISION, requireExistingThread: true });
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(mockTurn).not.toHaveBeenCalled();

    mappings.set("chatapp:T1/C1/100.1", {
      integrationSlug: "chatapp",
      externalKey: "T1/C1/100.1",
      conversationId: "convo-9",
      userId: admin._id,
    } as IntegrationConversation);
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(mockTurn).toHaveBeenCalledTimes(1);
  });

  it("drops a chat decision when the manifest declares no chat ingress", async () => {
    const integration = makeIntegration();
    const ingress = integration.manifest.ingress;
    if (ingress) ingress.chat = undefined;
    deps.soulLoader = {
      integrations: new Map([["chatapp", integration]]),
    } as unknown as SoulLoader;
    withDecision(CHAT_DECISION);
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(mockTurn).not.toHaveBeenCalled();
  });

  it("event decision: persists, emits integration.event with sourceIntegration protocol", async () => {
    const emitted: unknown[] = [];
    bus.on(DOMAIN_EVENTS.INTEGRATION_EVENT, (p) => emitted.push(p));
    withDecision({ kind: "event", eventType: "member_joined", payload: { channel: "C1" } });
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);

    expect(insertedEvents[0]).toMatchObject({
      integrationSlug: "chatapp",
      protocol: "chatapp",
      eventType: "member_joined",
      externalId: "D1",
      payload: { channel: "C1" },
    });
    expect(emitted[0]).toMatchObject({
      integration: "chatapp",
      protocol: "chatapp",
      event: "member_joined",
      payload: { channel: "C1" },
    });
  });

  it("event decision without payload persists the whole body", async () => {
    withDecision({ kind: "event", eventType: "member_joined" });
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(insertedEvents[0]).toMatchObject({ payload: BODY });
  });

  it("drops events when the manifest declares none, and filters by the allowlist", async () => {
    const integration = makeIntegration();
    const ingress = integration.manifest.ingress;
    if (ingress) ingress.events = undefined;
    deps.soulLoader = {
      integrations: new Map([["chatapp", integration]]),
    } as unknown as SoulLoader;
    withDecision({ kind: "event", eventType: "member_joined" });
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(insertedEvents).toHaveLength(0);

    const allowlisted = makeIntegration();
    const ingress2 = allowlisted.manifest.ingress;
    if (ingress2) ingress2.events = { types: ["reaction_added"] };
    deps.soulLoader = {
      integrations: new Map([["chatapp", allowlisted]]),
    } as unknown as SoulLoader;
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(insertedEvents).toHaveLength(0);
  });

  it("drops a structurally invalid decision without throwing (no retry loop)", async () => {
    withDecision({ kind: "chat", text: 42 });
    await expect(handleIngressJob({ slug: "chatapp", body: BODY }, deps)).resolves.toBeUndefined();
    expect(mockTurn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it("rethrows classifier errors/timeouts (pg-boss retry is safe pre-turn)", async () => {
    deps.hookExecutor = makeHookExecutor(() => new HookError("expression timed out", true));
    await expect(handleIngressJob({ slug: "chatapp", body: BODY }, deps)).rejects.toThrow(
      "timed out"
    );
  });

  it("replies with the guardrail message on a blocked turn and a generic one on error", async () => {
    withDecision(CHAT_DECISION);
    mockTurn.mockResolvedValueOnce({
      conversationId: "convo-1",
      text: "",
      status: "guardrail_block" as const,
    });
    await handleIngressJob({ slug: "chatapp", body: BODY }, deps);
    expect(sendTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "I can't help with that request." }),
      expect.anything()
    );

    mockTurn.mockRejectedValueOnce(new Error("boom"));
    await expect(handleIngressJob({ slug: "chatapp", body: BODY }, deps)).resolves.toBeUndefined();
    expect(sendTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Something went wrong") }),
      expect.anything()
    );
  });
});

describe("parseDecision", () => {
  it("accepts the three well-formed kinds", () => {
    expect(parseDecision({ kind: "ignore" })).toEqual({ kind: "ignore", reason: undefined });
    expect(parseDecision({ kind: "event", eventType: "x" })).toMatchObject({ kind: "event" });
    expect(parseDecision(CHAT_DECISION)).toMatchObject({ kind: "chat", sender: "EXT-U1" });
  });

  it("rejects malformed shapes", () => {
    expect(parseDecision(null)).toBeNull();
    expect(parseDecision("chat")).toBeNull();
    expect(parseDecision({ kind: "nope" })).toBeNull();
    expect(parseDecision({ kind: "event" })).toBeNull();
    expect(parseDecision({ kind: "chat", sender: "s", text: "t" })).toBeNull(); // no reply
    expect(
      parseDecision({ kind: "chat", sender: "", text: "t", reply: { binding: "b" } })
    ).toBeNull();
  });

  it("strips non-string reply vars", () => {
    const parsed = parseDecision({
      kind: "chat",
      sender: "s",
      text: "t",
      reply: { binding: "b", vars: { ok: "v", bad: 42 } },
    });
    expect(parsed).toMatchObject({ reply: { binding: "b", vars: { ok: "v" } } });
  });
});
