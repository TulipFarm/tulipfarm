import { apiGet, apiWrite } from "./api";

/*
 * Read-only client for the onboarding suggestion layer (ONBOARDING ONB-V1-002/003). The API
 * derives an adaptive chip set from the current soul state; the chat landing surface renders
 * them.
 */

export type Suggestion = { id: string; label: string; prompt: string };

export async function listOnboardingSuggestions(): Promise<Suggestion[]> {
  const body = await apiGet<{ suggestions: Suggestion[] }>("/api/v1/onboarding/suggestions");
  return body.suggestions;
}

/*
 * Steps are the core build blocks with status auto-derived server-side from real soul/knowledge
 * state; recommendations are the deterministic "next" items.
 */

export type ChecklistStatus = "done" | "todo" | "coming-soon";
export type ChecklistStep = { id: string; label: string; status: ChecklistStatus; prompt?: string };
export type ChecklistRecommendation = { id: string; label: string; prompt: string };
export type OnboardingChecklist = {
  dismissed: boolean;
  businessName?: string;
  steps: ChecklistStep[];
  recommendations: ChecklistRecommendation[];
};

export async function getOnboardingChecklist(): Promise<OnboardingChecklist> {
  return apiGet<OnboardingChecklist>("/api/v1/onboarding/checklist");
}

export async function dismissOnboardingChecklist(): Promise<void> {
  await apiWrite("PUT", "/api/v1/kv/onboarding/checklist", { value: { dismissed: true } });
}

/*
 * The Companion's quest ladder (ONB-V2): tier 1 (hardcoded gate), tier 2 (checklist), tier 3
 * (AI profile gaps). `answer` only accepts tier-1 form quests; tier 2/3 route through chat.
 */

export type QuestAction =
  | { kind: "form"; field: "name" | "description" }
  | { kind: "link"; href: string }
  | { kind: "chat"; prompt: string };

export type Quest = {
  id: string;
  tier: 1 | 2 | 3;
  label: string;
  hint?: string;
  action: QuestAction;
};

export async function listQuests(): Promise<Quest[]> {
  const body = await apiGet<{ quests: Quest[] }>("/api/v1/onboarding/quests");
  return body.quests;
}

export async function answerQuest(id: string, value: string): Promise<void> {
  await apiWrite("POST", `/api/v1/onboarding/quests/${encodeURIComponent(id)}/answer`, { value });
}

export async function dismissQuest(id: string): Promise<void> {
  await apiWrite("POST", `/api/v1/onboarding/quests/${encodeURIComponent(id)}/dismiss`, {});
}
