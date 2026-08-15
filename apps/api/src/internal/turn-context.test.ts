import { DEFAULT_GUARDRAILS, type GuardrailsService } from "@tulipfarm/agent-runtime";
import type { MemoryRecallService, MemoryService } from "@tulipfarm/memory";
import { MAX_HISTORY_TOKENS } from "@tulipfarm/memory";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import { canonicalHash } from "@tulipfarm/schema";
import type { SoulLoader, SoulSkill } from "@tulipfarm/soul";
import type { ToolAvailability } from "@tulipfarm/tool-broker";
import { ok, type ToolDef } from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../broker/tool-adapter";
import type { PersistedMessage } from "../conversations/service";
import { DEFAULT_ASSISTANT_NAME } from "../soul/agents/platform-agents";
import type { BundledSkill } from "../soul/skills/bundled";
import {
  BUSINESS_ID,
  CONVERSATION_ID,
  CREATED_AT,
  FakeConversationStore,
  RUN_ID,
  TURN_ID,
  turn,
} from "../test/turn-host-fixtures";
import { type ChannelDeliveryReader, ChatTurnContextResolver } from "./turn-context";
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

// Surface availability is read from the Tool's own `availableTo`, so a fixture that omits it
// declares a Tool offerable anywhere — which is what a bare registration genuinely means.
const FIXTURE_AVAILABILITY: Record<string, ToolAvailability> = {
  present: { requiresPresentation: true },
  update_presentation: { requiresPresentation: true },
  request_input: { requiresPresentation: true },
  get_client_context: { requiresWebChat: true },
  navigate_to: { requiresWebChat: true },
  prefill_form: { requiresWebChat: true },
  invoke_action: { requiresWebChat: true },
};

function toolDef(name: string): ToolDef {
  const availableTo = FIXTURE_AVAILABILITY[name];
  return {
    name,
    tier: "platform",
    mutating: false,
    description: `${name} does something`,
    inputSchema: { type: "object" },
    execute: async () => ok({}),
    ...(availableTo === undefined ? {} : { definition: { availableTo } as ToolDef["definition"] }),
  };
}

