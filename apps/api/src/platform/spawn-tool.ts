import { DelegationError } from "@tulipfarm/agent-runtime";
import { ChildRunError } from "@tulipfarm/run-kernel";
import { ajv, SUBAGENT_MAX_TOOLS } from "@tulipfarm/schema";
import { defineParkableApiTool, parked } from "@tulipfarm/tool-host";
import { firstError } from "./tool-args";
import { err, ok } from "./tool-result";
import type { PlatformToolContext } from "./tools";

const SPAWN_SUBAGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "instructions", "task"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "A short name for the helper, used only to label its work in the trace.",
    },
    instructions: {
      type: "string",
      minLength: 1,
      maxLength: 8_000,
      description:
        "The helper's system prompt: who it is and how it should approach the task. This decides what it is told to do, never what it is allowed to do.",
    },
    task: {
      type: "string",
      minLength: 1,
      maxLength: 8_000,
      description: "The single task the helper must answer. It gets one turn and no follow-up.",
    },
    context: {
      type: "object",
      description: "Optional structured material for the helper to reason over.",
    },
    toolNames: {
      type: "array",
      maxItems: SUBAGENT_MAX_TOOLS,
      items: { type: "string", minLength: 1 },
      description:
        "Tools the helper may use, each of which you must already hold yourself. Omit to give it none; naming one you do not hold refuses the spawn.",
    },
  },
};
const validateSpawn = ajv.compile(SPAWN_SUBAGENT_SCHEMA);

export const spawnSubagentTool = defineParkableApiTool<PlatformToolContext>({
  name: "spawn_subagent",
  description:
    "Spawn a throwaway helper you define yourself, for one task. Unlike delegate_to_agent this needs no configured agent: you write its instructions inline. It gets no conversation and no history — only the task and context you give it. Its authority may only narrow from yours. Suspends this turn until it answers, then returns its answer.",
  mutating: true,
  tier: "platform",
  inputSchema: SPAWN_SUBAGENT_SCHEMA,
  authorization: {
    // Deliberately not `platform.agent.delegate`. "You may hand work to helper X, whose
    // instructions an operator wrote and can audit" and "you may invent a helper and write its
    // instructions yourself" are different powers, and one grant must not confer the other.
    action: "platform.agent.spawn",
    resources: ["platform.agent"],
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateSpawn(args)) return err("validation_error", firstError(validateSpawn.errors));
    const { name, instructions, task, context, toolNames } = args as {
      name: string;
      instructions: string;
      task: string;
      context?: Record<string, unknown>;
      toolNames?: string[];
    };
    const parentRunId = ctx.requestContext?.runId ?? ctx.routineContext?.runId;
    if (!ctx.spawnSubagent || parentRunId === undefined) {
      return err("unavailable", "Sub-agents are not available outside a durable Run.");
    }
    // The parent parks on a wait registered against its own State, and the spawn is made
    // idempotent by this call id. Without both, a resumed turn would spawn a second helper.
    const parentStateKey = ctx.requestContext?.stateKey;
    const callId = ctx.requestContext?.toolCallId;
    if (parentStateKey === undefined || callId === undefined) {
      return err("unavailable", "Sub-agents are not available outside a durable Run.");
    }
    try {
      const outcome = await ctx.spawnSubagent({
        parentRunId,
        parentStateKey,
        callId,
        ...(ctx.requestContext?.agentId === undefined
          ? {}
          : { parentAgentId: ctx.requestContext.agentId }),
        persona: { name, instructions },
        task,
        ...(context === undefined ? {} : { context }),
        ...(toolNames === undefined ? {} : { toolNames }),
      });
      if (outcome.status === "awaiting" && outcome.waitId !== null) {
        return parked({
          kind: "child_run",
          childRunId: outcome.childRunId,
          waitId: outcome.waitId,
        });
      }
      return ok({ ...outcome, task });
    } catch (e) {
      // `DelegationError` is what the depth ceiling and the deadline bound raise. Letting it
      // escape would turn "you may not spawn any deeper" into a crashed turn instead of a
      // refusal the model can read and work around.
      if (e instanceof DelegationError) return err("validation_error", e.message);
      if (e instanceof ChildRunError) return err("validation_error", e.message);
      throw e;
    }
  },
});
