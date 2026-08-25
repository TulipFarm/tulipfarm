import { ajv } from "@tulipfarm/schema";
import { generateObject, jsonSchema } from "ai";
import type { BuiltInAgentModel, BuiltInAgentSpec } from "../../agent";
import { untrusted } from "../../untrusted";
import { ONBOARDING_SYSTEM_PROMPT } from "./prompt";
import { type OnboardingSoulState, PERSONALIZED_SCHEMA, type Personalized } from "./schema";

/**
 * Proposes what a new instance should build next.
 *
 * Reads the business description the operator gave at setup plus what the Soul already holds, and
 * returns the chips the chat landing screen offers. Purely cosmetic: the caller caches the result
 * and falls back to a static catalog whenever this is unavailable, so nothing depends on it
 * answering.
 *
 * The caching, the in-flight de-duplication and the decision to run at all stay with the caller —
 * this is the model call and the shape of its answer, nothing else.
 */
export const ONBOARDING_PERSONALIZER: BuiltInAgentSpec = {
  id: "onboarding_personalizer",
  purpose: "Propose the next things a business should build, given its description and its Soul.",
  rung: "fast",
  // Five to seven short items, each an id, a label and a seed prompt.
  maxOutputTokens: 900,
  // Runs in the background off a landing-page request. Nothing waits on it, but an abandoned
  // call should stop consuming a provider slot rather than hang until the process restarts.
  timeoutMs: 30_000,
};

const validatePersonalized = ajv.compile(PERSONALIZED_SCHEMA);

async function repairFencedJson({ text }: { text: string }): Promise<string | null> {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return match?.[1]?.trim() ?? null;
}

/** Run the LLM call and return a validated {@link Personalized}. Throws on malformed output. */
export async function generatePersonalized(
  model: BuiltInAgentModel,
  ctx: { businessName?: string; businessDescription: string; state: OnboardingSoulState }
): Promise<Personalized> {
  const { object } = await generateObject({
    model,
    schema: jsonSchema<Personalized>(PERSONALIZED_SCHEMA),
    experimental_repairText: repairFencedJson,
    system: ONBOARDING_SYSTEM_PROMPT,
    prompt: untrusted(
      "business",
      [
        `Business name: ${ctx.businessName ?? "(unnamed)"}`,
        `Business description: ${ctx.businessDescription}`,
        "",
        "Already in the soul:",
        `- resource types: ${ctx.state.resources.join(", ") || "(none)"}`,
        `- agents: ${ctx.state.agents.join(", ") || "(none)"}`,
        `- skills: ${ctx.state.skills.join(", ") || "(none)"}`,
      ].join("\n")
    ),
    maxOutputTokens: ONBOARDING_PERSONALIZER.maxOutputTokens,
    abortSignal: AbortSignal.timeout(ONBOARDING_PERSONALIZER.timeoutMs),
  });

  if (!validatePersonalized(object)) {
    throw new Error(
      `Onboarding personalization produced invalid output: ${ajv.errorsText(validatePersonalized.errors)}`
    );
  }
  return object;
}

export { ONBOARDING_SYSTEM_PROMPT } from "./prompt";
export {
  type OnboardingSoulState,
  type OnboardingSuggestion,
  PERSONALIZED_SCHEMA,
  type Personalized,
} from "./schema";
