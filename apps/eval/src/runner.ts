import {
  AgentLoop,
  type AgentLoopFailureReason,
  type AgentLoopInput,
  assembleSystemPrompt,
  InMemoryLoopCheckpointStore,
  type ModelOutput,
  type ModelPort,
} from "@tulipfarm/agent-runtime";
import { splitPrompt } from "@tulipfarm/model-adapter";
import { textContent } from "@tulipfarm/schema";
import { autonomyBoundedDispatch, capabilityBoundedDispatch } from "./autonomy.ts";
import { type EvalCase, LOOP_LIMITS, readableLibrary, synthesizeAttachment } from "./case.ts";
import type { Corpus } from "./corpus.ts";
import { toolDispatcher } from "./dispatch.ts";
import { type EvalSoul, soulContext } from "./eval-soul.ts";
import { guardInput, guardOutput, screenableText } from "./guard-stage.ts";
import type { GuardrailDecision } from "./guardrails.ts";
import { turnGuardrails } from "./guardrails.ts";
import type { Judge } from "./judge.ts";
import { scoreJudged } from "./judged.ts";
import { runPersistedTurn } from "./l3/tier.ts";
import { measureNoise, type NoiseFloor } from "./noise.ts";
import { exposedToolsFor } from "./platform-tools.ts";
import type { SweepProgress } from "./progress.ts";
import { guardUnexercised } from "./red-team.ts";
import { measureResistance, type ResistanceRate } from "./resistance.ts";
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from "./retry.ts";
import { type ClassResult, safetyReport } from "./safety.ts";
import { type ExpectationResult, type Observation, scoreCase, seamUnreached } from "./scorer.ts";
import { addSpend, ceilingReached, mergeSpend, NO_SPEND, type Spend } from "./spend.ts";
import type { VulnerabilityClass } from "./vulnerability.ts";

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
  /**
   * The model version the vendor's API reported, once it has answered.
   *
   * Read after the Sweep rather than declared before it: a vendor rolling an alias forward is
   * the one change that looks exactly like a harness regression, and only the API can say it
   * happened.
   */
  reportedVersion?(): string | undefined;
  /**
   * Whether the model id is one the vendor cannot move.
   *
   * `false` for a subscription seat, whose id is an alias. A Scorecard that stayed silent would
   * imply a stability the Sweep does not have.
   */
  readonly dated?: boolean;
  /** The Effort rung this binding pins. Recorded so a reader knows what was measured. */
  readonly effort?: string;
  /**
   * Checked once before the first Trial, and expected to throw when the model cannot be measured.
   *
   * A credential that is set but malformed is otherwise only discovered by calling the vendor, and
   * every Case in the Corpus then fails the same way, slowly. Rejecting up front costs no Trials
   * and lets a Matrix record the model as unavailable rather than as a column of errors.
   */
  preflight?(): Promise<void> | void;
}

export interface TrialResult {
  readonly caseId: string;
  readonly trial: number;
  readonly passed: boolean;
  readonly expectations: readonly ExpectationResult[];
  readonly status: string;
  /** True when the Case expected nothing, so a green Scorecard cannot hide an empty Case. */
  readonly vacuous: boolean;
  /** Set only for an infrastructure failure, which is never scored as a Case failure. */
  readonly error?: string;
  readonly spend: Spend;
  /** Transient vendor failures this Trial survived. A green Trial that needed three is evidence. */
  readonly retries: number;
  /** True when some harness guard refused during this Trial. Only meaningful on a probabilistic
   *  Trial, where it separates "our defence held" from "the model happened to decline". */
  readonly guarded?: true;
  /** The weakness this Trial probed, carried so the safety Scorecard can group by class without
   *  reaching back into the Corpus. */
  readonly vulnerability?: VulnerabilityClass;
  /** Set on a red-team Case asserting `model_resisted`. Such a Trial is aggregated into a rate and
   *  held out of `passed`/`failed`, so a model's mood can never fail a release. */
  readonly probabilistic?: true;
  /**
   * Set when a `guard_held` Case's guard was never asked to refuse, because the model declined the
   * dangerous action first. Held out of `passed`/`failed` and of the safety verdict, and reported
   * as a coverage gap. See `guardUnexercised`.
   */
  readonly unexercised?: true;
}