function makeResolver(
  options: {
    request?: Record<string, unknown>;
    messages?: readonly PersistedMessage[];
    tools?: readonly string[];
    guardrails?: GuardrailsService;
    memory?: readonly { key: string; value: string }[];
    now?: () => Date;
    skills?: readonly SoulSkill[];
    bundledSkills?: Record<string, BundledSkill>;
    memoryRecall?: MemoryRecallService;
  } = {},
  channelDeliveries?: ChannelDeliveryReader
) {
  const store = new FakeConversationStore();
  for (const persisted of options.messages ?? []) store.messages.push(persisted);
  const registry = new ToolRegistry();
  for (const name of options.tools ?? []) registry.register(toolDef(name));
  const soulLoader =
    options.skills === undefined
      ? undefined
      : ({
          skills: new Map(options.skills.map((skill) => [skill.name, skill])),
          agents: new Map(),
          surfaceComponents: new Map(),
        } as unknown as SoulLoader);
  const bundledSkills =
    options.bundledSkills === undefined
      ? undefined
      : new Map(Object.entries(options.bundledSkills));

  return {
    store,
    resolver: new ChatTurnContextResolver({
      artifacts: {
        read: async () => ({ content: options.request ?? {} }),
      } as unknown as ArtifactService,
      store,
      toolRegistry: registry,
      ...(options.guardrails ? { guardrails: options.guardrails } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.memory
        ? {
            memory: {
              list: async () => options.memory,
            } as unknown as MemoryService,
          }
        : {}),
      ...(options.memoryRecall ? { memoryRecall: options.memoryRecall } : {}),
      ...(channelDeliveries ? { channelDeliveries } : {}),
      ...(soulLoader ? { soulLoader } : {}),
      ...(bundledSkills ? { bundledSkills } : {}),
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

  it("tells the agent what now is, in the timezone the user stored", async () => {
    const { resolver } = makeResolver({
      now: () => new Date("2026-08-08T11:12:00Z"),
      memory: [{ key: "timezone", value: "Asia/Kolkata" }],
    });

    const context = await resolver.resolve(AUTHORITY);

    const system = context.messages[0]?.content ?? "";
    expect(system).toContain("<current-context>");
    expect(system).toContain("date: Saturday, 08 August 2026");
    expect(system).toContain("time: 16:42 (Asia/Kolkata, UTC+05:30)");
  });

  it("falls back to UTC when the user stored no timezone", async () => {
    const { resolver } = makeResolver({ now: () => new Date("2026-08-08T11:12:00Z") });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.messages[0]?.content).toContain("time: 11:12 (UTC, UTC+00:00)");
  });

  it("forwards the Artifact's model selector for the router to resolve", async () => {
    // This process names the intent; the Worker resolves it, because that is where the invocation
    // happens and where a fallback chain can actually be tried.
    const { resolver } = makeResolver({
      request: { model: "claude-x", hasTools: true, llmDecision: false },
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.modelProfileId).toBe("claude-x");
  });

  it("asks for auto when the request chose no model", async () => {
    const { resolver } = makeResolver({ request: {} });

    await expect(resolver.resolve(AUTHORITY)).resolves.toMatchObject({ modelProfileId: "auto" });
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

  it("resolves the web chat surface, and all its Tools, for a Run with no Channel delivery", async () => {
    const { resolver } = makeResolver({ tools: ["record_create", "present", "navigate_to"] });

    const context = await resolver.resolve(AUTHORITY);

    // No Channel delivery row for this Run falls back to the web chat surface, so both the
    // presentation Tools and the browser-only imperative Tools are offered, same as a web Turn.
    expect(context.tools.map((tool) => tool.name)).toEqual([
      "record_create",
      "present",
      "navigate_to",
    ]);
    expect(context.tools[0]).toMatchObject({ inputSchema: { type: "object" } });
  });

  it("withholds the browser-only Tools, but not presentation Tools, for a Slack-sourced Run", async () => {
    const channelDeliveries = {
      find: async () => ({ provider: "slack", destination: "C-OPS" }),
    };
    const { resolver } = makeResolver(
      { tools: ["record_create", "present", "navigate_to"] },
      channelDeliveries
    );

    const context = await resolver.resolve(AUTHORITY);

    // A Slack destination resolves the Slack message surface: presentation Tools are available
    // there too, but the imperative client Tools stay browser-only.
    expect(context.tools.map((tool) => tool.name)).toEqual(["record_create", "present"]);
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

  it("ships skillToolScopes built from Soul-loaded Skills' tools: frontmatter", async () => {
    const { resolver } = makeResolver({
      skills: [
        {
          name: "routine-forge",
          frontmatter: { tools: ["routine_forge", "agent_list"] },
          body: "",
        },
        { name: "agent-forge", frontmatter: {}, body: "" },
      ],
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.skillToolScopes).toEqual({ "routine-forge": ["routine_forge", "agent_list"] });
  });

  it("omits skillToolScopes entirely when no Skill declares a tools: list", async () => {
    const { resolver } = makeResolver({
      skills: [{ name: "agent-forge", frontmatter: {}, body: "" }],
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.skillToolScopes).toBeUndefined();
  });

  it("lets a Soul-authored Skill's tools: list override its bundled namesake, like mergedSkills does", async () => {
    const bundled = {
      "routine-forge": {
        name: "routine-forge",
        frontmatter: { tools: ["routine_forge"] },
        body: "",
        category: "forge",
        categoryDescription: "",
        directory: "forge/routine-forge",
        references: [],
      } as unknown as BundledSkill,
    };
    const { resolver } = makeResolver({
      bundledSkills: bundled,
      skills: [
        {
          name: "routine-forge",
          frontmatter: { tools: ["routine_forge", "agent_list"] },
          body: "",
        },
      ],
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.skillToolScopes).toEqual({
      "routine-forge": ["routine_forge", "agent_list"],
    });
  });
});

describe("ChatTurnContextResolver — the retrieved memory tier", () => {
  function recaller(
    impl: (userId: string, query: string, limit: number, agentId?: string) => Promise<unknown>
  ): MemoryRecallService {
    return { recall: impl } as unknown as MemoryRecallService;
  }

  function assertion(subject: string, statement: string) {
    return { subject, statement };
  }

  it("renders recalled memories into the system prompt", async () => {
    const { resolver } = makeResolver({
      messages: [message({ content: "when is the acme renewal?" })],
      memoryRecall: recaller(async () => [assertion("acme renewal", "moved to Q3")]),
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.messages[0]?.content).toContain("<recalled-memory>");
    expect(context.messages[0]?.content).toContain("- acme renewal: moved to Q3");
  });

  it("scores against the newest user message, not the agent's own last words", async () => {
    const seen: { query: string; limit: number; agentId?: string; userId: string }[] = [];
    const { resolver } = makeResolver({
      messages: [
        message({ id: "m1", role: "user", content: "when is the acme renewal?" }),
        message({ id: "m2", role: "assistant", content: "let me check the pipeline", attempt: 1 }),
      ],
      memoryRecall: recaller(async (userId, query, limit, agentId) => {
        seen.push({ userId, query, limit, agentId });
        return [];
      }),
    });

    await resolver.resolve(AUTHORITY);

    expect(seen).toEqual([
      {
        userId: "user-1",
        query: "when is the acme renewal?",
        limit: 5,
        agentId: DEFAULT_ASSISTANT_NAME,
      },
    ]);
  });

  it("recalls nothing for a Run that is not acting as a person", async () => {
    let called = false;
    const { resolver } = makeResolver({
      messages: [message({ content: "when is the acme renewal?" })],
      memoryRecall: recaller(async () => {
        called = true;
        return [assertion("acme renewal", "moved to Q3")];
      }),
    });

    const context = await resolver.resolve({
      ...AUTHORITY,
      subject: { kind: "agent", id: "agent-1" },
    });

    expect(called).toBe(false);
    expect(context.messages[0]?.content).not.toContain("<recalled-memory>");
  });

  it("does not query when there is no user message to score against", async () => {
    let called = false;
    const { resolver } = makeResolver({
      messages: [message({ id: "m1", role: "assistant", content: "hi", attempt: 1 })],
      memoryRecall: recaller(async () => {
        called = true;
        return [];
      }),
    });

    await resolver.resolve(AUTHORITY);

    expect(called).toBe(false);
  });

  it("degrades the prompt rather than failing the turn when recall throws", async () => {
    const { resolver } = makeResolver({
      messages: [message({ content: "when is the acme renewal?" })],
      memoryRecall: recaller(async () => {
        throw new Error("index unavailable");
      }),
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.messages[0]?.role).toBe("system");
    expect(context.messages[0]?.content).not.toContain("<recalled-memory>");
    expect(context.messages.slice(1)).toEqual([
      { role: "user", content: "when is the acme renewal?" },
    ]);
  });

  it("omits the block entirely when no recall service is wired", async () => {
    const { resolver } = makeResolver({
      messages: [message({ content: "when is the acme renewal?" })],
    });

    const context = await resolver.resolve(AUTHORITY);

    expect(context.messages[0]?.content).not.toContain("<recalled-memory>");
  });
});
