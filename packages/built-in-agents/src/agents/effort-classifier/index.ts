import type {
  EffortClassifierPort,
  ModelRequirements,
  ModelRequirementsPolicy,
} from "@tulipfarm/agent-runtime";
import { generateText } from "ai";
import {
  type BuiltInAgentModelSource,
  type BuiltInAgentSpec,
  builtInAgentRequirements,
} from "../../agent";
import { withDeadline } from "../../deadline";
import { untrusted } from "../../untrusted";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompt";

/**
 * Stage 2 effort routing: ask the weakest configured model for one label.
 *
 * `route()` scores the prompt with pure signals first and only calls here near a threshold, so
 * this runs on the genuinely ambiguous minority. Its answer is persisted and replayed as a pin, so
 * a re-dispatched Run routes the way its first attempt did rather than paying for a second
 * opinion.
 */
export const EFFORT_CLASSIFIER: BuiltInAgentSpec = {
  id: "effort_classifier",
  purpose: "Label how much model capability one request needs: fast, balanced, or thorough.",
  // A concrete rung, so the router does not route itself.
  rung: "fast",
  // Allows a label plus tiny formatting noise, but cuts off explanations. Not lower: the Azure
  // Responses API rejects `max_output_tokens` below 16, and that 400 sheds the whole provider.
  maxOutputTokens: 16,
  // Bounded so a stalled provider costs a few seconds, not the turn.
  timeoutMs: 5_000,
};

/** The heuristic scores length already; send only the opening intent. */
const CLASSIFIER_PROMPT_CHARS = 2_000;

export interface EffortClassifierOptions<TGate = never> {
  readonly models: BuiltInAgentModelSource<TGate>;
  /** Same residency/retention/training constraints as the turn being routed. */
  readonly requirements: ModelRequirements;
  readonly timeoutMs?: number;
}

export function createEffortClassifier<TGate = never>(
  options: EffortClassifierOptions<TGate>
): EffortClassifierPort {
  return {
    async classify(prompt: string): Promise<string> {
      // Armed before resolution, not after: the declared deadline is the budget for the whole
      // call, and resolving a model in the Worker can cross a process boundary.
      const signal = AbortSignal.timeout(options.timeoutMs ?? EFFORT_CLASSIFIER.timeoutMs);
      const model = await withDeadline(
        options.models.model(EFFORT_CLASSIFIER.rung, options.requirements),
        signal
      );
      const { text } = await generateText({
        model,
        system: CLASSIFIER_SYSTEM_PROMPT,
        prompt: untrusted("request", prompt.slice(0, CLASSIFIER_PROMPT_CHARS)),
        maxOutputTokens: EFFORT_CLASSIFIER.maxOutputTokens,
        abortSignal: signal,
      });
      return text;
    },
  };
}

/** Carries governance forward while stripping Tool and structured-output needs. */
export function classifierRequirements(turn: ModelRequirementsPolicy): ModelRequirements {
  return builtInAgentRequirements(turn, EFFORT_CLASSIFIER, CLASSIFIER_PROMPT_CHARS);
}