export interface Scorecard {
  readonly corpusHash: string;
  readonly modelId: string;
  /** The version the vendor reported, when the binding could observe one. */
  readonly modelVersion?: string;
  /** False when the model id is an alias the vendor may move between Sweeps. */
  readonly modelDated: boolean;
  /** The Effort rung every Trial ran at, pinned rather than inferred. */
  readonly effort?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly trials: readonly TrialResult[];
  /** Gating Trials only. Probabilistic red-team Trials are counted in `resistance` instead. */
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /** Gating red-team Trials whose guard the model defused before it could be asked. Never gating,
   *  always reported: an unexercised guard is a coverage gap, not a pass. */
  readonly unexercised: number;
  /** Present only when the Corpus held `model_resisted` Cases. Reported, never gating. */
  readonly resistance?: readonly ResistanceRate[];
  /** Present only for a red-team Sweep. One row per vulnerability class, measured or not. */
  readonly safety?: readonly ClassResult[];
  readonly spend: Spend;
  /** Set when the Sweep stopped early; the Scorecard is then partial and never a release gate. */
  readonly abortedReason?: string;
  /** Cases the Sweep never reached, because it stopped early. */
  readonly skipped: number;
  /**
   * How many Cases the Corpus holds, which is not how many this Sweep ran.
   *
   * `--case` narrows the selection but not the hash, so a filtered Sweep is fully comparable by
   * `corpusHash` while covering one Case. Without this number nothing downstream can tell that
   * apart from a complete Sweep, and such a Scorecard promoted to Baseline would hide every Case
   * it omitted behind a permanent "not comparable".
   */
  readonly corpusCases: number;
  /** Run-to-run variance, when this Sweep repeated its Corpus enough to measure any. */
  readonly noise?: NoiseFloor;
}

export interface SweepOptions {
  readonly corpus: Corpus;
  readonly model: ModelBinding;
  readonly caseFilter?: string;
  /**
   * Cumulative dollars after which no further Trial is launched.
   *
   * A ceiling cannot be an exact cap: what a call costs is only knowable once it has been made.
   * This stops the Sweep at the first Trial boundary the total crosses, which bounds the overrun
   * to one Trial rather than to the whole remaining Corpus.
   */
  readonly maxSpendUsd?: number;
  /**
   * Cumulative tokens after which no further Trial is launched.
   *
   * The only ceiling that binds a subscription seat. A seat's marginal cost is genuinely zero, so
   * a dollar ceiling can never trip on one and a runaway Corpus would exhaust the operator's
   * quota unopposed. Tokens are what the vendor meters, so tokens are what bounds the Sweep.
   */
  readonly maxTokens?: number;
  readonly retry?: RetryPolicy;
  /**
   * Scores the Cases that carry a rubric.
   *
   * Absent is fine for a Corpus with none. A Corpus that has one and no Judge errors every such
   * Trial rather than skipping it: a quality check that passes because nothing measured it is
   * worse than no check at all.
   */
  readonly judge?: Judge;
  /**
   * Run every Case this many extra times over what it declares, to measure the noise floor.
   *
   * Multiplies rather than replaces, so a Case that already declares Trials for its own reasons
   * keeps them. A repeat of 1 is the ordinary Sweep.
   */
  readonly repeat?: number;
  /**
   * Called as the Sweep advances, so a run against a real seat is not several silent minutes.
   *
   * Optional and side-effect-only: the Scorecard is unchanged whether anything listens.
   */
  onProgress?(event: SweepProgress): void;
  now?(): Date;
}

/**
 * Loop failures that are the vendor's fault, not the harness's.
 *
 * Every `ModelInvocationFailureReason` is prefixed `model_`, but `empty_model_output` is not — and
 * it is raised after the repair budget is spent nudging a provider that answered with nothing.
 * Scoring that as a Case failure attributes a mute vendor to the harness, which is exactly the
 * confound this framework exists to remove.
 */
function isVendorFault(reason: AgentLoopFailureReason): boolean {
  return reason.startsWith("model_") || reason === "empty_model_output";
}

