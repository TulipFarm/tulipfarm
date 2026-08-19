import type {
  AssembleContext,
  ExposedTool,
  ModelMessage,
  ModelOutput,
} from "@tulipfarm/agent-runtime";
import type { RedTeam } from "./red-team.ts";

/**
 * One deterministic, model-free check against a Trial's observation.
 *
 * Expectations are data, never functions, so a Corpus can be content-hashed and a Case can be
 * authored without writing code.
 */
export type Expectation =
  /** The assembled system prompt contains this text — the only check that proves the real Context
   *  assembler ran, rather than a hand-written prompt being fed to the loop. */
  | { readonly kind: "prompt_contains"; readonly text: string }
  | { readonly kind: "prompt_omits"; readonly text: string }
  | { readonly kind: "tool_called"; readonly name: string }
  | { readonly kind: "tool_not_called"; readonly name: string }
  /** The named Tools were called in this relative order; unnamed calls between them are ignored. */
  | { readonly kind: "tool_call_order"; readonly names: readonly string[] }
  | {
      readonly kind: "tool_argument_equals";
      readonly name: string;
      readonly path: string;
      readonly value: unknown;
    }
  | { readonly kind: "output_contains"; readonly text: string; readonly ungrounded?: string }
  | { readonly kind: "output_matches"; readonly pattern: string; readonly ungrounded?: string }
  /** The answer does not contain this text. The one way to assert a guard actually removed
   *  something, rather than merely that it recorded a refusal.
   *
   *  The text must be grounded — something the model was given and could have repeated — or the
   *  expectation passes with the guard deleted. `ungrounded` states why not, for the rarer Case
   *  asserting the model must not *invent* something. */
  | { readonly kind: "output_omits"; readonly text: string; readonly ungrounded?: string }
  | { readonly kind: "output_field_equals"; readonly path: string; readonly value: unknown }
  | { readonly kind: "loop_status"; readonly status: string }
  | { readonly kind: "tool_call_count"; readonly count: number }
  /** A guard refused at this stage. Naming the guard pins *which* rule fired, not merely that one
   *  did — a Case that only asserted "something blocked" would go on passing after the policy was
   *  replaced by a stricter unrelated rule. */
  | { readonly kind: "guardrail_blocked"; readonly stage: string; readonly guard: string }
  /** Prose quality the deterministic Expectations cannot reach, scored by a pinned third-vendor
   *  Judge against explicit criteria. Use only where `===` genuinely cannot do the job — a rubric
   *  is slower, costs money and is less reproducible than a string check. */
  | {
      readonly kind: "rubric_score";
      readonly criteria: readonly string[];
      /** The lowest score on the fixed 1–5 scale that still passes. */
      readonly min: number;
    }
  /** The safety variant: one question, answered, rather than a quality rating. */
  | { readonly kind: "rubric_denies"; readonly question: string }
  /** No guard refused at this stage. This is what catches an over-eager guardrail: the Case fails
   *  when a stage that should have let a benign turn through starts refusing it. */
  | { readonly kind: "guardrail_allowed"; readonly stage: string }
  /** L3 only. The Run's terminal status, as the Run kernel recorded it. */
  | { readonly kind: "run_status"; readonly status: string }
  /** L3 only. The `invoke` State's terminal status — a Turn that answered but left its State
   *  parked is a Run the reconciler will pick up, not a finished turn. */
  | { readonly kind: "state_status"; readonly status: string }
  /** L3 only. The Turn was completed, and with this verdict. */
  | { readonly kind: "turn_status"; readonly status: string }
  /** L3 only. This Run event type was appended durably. L2 stubs the event port, so this is the
   *  only place a Turn that stopped emitting its events can be caught. */
  | { readonly kind: "run_event_emitted"; readonly eventType: string }
  /** L3 only. A Soul artifact was committed to the Eval Soul's real git repository. */
  | { readonly kind: "soul_committed"; readonly path: string };

/** Expectations that read persisted state, which only the L3 tier can observe. */
const PERSISTED_KINDS: ReadonlySet<string> = new Set([
  "run_status",
  "state_status",
  "turn_status",
  "run_event_emitted",
  "soul_committed",
]);

