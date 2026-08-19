import { DelegationError } from "@tulipfarm/agent-runtime";
import { ChildRunError } from "@tulipfarm/run-kernel";
import { ajv } from "@tulipfarm/schema";
import { defineApiTool } from "@tulipfarm/tool-host";
import { firstError, SOUL_AGENT_TARGET, soulTarget } from "./tool-args";
import { err, ok } from "./tool-result";
import type { PlatformToolContext } from "./tools";

const DELEGATE_TO_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "task"],
  properties: {
    agentId: {
      type: "string",
      minLength: 1,
      description: "Soul name of the agent to delegate to.",
    },
    task: { type: "string", minLength: 1, description: "The task description to delegate." },
    context: {
      type: "object",
      description: "Optional structured context to pass to the delegated agent.",
    },
  },
};
const validateDelegate = ajv.compile(DELEGATE_TO_AGENT_SCHEMA);

export const delegateToAgentTool = defineApiTool<PlatformToolContext>({
  name: "delegate_to_agent",
  requiresAmbient: ["soul"],
  description:
    "Delegate a sub-task to another agent. Starts a child Run under the delegating Run: authority, deadline, and delegation depth may only narrow, and cancelling the parent cancels the child. Waits briefly for the helper's answer and otherwise returns the child run and chat ids to follow.",
  mutating: true,
  tier: "platform",
  inputSchema: DELEGATE_TO_AGENT_SCHEMA,
  authorization: {
    action: "platform.agent.delegate",
    resources: ["platform.agent"],
    targets: (args) => soulTarget(SOUL_AGENT_TARGET, args, "agentId"),
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateDelegate(args))
      return err("validation_error", firstError(validateDelegate.errors));
    const { agentId, task, context } = args as {
      agentId: string;
      task: string;
      context?: Record<string, unknown>;
    };
    const agent = ctx.soulLoader?.agents.get(agentId);
    if (!agent) return err("not_found", `Agent "${agentId}" not found in soul.`);
    const parentRunId = ctx.requestContext?.runId ?? ctx.routineContext?.runId;
    if (!ctx.delegateToAgent || parentRunId === undefined) {
      return err("unavailable", "Delegation is not available outside a durable Run.");
    }
    try {
      const outcome = await ctx.delegateToAgent({
        parentRunId,
        ...(ctx.requestContext?.agentId === undefined
          ? {}
          : { parentAgentId: ctx.requestContext.agentId }),
        agentId,
        task,
        ...(context === undefined ? {} : { context }),
      });
      return ok({ ...outcome, task });
    } catch (e) {
      if (e instanceof DelegationError) return err("validation_error", e.message);
      if (e instanceof ChildRunError) return err("validation_error", e.message);
      throw e;
    }
  },
});