async function scored(
  evalCase: EvalCase,
  trial: number,
  vacuous: boolean,
  spend: Spend,
  retries: number,
  guardrails: readonly GuardrailDecision[],
  judge: Judge | undefined,
  observation: Omit<Observation, "guardrails">
): Promise<TrialResult> {
  const full: Observation = { ...observation, guardrails };
  // Judged results are appended rather than interleaved. A rubric is the slowest and least
  // reproducible check in the framework, so it reads last on the Scorecard too.
  const expectations = [
    ...scoreCase(evalCase.expect, full),
    ...(await scoreJudged(evalCase.expect, full, judge)),
  ];
  return {
    caseId: evalCase.id,
    trial,
    passed: expectations.every((a) => a.passed),
    expectations,
    status: observation.status,
    vacuous,
    spend,
    retries,
    ...(evalCase.redTeam?.outcome === "model_resisted" ? { probabilistic: true as const } : {}),
    ...(guardrails.length > 0 ? { guarded: true as const } : {}),
    ...(guardUnexercised(expectations, guardrails) ||
    seamUnreached(expectations, observation.toolCalls) !== undefined
      ? { unexercised: true as const }
      : {}),
    ...(evalCase.redTeam === undefined ? {} : { vulnerability: evalCase.redTeam.class }),
  };
}

/**
 * One Turn through the product's own Chat executor, against a real database.
 *
 * The Observation is built from what the Turn *persisted* rather than from what the loop returned,
 * because that is the whole point of the tier: an answer the model produced but the product failed
 * to store is not an answer a participant ever received.
 */
async function runL3Trial(
  evalCase: EvalCase,
  soul: EvalSoul,
  binding: ModelBinding,
  trial: number,
  judge: Judge | undefined
): Promise<TrialResult> {
  const vacuous = evalCase.expect.length === 0;
  // Accumulated out here, not read off the result: a Turn that throws after two paid calls must
  // still report what it billed, exactly as an L2 Trial does.
  let spend = NO_SPEND;
  try {
    const turn = await runPersistedTurn({
      evalCase,
      soul,
      binding,
      onUsage: (usage) => {
        spend = addSpend(spend, usage);
      },
    });
    return await scored(evalCase, trial, vacuous, turn.spend, 0, [], judge, {
      systemPrompt: turn.systemPrompt,
      toolCalls: turn.toolCalls,
      output: turn.answer === null ? undefined : { kind: "text", text: turn.answer },
      status: turn.runStatus === "succeeded" ? "completed" : turn.runStatus,
      persisted: {
        runStatus: turn.runStatus,
        stateStatus: turn.stateStatus,
        turnStatus: turn.turnStatus,
        events: turn.events,
        soulCommits: turn.soulCommits,
        publishedArtifacts: turn.publishedArtifacts,
        generatedFiles: turn.generatedFiles,
        curatorTasks: turn.curatorTasks,
      },
    });
  } catch (cause) {
    return errored(
      evalCase,
      trial,
      vacuous,
      cause instanceof Error ? cause.message : String(cause),
      spend,
      0
    );
  }
}

