import { routineIdempotencyKey, type ScriptExecutionPlan } from "@tulipfarm/run-kernel";
import { analyzeHook, HookAnalysisError, runRoutineHook } from "@tulipfarm/sandbox";

/**
 * Runs a `script` State's authored TypeScript in the Routine isolate.
 *
 * The isolate is the same one Resource hooks use: memory-capped, time-bounded, clock-frozen, with
 * no filesystem, no host reach and — crucially — **no network**. That seal is the whole point. A
 * `script` State transforms data a Routine already holds; fetching anything is an `action`
 * State's job, where the call is credential-brokered, authority-gated and recorded in the effect
 * ledger. Opening a socket here would route effects around all three.
 */

export type RoutineScriptOutcome =
  | { readonly kind: "succeeded"; readonly output: unknown }
  /** A definitive negative an authored `onError` handler may claim by reason code. */
  | { readonly kind: "failed"; readonly reason: string };

export interface RoutineScriptRequest {
  readonly runId: string;
  readonly stateKey: string;
  readonly plan: ScriptExecutionPlan;
}

export interface RoutineScriptPort {
  execute(request: RoutineScriptRequest): Promise<RoutineScriptOutcome>;
}

/** Stable per State occurrence, so a replayed State asks the isolate the identical question. */
function invocationId(request: RoutineScriptRequest): number {
  const key = routineIdempotencyKey(request.runId, request.stateKey);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

export class SandboxRoutineScriptPort implements RoutineScriptPort {
  async execute(request: RoutineScriptRequest): Promise<RoutineScriptOutcome> {
    const { plan } = request;

    // Static refusal first. A banned construct is a property of the source, not of this Run, so
    // catching it here names the real fault instead of letting it surface as a timeout.
    try {
      analyzeHook(plan.source);
    } catch (error) {
      if (error instanceof HookAnalysisError) return { kind: "failed", reason: "rejected_source" };
      throw error;
    }

    const response = await runRoutineHook({
      id: invocationId(request),
      kind: "routine-hook",
      hookSource: plan.source,
      fnName: plan.entry,
      invocation: { runId: request.runId, stateKey: request.stateKey },
      args: plan.input,
      // Pinned to the State occurrence, so a retried attempt draws the same randoms and mints the
      // same ids as the attempt it replaces, rather than writing data that silently disagrees.
      determinismSeed: routineIdempotencyKey(request.runId, request.stateKey),
    });

    if (response.ok) {
      return { kind: "succeeded", output: "value" in response ? response.value : null };
    }
    return { kind: "failed", reason: response.timedOut === true ? "timed_out" : "threw" };
  }
}
