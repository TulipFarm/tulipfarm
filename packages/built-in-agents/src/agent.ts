import type { ModelRequirements, ModelRequirementsPolicy } from "@tulipfarm/agent-runtime";
import type { LanguageModel } from "ai";

/**
 * What a BuiltInAgent is, and what every one of them must declare.
 *
 * A BuiltInAgent is a single-shot model call the product makes for itself: to shrink a Tool
 * result, to route effort, to title a chat, to review a Skill, to propose onboarding steps. It is
 * deliberately not an {@link https://tulip.farm | Agent} in the product sense — it has no persona,
 * no Tools, no Run, no Soul artifact, and no user or Agent can address it. Nobody asks for one;
 * the runtime fires it.
 *
 * They live together because they share a hazard, not because they share code. Every one of them
 * reads text somebody outside the instance wrote — a fetched page, a person's first message, a
 * downloaded `SKILL.md`, a business description — and hands it to a model. Scattered across two
 * applications they drifted: two fenced their input and three did not, two bounded their output
 * and three ran unbounded. `built_in_agents.test.ts` now fails the build when a new one skips
 * either.
 */

/** The executable model a BuiltInAgent calls. Structurally what `LlmService.effortModel` returns. */
export type BuiltInAgentModel = LanguageModel;

/**
 * A concrete rung, never `auto`.
 *
 * A BuiltInAgent that asked for `auto` would route itself, and the router is a BuiltInAgent.
 * `thorough` is absent on purpose: none of this work is worth the strong model, and one that
 * needed it would be doing an Agent's job in a place with no Run, no Tools and no audit trail.
 */
export type BuiltInAgentRung = "fast" | "balanced";

/**
 * The declared identity and bounds of one BuiltInAgent.
 *
 * Every field is enforced somewhere. `rung` picks the model, `maxOutputTokens` caps the reply,
 * and `timeoutMs` is the deadline past which the caller stops waiting. The point of writing them
 * down rather than inlining constants is that the set becomes reviewable: the fitness test reads
 * this, so "does every BuiltInAgent bound itself?" is a question with a mechanical answer.
 */
export interface BuiltInAgentSpec {
  /** Stable identifier. Appears in logs and in the fitness test's failure message. */
  readonly id: string;
  /** One line, present tense, describing what it is asked to produce. */
  readonly purpose: string;
  readonly rung: BuiltInAgentRung;
  /** Hard ceiling on the reply. A BuiltInAgent that can talk forever can be made to. */
  readonly maxOutputTokens: number;
  /**
   * How long the call may take before it is abandoned.
   *
   * Enforced by whoever owns the deadline: most agents set their own `AbortSignal.timeout`, while
   * the distiller's is imposed by the Tool loop that calls it. Either way the number is here, so
   * the ceiling is reviewable in one place rather than three.
   */
  readonly timeoutMs: number;
}

/**
 * Resolves a rung to an executable model, for the two BuiltInAgents that run inside a Turn.
 *
 * Declared here rather than imported from `@tulipfarm/llm` because this package must not depend on
 * a provider: the same rule that split the distiller into a port and an implementation in the
 * first place. `SoulLlm.model` satisfies it structurally.
 *
 * `TGate` is the host's own per-provider admission control, carried through untouched. It is a
 * type parameter rather than a named import for the same reason — the gate belongs to
 * `@tulipfarm/llm`, and naming its type here would recreate the edge this port exists to avoid.
 */
export interface BuiltInAgentModelSource<TGate = never> {
  model(
    selector: BuiltInAgentRung,
    requirements: ModelRequirements,
    gate?: TGate
  ): Promise<BuiltInAgentModel>;
}

/**
 * Governance carried from the caller, stripped to what a single-shot text call needs.
 *
 * A BuiltInAgent reads the same bytes the Turn's own model reads, so it inherits the Turn's
 * residency, retention, training and sensitivity constraints exactly — never looser, and never
 * stricter in a way that would deny work the Turn's own model was allowed to do. Derived per call
 * from the policy the Turn carries, never fixed when the agent was built: one configured at boot
 * would read a sensitive Turn's content under whatever constraints happened to hold at startup.
 *
 * It never needs Tools or structured output from the provider's side, and it only ever reads and
 * writes text.
 */
export function builtInAgentRequirements(
  policy: ModelRequirementsPolicy,
  spec: BuiltInAgentSpec,
  promptChars: number
): ModelRequirements {
  const { sensitive = false, ...governance } = policy;
  return {
    ...governance,
    sensitive,
    needsTools: false,
    needsStructuredOutput: false,
    estimatedContextTokens: Math.ceil(promptChars / 4) + spec.maxOutputTokens,
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
}
