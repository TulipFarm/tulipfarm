import type { EffortClassifierPort, ModelRequirements } from "@tulipfarm/agent-runtime";
import { generateText, type LanguageModel } from "ai";

/** Stage 2 effort routing: ask the weakest configured model for one label. */

/** Resolves a selector to an executable model. Satisfied by `SoulLlm.model`. */
export interface EffortClassifierModelSource {
  model(selector: string, requirements: ModelRequirements): Promise<LanguageModel>;
}

/** A concrete rung, never `auto`, so the router does not route itself. */
const CLASSIFIER_RUNG = "fast";

/** Allows a label plus tiny formatting noise, but cuts off explanations. */
const CLASSIFIER_MAX_OUTPUT_TOKENS = 8;

/** The heuristic scores length already; send only the opening intent. */
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
  /** Same residency/retention/training constraints as the turn being routed. */
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

/** Carries governance forward while stripping Tool and structured-output needs. */
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