async function runTrial(
  evalCase: EvalCase,
  soul: EvalSoul,
  binding: ModelBinding,
  trial: number,
  retryPolicy: RetryPolicy,
  judge: Judge | undefined
): Promise<TrialResult> {
  if (evalCase.tier === "l3") return await runL3Trial(evalCase, soul, binding, trial, judge);
  const vacuous = evalCase.expect.length === 0;
  const tools = toolDispatcher(evalCase);
  const guards = turnGuardrails(soul, `${evalCase.id}#${trial}`);
  let lastOutput: ModelOutput | undefined;

  // The real assembler runs here, over the real Soul. Without either, the tier would measure the
  // Tool loop against a hand-written prompt and would never notice a Context-assembly regression.
  // The Soul goes first: what an Agent is belongs to the fixture, and a Case may only override the
  // platform instructions.
  const systemPrompt = assembleSystemPrompt({
    ...soulContext(soul, evalCase.agent),
    ...evalCase.context,
  });

  // Created once per Trial: a binding may hold per-Case state (the scripted binding holds the
  // script cursor), so rebuilding it per call would replay the first response forever.
  let spend = NO_SPEND;
  let retries = 0;
  // Retrying sits closest to the vendor so the loop never sees a throttle as an outcome, and the
  // usage of each failed attempt is still counted: a retried call was billed.
  const port = withRetry(binding.create(evalCase), retryPolicy, {
    attemptUsage: (usage) => {
      spend = addSpend(spend, usage);
    },
    retried: () => {
      retries += 1;
    },
  });
  // What the production prompt splitter actually emitted, not a second opinion about what it
  // should have. A Case asserting confinement has to read the same traversal that sends the bytes.
  const attachedFileIds = new Set<string>();
  const model: ModelPort = {
    invoke: async (request) => {
      for (const id of splitPrompt(request.messages, request.attachments).attached) {
        attachedFileIds.add(id);
      }
      const result = await port.invoke(request);
      lastOutput = result.output;
      spend = addSpend(spend, result.usage);
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
    // Guards wrap the dispatcher exactly as `TurnDriver` wraps it, so a blocked Tool reaches the
    // model as a denial it must recover from — not as a call that silently never happened. The
    // Agent's autonomy ceiling sits inside the guards, matching production's order: policy decides
    // before the ceiling is consulted about what is left.
    tools: guards.guard(
      capabilityBoundedDispatch(soul, evalCase, autonomyBoundedDispatch(soul, evalCase, tools.port))
    ),
    ...readableLibrary(evalCase),
    checkpoints: new InMemoryLoopCheckpointStore(),
    events: { append: async () => {} },
    budget: { consume: async () => ({ outcome: "allowed" }) },
    isCancelled: async () => false,
    log,
  });

  try {
    // Ordering is the driver's: bytes are resolved first because nothing can screen text it has
    // not read, then the input guard settles the turn before any model or Tool work — so a
    // refused request must cost nothing and must never reach the vendor.
    const attached = (evalCase.attachments ?? []).map(synthesizeAttachment);
    const guarded = await guardInput(guards, evalCase.input, await screenableText(attached));
    if (guarded.blocked) {
      return await scored(evalCase, trial, vacuous, spend, retries, guards.decisions, judge, {
        systemPrompt,
        toolCalls: [],
        output: { kind: "text", text: guarded.message },
        status: "completed",
        attachedFileIds: [...attachedFileIds],
      });
    }

    const input: AgentLoopInput = {
      businessId: "eval",
      runId: `${evalCase.id}#${trial}`,
      stateId: "invoke",
      modelProfileId: "eval",
      contextDigest: "sha256:eval",
      guardrailDigest: guards.digest,
      messages: [{ role: "system", content: textContent(systemPrompt) }, ...guarded.messages],
      tools: exposedToolsFor(evalCase),
      limits: LOOP_LIMITS,
      ...(attached.length === 0 ? {} : { attachments: attached }),
    };

    const outcome = await loop.run(input);

    // A vendor call that died is not a verdict on the harness. Scoring a rate-limit as a Case
    // failure is precisely the confound this framework exists to remove, so it is counted apart.
    if (outcome.status === "failed" && isVendorFault(outcome.reason)) {
      return errored(evalCase, trial, vacuous, modelError ?? outcome.reason, spend, retries);
    }

    const answered =
      outcome.status === "completed" ? asOutput(outcome.output, lastOutput) : lastOutput;
    return await scored(evalCase, trial, vacuous, spend, retries, guards.decisions, judge, {
      systemPrompt,
      attachedFileIds: [...attachedFileIds],
      toolCalls: tools.calls,
      // The output guard is the last thing production runs before an answer becomes durable, so a
      // Case scores the text a participant would actually have received.
      output: await guardOutput(guards, answered),
      status: outcome.status,
    });
  } catch (cause) {
    return errored(
      evalCase,
      trial,
      vacuous,
      cause instanceof Error ? cause.message : String(cause),
      spend,
      retries
    );
  }
}

/** An infrastructure failure is never a pass and never a Case failure. */
function errored(
  evalCase: EvalCase,
  trial: number,
  vacuous: boolean,
  error: string,
  spend: Spend,
  retries: number
): TrialResult {
  return {
    caseId: evalCase.id,
    trial,
    passed: false,
    expectations: [],
    status: "errored",
    vacuous,
    error,
    spend,
    retries,
    ...(evalCase.redTeam?.outcome === "model_resisted" ? { probabilistic: true as const } : {}),
    ...(evalCase.redTeam === undefined ? {} : { vulnerability: evalCase.redTeam.class }),
  };
}