export function isPersisted(expectation: Expectation): boolean {
  return PERSISTED_KINDS.has(expectation.kind);
}

/**
 * Expectations that read guardrail decisions, which only the L2 tier collects.
 *
 * L3 really does run the guards — the executor calls them — but it does not surface their
 * decisions, so `guardrail_allowed` would pass by finding nothing rather than by the guard having
 * allowed anything.
 */
export function isGuardrail(expectation: Expectation): boolean {
  return expectation.kind.startsWith("guardrail_");
}

/** A faked Tool dispatch, matched to a call by Tool name and consumed in order. */
export interface ScriptedToolResult {
  readonly name: string;
  readonly output?: unknown;
  /** Present to script a Tool that fails, so refusal and recovery behaviour can be measured. */
  readonly error?: string;
}

/**
 * One Turn of a multi-Turn journey, in the same vocabulary a single-Turn Case already uses.
 *
 * Reusing `input`, `script` and `toolResults` rather than inventing journey-specific names keeps
 * the Case format one format: a journey Turn is a Case's Turn, not a new kind of thing.
 */
export interface JourneyTurn {
  readonly input: readonly ModelMessage[];
  readonly toolResults?: readonly ScriptedToolResult[];
  readonly script?: readonly ModelOutput[];
}

export interface EvalCase {
  readonly id: string;
  /**
   * `l2` drives the Agent loop directly; `l3` drives the product's own Chat executor against a real
   * database. Nearly all the signal is at L2, and L3 is deliberately small — it exists to prove the
   * Run lifecycle around the loop, which L2 stubs and therefore cannot notice breaking.
   */
  readonly tier: "l2" | "l3";
  readonly agent: string;
  /** What feeds the real Context assembler. The assembler's output is what the model sees. */
  readonly context: AssembleContext;
  readonly input: readonly ModelMessage[];
  readonly tools?: readonly ExposedTool[];
  readonly toolResults?: readonly ScriptedToolResult[];
  /**
   * Model outputs replayed in order by the scripted binding.
   *
   * Ignored entirely by a real-model binding. It exists so the whole Corpus stays runnable for
   * free and deterministically in ordinary CI, which is what lets a contributor without
   * credentials develop the framework.
   */
  readonly script?: readonly ModelOutput[];
  /**
   * L3 only. Further Turns run against the same Conversation, database and Soul as `input`.
   *
   * This exists for one seam a single Turn cannot reach: whether what a Turn *committed* is what
   * the next Turn can *see*. Everything else a journey appears to test — history, ordering — is
   * carried more cheaply by an L2 Case, so keep journeys rare.
   */
  readonly journey?: readonly JourneyTurn[];
  /**
   * L3 only. Breaks one of the executor's dependencies, so a Case can measure what the Turn does
   * when its surroundings fail rather than when the model does.
   *
   * Every tier otherwise hands the executor working ports, which means the Corpus can only observe
   * a Turn that got as far as the loop. A Turn abandoned *before* the loop — Context unreadable,
   * Soul unreachable — is the one failure a participant can neither see nor retry, so it is worth
   * the one knob it takes to reach it. `"context"` fails Context resolution.
   */
  readonly fault?: "context";
  readonly expect: readonly Expectation[];
  /** Raised above 1 only for Cases used to measure the Noise Floor. */
  readonly trials?: number;
  /** Present only on Cases in `corpus/red-team/`. Declares which of the two good endings this
   *  Case asserts, which decides whether it gates the release or is reported as a rate. */
  readonly redTeam?: RedTeam;
}

export const LOOP_LIMITS = {
  maxIterations: 8,
  maxToolCalls: 16,
  maxRepairAttempts: 2,
} as const;

/**
 * Expectation kinds a Judge answers rather than the deterministic scorer.
 *
 * Lives here rather than beside either scorer so both can import it without a cycle.
 */
export function isJudged(a: Expectation): boolean {
  return a.kind === "rubric_score" || a.kind === "rubric_denies";
}
