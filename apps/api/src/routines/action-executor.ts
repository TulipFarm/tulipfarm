import type { ResolvedFunction, RunSnapshot } from "@tulipfarm/routine-engine";
import type { ToolRegistry } from "../broker/tool-adapter";
import { type HeadlessTurnDeps, ROUTINE_ACTOR, runHeadlessTurn } from "./headless-turn";
import type { ActionExecutor } from "./run-executor";

/**
 * Bridges the engine's `operation` actions onto the platform (D7): `tool:` targets run
 * through the central ToolRegistry (self-validating handlers, system actor);
 * `agent:` targets spawn a headless agent turn. `hook:` never reaches here — the
 * interpreter dispatches those through the sandbox port.
 *
 * Throws on failure so the interpreter can route retries/onErrors.
 */
export function makeActionExecutor(deps: HeadlessTurnDeps): ActionExecutor {
  return async (fn: ResolvedFunction, args: Record<string, unknown>, run: RunSnapshot) => {
    if (fn.kind === "agent") {
      return runHeadlessTurn(deps, {
        agentId: fn.target,
        task: typeof args.task === "string" ? args.task : JSON.stringify(args),
        routineContext: { routineId: run.slug, runId: run.runId },
        context: run.context,
      });
    }

    if (fn.kind === "tool") {
      const tool = findTool(deps.registry, fn.target);
      if (!tool) throw new Error(`tool "${fn.target}" is not registered`);
      const result = await tool.execute(args, {
        userId: ROUTINE_ACTOR,
        autonomy: "full",
        routineContext: { routineId: run.slug, runId: run.runId },
      });
      if (!result.success) {
        const error = new Error(result.error.message);
        error.name = result.error.code;
        throw error;
      }
      return result.data;
    }

    throw new Error(`unsupported action kind "${fn.kind}"`);
  };
}

function findTool(registry: ToolRegistry, name: string) {
  return registry.getAll().find((t) => t.name === name);
}
