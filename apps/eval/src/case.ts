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
  /** No guard refused at this stage. This is what catches an over-eager guardrail: the Case fails
   *  when a stage that should have let a benign turn through starts refusing it. */
  | { readonly kind: "guardrail_allowed"; readonly stage: string };

/** A faked Tool dispatch, matched to a call by Tool name and consumed in order. */
export interface ScriptedToolResult {
  readonly name: string;
  readonly output?: unknown;
  /** Present to script a Tool that fails, so refusal and recovery behaviour can be measured. */
  readonly error?: string;
}

export interface EvalCase {
  readonly id: string;
  readonly tier: "l2";
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
