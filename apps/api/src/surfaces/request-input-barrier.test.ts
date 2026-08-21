import type {
  AgentLoopInput,
  ModelInvocationResult,
  ModelPort,
  ToolDispatchPort,
} from "@tulipfarm/agent-runtime";
import { AgentLoop, InMemoryLoopCheckpointStore } from "@tulipfarm/agent-runtime";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import type { ToolDef, TurnAuthority } from "@tulipfarm/tool-host";
import {
  defineApiTool,
  InMemoryToolCatalog,
  ok,
  RegistryToolDispatcher,
  toToolDef,
} from "@tulipfarm/tool-host";
import { describe, expect, it, vi } from "vitest";
import { MemorySurfaceActionStore } from "./action-store";
import { MemorySurfaceArtifactStore } from "./artifact-store";
import { apiSurfacePresentation } from "./renderer-registry";
import { requestInputTool } from "./tools";

/**
 * The barrier measured through the shipped `request_input`, not a scripted stand-in for it.
 *
 * A loop test can only assert what it was told a dispatch returned. What made #405 a safety break
 * was that the *real* Tool answers a model-composed component the Surface catalog rejects with a
 * failure, and the loop used to read that as ordinary feedback.
 */

const BUSINESS_ID = "tulipfarm-local";
const RUN_ID = "run-1";

const AUTHORITY: TurnAuthority = {
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  turn: { id: "turn-1", conversationId: "conversation-1", attempt: 1 },
  subject: { kind: "user", id: "user-1" },
  source: "chat",
  bundleDigest: "digest",
};

function agentCreateTool(created: string[]): ToolDef {
  return toToolDef(
    defineApiTool({
      name: "agent_create",
      tier: "platform",
      mutating: true,
      description: "Create an Agent.",
      inputSchema: { type: "object", additionalProperties: true },
      authorization: {
        action: "surface.present",
        resources: ["platform.surface"],
        dataClasses: ["operational"],
      },
      handler: async (args) => {
        created.push(JSON.stringify(args));
        return ok({ id: "agent-1" });
      },
    }),
    (ctx) => ctx
  );
}

function toolCalls(
  calls: readonly { callId: string; name: string; arguments: unknown }[]
): ModelInvocationResult {
  return {
    requestId: "req",
    output: { kind: "tool_calls", calls },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function scriptedModel(...results: readonly ModelInvocationResult[]): ModelPort {
  const queue = [...results];
  return {
    invoke: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("model called more times than scripted");
      return next;
    },
  };
}

function choicesCall(props: Record<string, unknown>) {
  return {
    callId: "input-1",
    name: "request_input",
    arguments: { component: { name: "Choices", version: "1.0", props } },
  };
}

async function runTurn(props: Record<string, unknown>, alsoInSameBatch: readonly string[] = []) {
  const created: string[] = [];
  const registry = new InMemoryToolCatalog();
  registry.register(requestInputTool);
  registry.register(agentCreateTool(created));

  const host = new RegistryToolDispatcher({
    registry,
    artifacts: { read: vi.fn(async () => ({ content: {} })) } as unknown as ArtifactService,
    surfaces: apiSurfacePresentation,
    surfaceStore: new MemorySurfaceArtifactStore(),
    surfaceActionStore: new MemorySurfaceActionStore(),
  });

  const dispatched: string[] = [];
  const tools: ToolDispatchPort = {
    dispatch: async (request) => {
      dispatched.push(request.name);
      const result = await host.dispatch(AUTHORITY, {
        callId: request.callId,
        name: request.name,
        arguments: request.arguments,
      });
      return result.status === "succeeded"
        ? { status: "succeeded", callId: request.callId, output: result.output }
        : result.status === "awaiting_approval"
          ? {
              status: "awaiting_approval",
              callId: request.callId,
              approvalId: result.approvalId,
            }
          : { status: result.status, callId: request.callId, reason: result.reason };
    },
  };

  const loop = new AgentLoop({
    model: scriptedModel(
      toolCalls([
        choicesCall(props),
        ...alsoInSameBatch.map((id) => ({
          callId: id,
          name: "agent_create",
          arguments: { name: id },
        })),
      ]),
      toolCalls([{ callId: "create-1", name: "agent_create", arguments: { name: "Sam" } }]),
      {
        requestId: "req",
        output: { kind: "text", text: "Created the Agent." },
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    ),
    tools,
    checkpoints: new InMemoryLoopCheckpointStore(),
    events: { append: async () => {} },
    budget: { consume: async () => ({ outcome: "ok" }) },
    isCancelled: async () => false,
  });

  const input: AgentLoopInput = {
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    stateId: "state-1",
    modelProfileId: "primary",
    contextDigest: "sha256:context",
    guardrailDigest: "sha256:guardrail",
    messages: [{ role: "user", content: [{ type: "text", text: "create an agent named Sam" }] }],
    tools: [
      { name: "request_input", inputSchema: requestInputTool.inputSchema, mutating: true },
      { name: "agent_create", inputSchema: { type: "object" }, mutating: true },
    ],
    limits: { maxIterations: 5, maxToolCalls: 5, maxRepairAttempts: 2 },
  };

  return { outcome: await loop.run(input), dispatched, created };
}

const VALID_CHOICES = {
  question: "Which operating profile should I use?",
  choices: [
    { label: "Friendly supervised (recommended)", value: "supervised" },
    { label: "Friendly full autonomy", value: "autonomous" },
  ],
  action: { event: "profile.choose" },
};

describe("request_input stops a Chat Turn", () => {
  it("parks the Turn on the question instead of creating the Agent", async () => {
    const { outcome, dispatched, created } = await runTurn(VALID_CHOICES);

    expect(created).toEqual([]);
    expect(dispatched).toEqual(["request_input"]);
    expect(outcome).toMatchObject({ status: "input_required", callId: "input-1" });
  });

  it("stops rather than proceeding when the Surface refuses the model's own component", async () => {
    const { outcome, dispatched, created } = await runTurn({
      question: "Which operating profile should I use?",
      options: [{ label: "Friendly supervised (recommended)", value: "supervised" }],
    });

    expect(created).toEqual([]);
    expect(dispatched).toEqual(["request_input"]);
    expect(outcome).toMatchObject({ status: "failed", reason: "input_request_failed" });
  });

  // A model that asks and acts in one output is the shape #458 reported: the confirmation card and
  // the bulk writes it was meant to gate arrive together, so the operator's Cancel lands on work
  // that already ran. The barrier has to hold within the batch, not only across iterations.
  it("dispatches nothing else from the batch that carried the question", async () => {
    const { outcome, dispatched, created } = await runTurn(VALID_CHOICES, [
      "bulk-1",
      "bulk-2",
      "bulk-3",
    ]);

    expect(created).toEqual([]);
    expect(dispatched).toEqual(["request_input"]);
    expect(outcome).toMatchObject({ status: "input_required", callId: "input-1" });
  });
});
