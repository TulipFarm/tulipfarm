import type { ToolDispatchResult } from "@tulipfarm/agent-runtime";
import type { EvalCase } from "./case.ts";

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((key) => key in b && equal(a[key], b[key]))
  );
}

/**
 * Faked dispatch: results are matched by Tool name and optional exact arguments.
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
  const served: Scripted[] = [];
  const calls: { name: string; arguments: unknown }[] = [];
  const denials: { name: string; arguments: unknown; reason: string }[] = [];
  const matches = (result: Scripted, name: string, arguments_: unknown) =>
    result.name === name && (result.when === undefined || equal(result.when, arguments_));
  return {
    calls,
    denials,
    port: {
      dispatch: async (request: {
        callId: string;
        name: string;
        arguments: unknown;
      }): Promise<ToolDispatchResult> => {
        calls.push({ name: request.name, arguments: request.arguments });
        const at = pending.findIndex((result) => matches(result, request.name, request.arguments));
        let result: Scripted | undefined;
        if (at === -1) {
          result = [...served]
            .reverse()
            .find((candidate) => matches(candidate, request.name, request.arguments));
        } else {
          [result] = pending.splice(at, 1);
          if (result !== undefined) served.push(result);
        }
        if (result === undefined) {
          return {
            status: "failed",
            callId: request.callId,
            reason: `the Eval Case scripts no result for Tool "${request.name}"`,
          };
        }
        if (result.invalidArguments !== undefined) {
          return {
            status: "invalid_arguments",
            callId: request.callId,
            reason: result.invalidArguments,
          };
        }
        if (result.denied !== undefined) {
          denials.push({
            name: request.name,
            arguments: request.arguments,
            reason: result.denied,
          });
          return { status: "denied", callId: request.callId, reason: result.denied };
        }
        return result.error === undefined
          ? { status: "succeeded", callId: request.callId, output: result.output ?? {} }
          : { status: "failed", callId: request.callId, reason: result.error };
      },
    },
  };
}
