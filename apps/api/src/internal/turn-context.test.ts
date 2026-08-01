import { DEFAULT_GUARDRAILS, type GuardrailsService } from "@tulipfarm/agent-runtime";
import type { LlmService } from "@tulipfarm/llm";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import type { PersistedMessage } from "../conversations/service";
import { MAX_HISTORY_TOKENS } from "../memory/limits";
import { DEFAULT_ASSISTANT_NAME } from "../soul/agents/platform-agents";
import {
  BUSINESS_ID,
  CONVERSATION_ID,
  CREATED_AT,
  FakeConversationStore,
  RUN_ID,
  TURN_ID,
  turn,
} from "../test/turn-host-fixtures";
import { ok, type ToolDef } from "../tools/types";
import { ChatTurnContextResolver } from "./turn-context";
import type { TurnAuthority } from "./turn-host";

const AUTHORITY: TurnAuthority = {
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  turn: turn(),
  subject: { kind: "user", id: "user-1" },
  source: "chat",
  bundleDigest: "bundle-digest",
};

function message(overrides: Partial<PersistedMessage> = {}): PersistedMessage {
  return {
    id: "message-1",
    businessId: BUSINESS_ID,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    role: "user",
    content: "hello",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function toolDef(name: string): ToolDef {
  return {
    name,
    tier: "platform",
    mutating: false,
    description: `${name} does something`,
    inputSchema: { type: "object" },
    execute: async () => ok({}),
  };
}

function makeResolver(
  options: {
    request?: Record<string, unknown>;
    messages?: readonly PersistedMessage[];
    tools?: readonly string[];
    guardrails?: GuardrailsService;
  } = {}
) {
  const store = new FakeConversationStore();
  for (const persisted of options.messages ?? []) store.messages.push(persisted);
  const registry = new ToolRegistry();
  for (const name of options.tools ?? []) registry.register(toolDef(name));
  const resolve = vi.fn(() => ({ modelId: "resolved-model" }));

  return {
    store,
    resolve,
    resolver: new ChatTurnContextResolver({
      artifacts: {
        read: async () => ({ content: options.request ?? {} }),
      } as unknown as ArtifactService,
      store,
      llmService: { resolve } as unknown as LlmService,
      toolRegistry: registry,
      ...(options.guardrails ? { guardrails: options.guardrails } : {}),
    }),
  };
}

describe("ChatTurnContextResolver", () => {
  it("gives the model the durable transcript behind one system prompt", async () => {
    const { resolver } = makeResolver({
      messages: [
        message({ id: "message-1", role: "user", content: "hello" }),
        message({ id: "message-2", role: "assistant", content: "hi", attempt: 1 }),
      ],
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.messages[0]?.role).toBe("system");
    expect(context.messages.slice(1)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(context.compacted).toBe(false);
    expect(context.agentId).toBe(DEFAULT_ASSISTANT_NAME);
    expect(context.contextDigest).not.toBe("");
  });

  it("takes every per-turn parameter from the request Artifact", async () => {
    const { resolver, resolve } = makeResolver({
      request: { model: "claude-x", hasTools: true, llmDecision: false },
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.modelProfileId).toBe("resolved-model");
    expect(resolve).toHaveBeenCalledWith({
      sessionModel: "claude-x",
      hasTools: true,
      llmDecision: false,
    });
  });

  it("ships the policy the Worker must enforce, alongside the digest naming it", async () => {
    // The Worker cannot read the Soul, so the policy travels with the Context and the digest is
    // what lets it prove the guards it rebuilt are the ones this evidence names.
    const policy = { input: [{ guard: "prompt_injection", sensitivity: "high" }] };
    const guarded = makeResolver({
      guardrails: { revision: "guardrail-7", config: policy } as unknown as GuardrailsService,
    });

    await expect(guarded.resolver.resolve(AUTHORITY)).resolves.toMatchObject({
      guardrailDigest: "guardrail-7",
      guardrailPolicy: policy,
    });
  });

  it("falls back to the default policy rather than shipping an unguarded turn", async () => {
    // A deployment that composed no guardrails service used to record `guardrailDigest: "none"`,
    // which the Worker would now have to run under no policy at all. Fail-safe instead.
    const { resolver } = makeResolver();

    await expect(resolver.resolve(AUTHORITY)).resolves.toMatchObject({
      guardrailDigest: canonicalHash(DEFAULT_GUARDRAILS),
      guardrailPolicy: DEFAULT_GUARDRAILS,
    });
  });

  it("withholds the Tools a Worker turn has nowhere to draw", async () => {
    const { resolver } = makeResolver({ tools: ["record_create", "present", "navigate_to"] });

    const context = await resolver.resolve(AUTHORITY);

    // No rendered surface on a Worker turn, and the imperative client Tools are browser-only.
    expect(context.tools.map((tool) => tool.name)).toEqual(["record_create"]);
    expect(context.tools[0]).toMatchObject({ inputSchema: { type: "object" } });
  });

  it("drops the oldest history first when the transcript outgrows the budget", async () => {
    // Two messages that cannot both fit, so the budget has to choose between them.
    const oversized = "x".repeat(MAX_HISTORY_TOKENS * 3);
    const { resolver } = makeResolver({
      messages: [
        message({ id: "message-1", content: `old ${oversized}` }),
        message({ id: "message-2", content: `new ${oversized}` }),
      ],
    });

    const context = await resolver.resolve(AUTHORITY);

    // The Agent's instructions outrank the transcript, so they are never what gets dropped; of the
    // history, the message the user just sent survives and the start of the conversation goes.
    expect(context.messages.map((entry) => entry.role)).toEqual(["system", "user"]);
    expect(context.messages[1]?.content.startsWith("new")).toBe(true);
    expect(context.compacted).toBe(true);
  });
});
