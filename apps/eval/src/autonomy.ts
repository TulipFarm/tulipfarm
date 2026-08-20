import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import type { AgentCapabilityRestrictions } from "@tulipfarm/schema";
import {
  agentCapabilityDenial,
  asChatAutonomy,
  autonomyDemandsApproval,
} from "@tulipfarm/tool-host";
import type { EvalCase } from "./case.ts";
import type { EvalSoul } from "./eval-soul.ts";

/**
 * Bounds a Case's Tool loop by the autonomy its Agent declares in the Eval Soul.
 *
 * Production reads the same two things through the same two functions: the Agent's authored
 * `autonomy` frontmatter, narrowed by `asChatAutonomy`, and whether a Tool call under it needs a
 * human, decided by `autonomyDemandsApproval`. Reimplementing either here would leave the Corpus
 * scoring a ceiling the product does not have.
 *
 * The refusal is a dispatch failure rather than a silent skip, because that is what the model sees
 * in production when a call parks for an approval nobody gives: a denial it must answer for.
 */
export function autonomyBoundedDispatch(
  soul: EvalSoul,
  evalCase: EvalCase,
  tools: ToolDispatchPort
): ToolDispatchPort {
  const autonomy = asChatAutonomy(soul.loader.agents.get(evalCase.agent)?.frontmatter.autonomy);
  if (autonomy === undefined) return tools;

  const declared = new Map((evalCase.tools ?? []).map((tool) => [tool.name, tool]));
  return {
    dispatch: async (request) => {
      const tool = declared.get(request.name);
      if (
        tool !== undefined &&
        autonomyDemandsApproval({ mutating: tool.mutating === true }, autonomy)
      ) {
        return {
          status: "failed",
          callId: request.callId,
          reason:
            `tool "${request.name}" is mutating and Agent "${evalCase.agent}" runs at ` +
            `autonomy "${autonomy}", so it needs an approval before it can execute`,
        };
      }
      return await tools.dispatch(request);
    },
  };
}

export function capabilityBoundedDispatch(
  soul: EvalSoul,
  evalCase: EvalCase,
  tools: ToolDispatchPort
): ToolDispatchPort {
  const capabilityRestrictions = soul.loader.agents.get(evalCase.agent)?.frontmatter
    .capabilityRestrictions as AgentCapabilityRestrictions | undefined;
  if (capabilityRestrictions === undefined) return tools;

  const declared = new Map((evalCase.tools ?? []).map((tool) => [tool.name, tool]));
  return {
    dispatch: async (request) => {
      const tool = declared.get(request.name);
      if (tool !== undefined) {
        const denial = agentCapabilityDenial(
          capabilityRestrictions,
          { name: request.name, mutating: tool.mutating === true },
          request.arguments
        );
        if (denial !== undefined) {
          return { status: "failed", callId: request.callId, reason: denial };
        }
      }
      return await tools.dispatch(request);
    },
  };
}
