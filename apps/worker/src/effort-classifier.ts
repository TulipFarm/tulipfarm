import type { EffortClassifierPort, ModelRequirements } from "@tulipfarm/agent-runtime";
import { generateText, type LanguageModel } from "ai";

/**
 * Stage 2 of the effort router: the quick-tier model, asked for one word.
 *
 * It lives in this app because it needs a provider and a credential, and the Worker is the only
 * process that holds them. The decision itself stays in `@tulipfarm/agent-runtime` — this is the
 * hand that makes the call, not the head that reads the answer.
 *
 * The classifier always runs at the **weakest** configured rung. Paying a strong model to decide
 * which model to pay would defeat the funnel entirely.
 */

/** Resolves a selector to an executable model. Satisfied by `SoulLlm.model`. */
export interface EffortClassifierModelSource {
  model(selector: string, requirements: ModelRequirements): Promise<LanguageModel>;
}

/**
 * The rung the classifier itself runs at.
 *
 * A rung, never `auto` — routing `auto` here would ask the router to route the router.
 */
const CLASSIFIER_RUNG = "fast";

/**
 * One word is one to three tokens; the headroom absorbs a leading newline or a stray quote without
 * paying for a sentence. A model that wants to explain itself is cut off, and an answer that is not
 * a bare label resolves to the middle rung — which is the correct reading of "it did not answer".
 */
const CLASSIFIER_MAX_OUTPUT_TOKENS = 8;

/**
 * How much of the prompt the classifier is shown.
 *
 * Length is already scored by the heuristic, so sending a 50,000-character brief in full would buy
 * nothing and bill for it. The opening is what carries the intent.
 */
const CLASSIFIER_PROMPT_CHARS = 2_000;

/** Bounded so a stalled provider costs a few seconds, not the turn. */
const CLASSIFIER_TIMEOUT_MS = 5_000;

const CLASSIFIER_SYSTEM_PROMPT = [
  "You classify how much model capability a request needs.",
  "Answer with exactly one word, lowercase, and nothing else:",
  "fast — a greeting, a simple lookup, or a one-step factual answer.",
  "balanced — ordinary work: a focused change, a short explanation, a single tool call.",
  "thorough — design, architecture, trade-offs, multi-step plans, or hard debugging.",
  "Do not answer the request. Do not explain. Output only one of: fast, balanced, thorough.",
].join("\n");

export interface EffortClassifierOptions {
  readonly models: EffortClassifierModelSource;
  /**
   * Governance the classifier inherits from the turn it is routing — residency, retention,
   * training. The classifier sends the participant's own words to a provider, so it must be held
   * to exactly the constraints the turn itself is held to, never to a laxer default.
   */
  readonly requirements: ModelRequirements;
  readonly timeoutMs?: number;
}

export function createEffortClassifier(options: EffortClassifierOptions): EffortClassifierPort {
  return {
    async classify(prompt: string): Promise<string> {
      const model = await options.models.model(CLASSIFIER_RUNG, options.requirements);
      const { text } = await generateText({
        model,
        system: CLASSIFIER_SYSTEM_PROMPT,
        prompt: prompt.slice(0, CLASSIFIER_PROMPT_CHARS),
        maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(options.timeoutMs ?? CLASSIFIER_TIMEOUT_MS),
      });
      return text;
    },
  };
}

/**
 * What the classifier's own call needs from a model — nothing beyond text.
 *
 * Derived from the turn's requirements so governance carries over, but with capability stripped:
 * the classifier calls no Tool and returns no structured output, and demanding either would deny
 * the weak profile that is the whole point of running here.
 */
export function classifierRequirements(turn: ModelRequirements): ModelRequirements {
  return {
    ...turn,
    needsTools: false,
    needsStructuredOutput: false,
    estimatedContextTokens: Math.ceil(CLASSIFIER_PROMPT_CHARS / 4) + CLASSIFIER_MAX_OUTPUT_TOKENS,
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
}
