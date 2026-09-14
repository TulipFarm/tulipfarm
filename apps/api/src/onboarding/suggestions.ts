import { ONBOARDING_FALLBACK } from "@tulipfarm/built-in-agents";
import type { SoulLoader } from "@tulipfarm/soul";

export interface Suggestion {
  id: string;
  label: string;
  prompt: string;
}

/** Fallback suggestions for when the LLM personalizer is unavailable. */
export function deriveSuggestions(_soulLoader: Pick<SoulLoader, "resources">): Suggestion[] {
  return ONBOARDING_FALLBACK;
}
