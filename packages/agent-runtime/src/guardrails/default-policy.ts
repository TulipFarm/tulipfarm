import type { GuardrailsConfig } from "@tulipfarm/schema";

/** Fail-safe fallback when no valid guardrails config exists. */
export const DEFAULT_GUARDRAILS: GuardrailsConfig = {
  input: [{ guard: "prompt_injection", sensitivity: "medium" }],
  "tool-call": [{ guard: "tool_blocklist", block: ["run_command"] }],
  output: [{ guard: "content_filter", patterns: ["credit_card", "ssn", "api_key", "email"] }],
};
