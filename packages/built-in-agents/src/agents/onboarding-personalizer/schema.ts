/**
 * What the onboarding chips are, and the JSON Schema that holds the model to it.
 *
 * Plain JSON Schema rather than TypeBox: the same object is fed to AJV for post-validation and to
 * the AI SDK's `jsonSchema()` to constrain the model's structured output.
 */

/** One chip: what it is called, and the chat message it seeds. */
export interface OnboardingSuggestion {
  id: string;
  label: string;
  prompt: string;
}

/** Both onboarding surfaces in one shot. */
export interface Personalized {
  suggestions: OnboardingSuggestion[];
  recommendations: OnboardingSuggestion[];
}

/** What the Soul already holds, by name, sorted. Doubles as the caller's cache key input. */
export interface OnboardingSoulState {
  resources: string[];
  agents: string[];
  skills: string[];
}

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "prompt"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    prompt: { type: "string" },
  },
} as const;

export const PERSONALIZED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions", "recommendations"],
  properties: {
    suggestions: { type: "array", items: ITEM_SCHEMA },
    recommendations: { type: "array", items: ITEM_SCHEMA },
  },
} as const;
