import type { ToolDispatchResult } from "@tulipfarm/agent-runtime";
import type { EvalCase } from "./case.ts";

/**
 * Faked dispatch: results are matched by Tool name and consumed in call order.
 *
 * A call with nothing left to consume must never be answered with an empty success. That is a
 * result the Case author never wrote, and the model's whole subsequent turn is then driven by a
 * fiction — an empty payload reads to a model as "the Tool returned nothing", which is itself a
 * reason to call it again. Two honest answers instead:
 *
 * - A Tool whose scripted results are used up **repeats its last one**. A model may call a read
 *   twice, and a real read is idempotent, so repeating is what actually would have happened.
 * - A Tool the Case never scripted at all **fails**, naming itself. That is an authoring gap, and
 *   a gap has to be visible to the model as a failure it must recover from rather than be papered
 *   over with a success.
 */
export function toolDispatcher(evalCase: EvalCase) {
  type Scripted = NonNullable<EvalCase["toolResults"]>[number];
  const pending: Scripted[] = [...(evalCase.toolResults ?? [])];
  const served = new Map<string, Scripted>();
  const calls: { name: string; arguments: unknown }[] = [];
  return {
    calls,
    port: {
      dispatch: async (request: {
        callId: string;
        name: string;
        arguments: unknown;
      }): Promise<ToolDispatchResult> => {
        calls.push({ name: request.name, arguments: request.arguments });
        const at = pending.findIndex((r) => r.name === request.name);
        let result: Scripted | undefined;
        if (at === -1) result = served.get(request.name);
        else {
          [result] = pending.splice(at, 1);
          if (result !== undefined) served.set(request.name, result);
        }
        if (result === undefined) {
          return {
            status: "failed",
            callId: request.callId,
            reason: `the Eval Case scripts no result for Tool "${request.name}"`,
          };
        }
        return result.error === undefined
          ? { status: "succeeded", callId: request.callId, output: result.output ?? {} }
          : { status: "failed", callId: request.callId, reason: result.error };
      },
    },
  };
}
