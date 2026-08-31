import {
  type EmbeddingEntry,
  isProviderConfigured,
  type LlmProviderInfo,
  type ModelSpec,
  type ProviderEntry,
} from "~/lib/settings";

export type Row = ProviderEntry & { uid: number };
export type EmbeddingRow = EmbeddingEntry & { uid: number };

/** Retired wire tier names map to effort presets only here. */
export const EFFORTS = [
  {
    wire: "quick",
    preset: "fast",
    label: "Fast",
    description: "Short answers, less depth.",
  },
  {
    wire: "standard",
    preset: "balanced",
    label: "Balanced",
    description: "Most turns run here.",
  },
  {
    wire: "complex",
    preset: "thorough",
    label: "Thorough",
    description: "Slower, for harder work.",
  },
] as const;

export type WireTier = (typeof EFFORTS)[number]["wire"];
export type EffortKey = (typeof EFFORTS)[number]["preset"];
export type PresetKey = "default" | EffortKey;

export const PRESET_KEYS: readonly PresetKey[] = ["default", "fast", "balanced", "thorough"];

export function profileIdFor(preset: string, index: number): string {
  return index === 0 ? preset : `${preset}-fallback-${index}`;
}

/**
 * Whether the provider an entry points at has every credential it needs stored.
 *
 * An entry naming a provider that is gone reads the same as one whose key was never saved: not
 * ready. Callers pass the raw entry provider id, which may be absent on an empty row.
 */
export function isEntryReady(
  providers: LlmProviderInfo[],
  secretKeys: string[],
  providerId: string | undefined
): boolean {
  const info = providers.find((p) => p.id === providerId);
  return info ? isProviderConfigured(info, secretKeys) : false;
}

export function providerLabel(providers: LlmProviderInfo[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id;
}

/** A labelled read-only fact, so a number on screen always says what it measures. */
export type SpecFact = { term: string; value: string };

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

/** A per-token cost as the per-million-token price an operator is actually quoted. */
export function perMtok(cost: number): string {
  const dollars = cost * 1_000_000;
  // A sub-cent rate rounds to $0.00 at two places and then reads as free, which is the one thing
  // it is not — and sub-cent is exactly how embedding models are priced.
  return `$${dollars > 0 && dollars < 0.01 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
}

/** The facts an operator is choosing between, each one named. */
export function specFacts(spec: ModelSpec | undefined): SpecFact[] {
  if (!spec) return [];
  const facts: SpecFact[] = [];
  if (spec.max_input_tokens) {
    facts.push({ term: "Context", value: `${formatTokens(spec.max_input_tokens)} tokens` });
  }
  if (spec.max_output_tokens) {
    facts.push({ term: "Max output", value: `${formatTokens(spec.max_output_tokens)} tokens` });
  }
  if (spec.input_cost_per_token != null) {
    facts.push({ term: "Input", value: `${perMtok(spec.input_cost_per_token)}/Mtok` });
  }
  if (spec.output_cost_per_token != null) {
    facts.push({ term: "Output", value: `${perMtok(spec.output_cost_per_token)}/Mtok` });
  }
  return facts;
}

/** What the model can take in or do, as short labels. An absent flag stays absent, never "no". */
export function capabilityLabels(spec: ModelSpec | undefined): string[] {
  if (!spec) return [];
  const labels: string[] = [];
  if (spec.supports_function_calling) labels.push("Tools");
  if (spec.supports_vision) labels.push("Images");
  if (spec.supports_pdf_input) labels.push("Documents");
  if (spec.supports_reasoning) labels.push("Reasoning");
  if (spec.supports_prompt_caching) labels.push("Prompt caching");
  return labels;
}
