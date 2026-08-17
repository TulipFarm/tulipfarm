import {
  AgentLoop,
  type AgentLoopInput,
  assembleSystemPrompt,
  InMemoryLoopCheckpointStore,
  type ModelMessage,
  type ModelOutput,
  type ModelPort,
  type ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { type EvalCase, LOOP_LIMITS } from "./case.ts";
import type { Corpus } from "./corpus.ts";
import { type AssertionResult, type Observation, scoreCase } from "./scorer.ts";

/**
 * How a Sweep obtains a model for one Case.
 *
 * This is the single injection point the framework needs: the scripted binding, a pinned real
 * model and the Judge all satisfy it, because `AgentLoop` only ever sees a `ModelPort`.
 */
export interface ModelBinding {
  /** Recorded in the Scorecard; a comparison across different ids is not a comparison. */
  readonly id: string;
  create(evalCase: EvalCase): ModelPort;
}

export interface TrialResult {
  readonly caseId: string;
  readonly trial: number;
  readonly passed: boolean;
  readonly assertions: readonly AssertionResult[];
  readonly status: string;
  /** True when the Case asserted nothing, so a green Scorecard cannot hide an empty Case. */
  readonly unasserted: boolean;
  /** Set only for an infrastructure failure, which is never scored as a Case failure. */
  readonly error?: string;
}

export interface Scorecard {
  readonly corpusHash: string;
  readonly modelId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly trials: readonly TrialResult[];
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
}

export interface SweepOptions {
  readonly corpus: Corpus;
  readonly model: ModelBinding;
  readonly caseFilter?: string;
  now?(): Date;
}

/** Faked dispatch: results are matched by Tool name and consumed in call order. */
function toolDispatcher(evalCase: EvalCase) {
  const pending = [...(evalCase.toolResults ?? [])];
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
        if (at === -1) {
          return { status: "succeeded", callId: request.callId, output: {} };
        }
        const [result] = pending.splice(at, 1);
        return result.error === undefined
          ? { status: "succeeded", callId: request.callId, output: result.output ?? {} }
          : { status: "failed", callId: request.callId, reason: result.error };
      },
    },
  };
}

async function runTrial(
  evalCase: EvalCase,
  binding: ModelBinding,
  trial: number
): Promise<TrialResult> {
  const unasserted = evalCase.expect.length === 0;
  const tools = toolDispatcher(evalCase);
  let lastOutput: ModelOutput | undefined;

  // The real assembler runs here. Without it the tier would measure the Tool loop against a
  // hand-written prompt and would never notice a Context-assembly regression.
  const systemPrompt = assembleSystemPrompt(evalCase.context);

  // Created once per Trial: a binding may hold per-Case state (the scripted binding holds the
  // script cursor), so rebuilding it per call would replay the first response forever.
  const port = binding.create(evalCase);
  const model: ModelPort = {
    invoke: async (request) => {
      const result = await port.invoke(request);
      lastOutput = result.output;
      return result;
    },
  };

  // The loop owns a model failure as an outcome and only reports the underlying message through
  // its logger, so this is the sole way to surface why a vendor call died.
  let modelError: string | undefined;
  const log = {
    warn: (obj: unknown, _msg?: string) => {
      const record = obj as { event?: string; error?: string };
      if (record?.event === "agent_loop.model_error") modelError = record.error;
    },
  };

  const loop = new AgentLoop({
    model,
    tools: tools.port,
    checkpoints: new InMemoryLoopCheckpointStore(),
    events: { append: async () => {} },
    budget: { consume: async () => ({ outcome: "allowed" }) },
    isCancelled: async () => false,
    log,
  });

  const messages: ModelMessage[] = [{ role: "system", content: systemPrompt }, ...evalCase.input];
  const input: AgentLoopInput = {
    businessId: "eval",
    runId: `${evalCase.id}#${trial}`,
    stateId: "invoke",
    modelProfileId: "eval",
    contextDigest: "sha256:eval",
    guardrailDigest: "sha256:eval",
    messages,
    tools: evalCase.tools ?? [],
    limits: LOOP_LIMITS,
  };

  try {
    const outcome = await loop.run(input);

    // A vendor call that died is not a verdict on the harness. Scoring a rate-limit as a Case
    // failure is precisely the confound this framework exists to remove, so it is counted apart.
    if (outcome.status === "failed" && outcome.reason.startsWith("model_")) {
      return errored(evalCase, trial, unasserted, modelError ?? outcome.reason);
    }

    const observation: Observation = {
      systemPrompt,
      toolCalls: tools.calls,
      output: outcome.status === "completed" ? asOutput(outcome.output, lastOutput) : lastOutput,
      status: outcome.status,
    };
    const assertions = scoreCase(evalCase.expect, observation);
    return {
      caseId: evalCase.id,
      trial,
      passed: assertions.every((a) => a.passed),
      assertions,
      status: outcome.status,
      unasserted,
    };
  } catch (cause) {
    return errored(
      evalCase,
      trial,
      unasserted,
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}

/** An infrastructure failure is never a pass and never a Case failure. */
function errored(
  evalCase: EvalCase,
  trial: number,
  unasserted: boolean,
  error: string
): TrialResult {
  return {
    caseId: evalCase.id,
    trial,
    passed: false,
    assertions: [],
    status: "errored",
    unasserted,
    error,
  };
}

/** A completed loop returns its own output; fall back to the last model output for tool-only runs. */
function asOutput(output: unknown, last: ModelOutput | undefined): ModelOutput | undefined {
  if (typeof output === "string") return { kind: "text", text: output };
  if (output !== undefined && output !== null) return { kind: "structured", value: output };
  return last;
}

/**
 * Execute a Corpus against one model binding and return a Scorecard.
 *
 * The single seam the eval framework adds. One Case failing never aborts the Sweep — one bad Case
 * must not cost the whole run's information.
 */
export async function runSweep(options: SweepOptions): Promise<Scorecard> {
  const now = options.now ?? (() => new Date());
  const started = now();

  const selected =
    options.caseFilter === undefined
      ? options.corpus.cases
      : options.corpus.cases.filter((c) => c.id === options.caseFilter);
  if (selected.length === 0) {
    throw new Error(`no Eval Case matches "${options.caseFilter}"`);
  }

  const trials: TrialResult[] = [];
  for (const evalCase of selected) {
    const count = Math.max(1, evalCase.trials ?? 1);
    for (let trial = 1; trial <= count; trial += 1) {
      trials.push(await runTrial(evalCase, options.model, trial));
    }
  }

  return {
    corpusHash: options.corpus.hash,
    modelId: options.model.id,
    startedAt: started.toISOString(),
    durationMs: now().getTime() - started.getTime(),
    trials,
    passed: trials.filter((t) => t.passed && t.error === undefined).length,
    failed: trials.filter((t) => !t.passed && t.error === undefined).length,
    errored: trials.filter((t) => t.error !== undefined).length,
  };
}
