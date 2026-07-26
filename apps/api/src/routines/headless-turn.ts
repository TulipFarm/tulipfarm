import type { SoulLoader } from "@tulipfarm/soul";
import { generateText, type ToolSet } from "ai";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { RequestContext } from "../tools/types";

/** Max model steps for a routine-spawned agent turn (tool loop bound). */
const MAX_HEADLESS_STEPS = 8;

/** System actor recorded for routine-spawned turns (no human user in the loop). */
export const ROUTINE_ACTOR = "system:routine";

type HeadlessLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

export interface HeadlessTurnDeps {
  /** Structural: only getModel is needed (LlmService satisfies this). */
  llmService: { getModel(tier: "quick" | "standard" | "complex"): unknown };
  registry: ToolRegistry;
  soulLoader?: Pick<SoulLoader, "agents">;
  log: HeadlessLogger;
}

export interface HeadlessTurnInput {
  agentId: string;
  task: string;
  routineContext: { routineId: string; runId: string };
  context: Record<string, unknown>;
}

/**
 * Routine `agent:` action (review B3): a headless agent turn — generateText tool loop,
 * no Fastify req/reply, no conversation row, no SSE. The agent's AGENT.md body is the
 * system prompt; `routineContext` rides the RequestContext so `call_skill` /
 * `complete_state` become live. Tool approvals are not gated here — the routine-level
 * human_approval state is the V1 gate for routine-initiated actions.
 *
 * Returns the output passed to `complete_state`, or the final text when the agent
 * never called it.
 */
export async function runHeadlessTurn(
  deps: HeadlessTurnDeps,
  input: HeadlessTurnInput
): Promise<unknown> {
  const agent = deps.soulLoader?.agents.get(input.agentId);
  if (!agent) {
    throw new Error(`agent "${input.agentId}" not found in soul`);
  }

  const ctx: RequestContext = {
    userId: ROUTINE_ACTOR,
    agentId: input.agentId,
    autonomy: "full",
    routineContext: input.routineContext,
  };
  const tools = deps.registry.buildToolSet(ctx) as ToolSet;

  const system = [
    agent.body,
    "",
    "You are executing one state of an automated routine. Complete the task using your tools,",
    "then call the complete_state tool exactly once with the state's output data.",
  ].join("\n");

  const result = await generateText({
    // biome-ignore lint/suspicious/noExplicitAny: LanguageModel type lives in @tulipfarm/llm; deps are structural here
    model: deps.llmService.getModel("standard") as any,
    system,
    prompt: `Task: ${input.task}\n\nRoutine context data:\n${JSON.stringify(input.context, null, 2)}`,
    tools,
    stopWhen: ({ steps }) => {
      if (steps.length >= MAX_HEADLESS_STEPS) return true;
      // Stop as soon as complete_state ran — its result is the state output.
      return steps.some((s) => s.toolResults?.some((r) => r.toolName === "complete_state"));
    },
  });

  for (const step of result.steps) {
    for (const toolResult of step.toolResults ?? []) {
      if (toolResult.toolName === "complete_state") {
        const output = toolResult.output as
          | { success: true; data: { output?: unknown } }
          | { success: false };
        if (output && "success" in output && output.success) {
          return output.data.output ?? null;
        }
      }
    }
  }

  deps.log.warn(
    { runId: input.routineContext.runId, agentId: input.agentId },
    "headless turn finished without complete_state; using final text"
  );
  return result.text;
}