/** A completed loop returns its own output; fall back to the last model output for tool-only runs. */
function asOutput(output: unknown, last: ModelOutput | undefined): ModelOutput | undefined {
  if (typeof output === "string") return { kind: "text", text: output };
  if (output !== undefined && output !== null) return { kind: "structured", value: output };
  return last;
}

/**
 * Cases a filter selects, and how many Trials they plan.
 *
 * Shared with `cli.ts` so a per-Trial ceiling is resolved against exactly the Trials this Sweep
 * will launch. Two counts that could drift would let the ceiling be computed for one Sweep and
 * enforced on another.
 */
export function selectCases(
  cases: readonly EvalCase[],
  caseFilter: string | undefined
): readonly EvalCase[] {
  return caseFilter === undefined ? cases : cases.filter((c) => c.id === caseFilter);
}

export function plannedTrials(cases: readonly EvalCase[], repeat = 1): number {
  return cases.reduce((n, c) => n + trialCount(c, repeat), 0);
}

/** How many Trials one Case runs, once its own declaration and the Sweep's repeat are combined. */
export function trialCount(evalCase: EvalCase, repeat = 1): number {
  return Math.max(1, evalCase.trials ?? 1) * Math.max(1, repeat);
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

  const selected = selectCases(options.corpus.cases, options.caseFilter);
  if (selected.length === 0) {
    throw new Error(`no Eval Case matches "${options.caseFilter}"`);
  }

  const planned = plannedTrials(selected, options.repeat);
  const retryPolicy = options.retry ?? DEFAULT_RETRY;
  const trials: TrialResult[] = [];
  let spend = NO_SPEND;
  let abortedReason: string | undefined;
  const report = options.onProgress ?? (() => {});
  await options.model.preflight?.();
  report({ kind: "sweep-start", modelId: options.model.id, cases: selected.length, planned });

  outer: for (const evalCase of selected) {
    const count = trialCount(evalCase, options.repeat);
    for (let trial = 1; trial <= count; trial += 1) {
      // Checked before launching rather than after: cost is only knowable once a call is made,
      // so the last Trial before the ceiling is allowed to exceed it and the next is not started.
      const stop = ceilingReached(spend, options, trials.length, planned);
      if (stop !== undefined) {
        abortedReason = stop;
        report({ kind: "sweep-aborted", reason: stop });
        break outer;
      }
      report({
        kind: "trial-start",
        caseId: evalCase.id,
        trial,
        index: trials.length + 1,
        planned,
      });
      const result = await runTrial(
        evalCase,
        options.corpus.soul,
        options.model,
        trial,
        retryPolicy,
        options.judge
      );
      report({ kind: "trial-end", result });
      trials.push(result);
      spend = mergeSpend(spend, result.spend);
    }
  }

  const version = options.model.reportedVersion?.();
  const gating = trials.filter((t) => t.probabilistic !== true);
  const resistance = measureResistance(trials);

  const card: Scorecard = {
    corpusHash: options.corpus.hash,
    modelId: options.model.id,
    ...(version === undefined ? {} : { modelVersion: version }),
    modelDated: options.model.dated ?? true,
    ...(options.model.effort === undefined ? {} : { effort: options.model.effort }),
    startedAt: started.toISOString(),
    durationMs: now().getTime() - started.getTime(),
    trials,
    passed: gating.filter((t) => t.passed && t.error === undefined && !t.unexercised).length,
    failed: gating.filter((t) => !t.passed && t.error === undefined && !t.unexercised).length,
    errored: gating.filter((t) => t.error !== undefined).length,
    unexercised: gating.filter((t) => t.unexercised === true).length,
    spend,
    ...(abortedReason === undefined ? {} : { abortedReason }),
    skipped: planned - trials.length,
    corpusCases: options.corpus.cases.length,
    ...(resistance.length === 0 ? {} : { resistance }),
    ...(trials.some((t) => t.vulnerability !== undefined) ? { safety: safetyReport(trials) } : {}),
  };

  const noise = measureNoise(card);
  return noise === undefined ? card : { ...card, noise };
}
