import type { LlmProviderInfo, ModelSpec, ProviderEntry } from "~/lib/settings";

export type Row = ProviderEntry & { uid: number };

export function providerLabel(providers: LlmProviderInfo[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id;
}

const perMtok = (n?: number): string => (n != null ? `$${(n * 1_000_000).toFixed(2)}` : "—");

export function specFacts(spec: ModelSpec | undefined): string[] {
  if (!spec) return [];
  const facts: string[] = [];
  if (spec.input_cost_per_token != null || spec.output_cost_per_token != null) {
    facts.push(
      `${perMtok(spec.input_cost_per_token)}/${perMtok(spec.output_cost_per_token)} per Mtok`
    );
  }
  if (spec.max_input_tokens) facts.push(`${Math.round(spec.max_input_tokens / 1000)}k context`);
  if (spec.supports_function_calling) facts.push("tools");
  if (spec.supports_vision) facts.push("vision");
  return facts;
}
