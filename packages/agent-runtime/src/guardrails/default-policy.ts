import type { GuardrailsConfig } from "@tulipfarm/schema";

/**
 * Fallback policy used when no `soul/guardrails.yaml` is present or when a
 * configured policy fails validation. Fail-safe: the API is never left
 * unguarded. Covers all three stages with the built-in guards.
 */
export const DEFAULT_GUARDRAILS: GuardrailsConfig = {
  input: [{ guard: "prompt_injection", sensitivity: "medium" }],
  "tool-call": [{ guard: "tool_blocklist", block: ["run_command"] }],
  output: [{ guard: "content_filter", patterns: ["credit_card", "ssn", "api_key", "email"] }],
};
