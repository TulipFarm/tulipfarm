import { apiGet } from "./api";

/*
 * Read-only client for the onboarding suggestion layer (ONBOARDING ONB-V1-002/003). The API
 * derives an adaptive chip set from the current soul state; the chat composer renders them as
 * suggested-prompt chips.
 */

export type Suggestion = { id: string; label: string; prompt: string };

export async function listOnboardingSuggestions(): Promise<Suggestion[]> {
  const body = await apiGet<{ suggestions: Suggestion[] }>("/api/v1/onboarding/suggestions");
  return body.suggestions;
}
