// The single pricing authority. Costs freeze at write time; an operator override wins, then the
// per-model spec pinned into git-audited LLM config, then this drifting fallback table.
//
// There is exactly one exported way to price a call (`priceCall`). Two pricing functions is how
// the operator's overrides came to reach only one of two call sites, and how a subscription seat
// came to be billed at full published API rates.

import type { ModelSpec } from "@tulipfarm/schema";
import { isSubscriptionProvider } from "./cli/specs";

export interface ModelPrice {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

// Keys are canonical ids or family prefixes used by the fallback lookup.
export const PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-opus-4": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 0.8, out: 4 },
  "claude-haiku-4": { in: 0.8, out: 4 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  o3: { in: 2, out: 8 },
  "o3-mini": { in: 1.1, out: 4.4 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "grok-4": { in: 3, out: 15 },
};

/** Where a price came from, so an operator can tell a pinned spec from the fallback table. */
export type PriceSource = "override" | "spec" | "table";

/**
 * What a call cost, and — when we cannot say — why not.
 *
 * `subscription` and `unpriced` are deliberately different. A subscription seat has a genuine zero
 * marginal cost; an unpriced call has an unknown one. Collapsing them into "no cost" is what let
 * an unpriceable model run with no cost ceiling at all.
 */
export type CostBasis =
  | { readonly kind: "priced"; readonly costUsd: number; readonly source: PriceSource }
  | { readonly kind: "subscription" }
  | { readonly kind: "unpriced" };

export interface PriceCallInput {
  /** Required: a subscription seat is identified by its provider, never by a price-map miss. */
  readonly provider: string;
  readonly modelId: string | null | undefined;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Per-token costs pinned from the LiteLLM catalog at config time, when the entry carries them. */
  readonly spec?: ModelSpec | undefined;
  /** Operator corrections for a drifted price. Must reach every caller, not just one. */
  readonly overrides?: Record<string, ModelPrice> | undefined;
}

// Price lookup: exact, lowercased, then longest family-prefix match for dated provider ids.
function lookupIn(modelId: string, map: Record<string, ModelPrice>): ModelPrice | undefined {
  if (map[modelId]) return map[modelId];
  const id = modelId.toLowerCase();
  if (map[id]) return map[id];
  let best: { key: string; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(map)) {
    const k = key.toLowerCase();
    if ((id === k || id.startsWith(`${k}-`)) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price;
}

/** LiteLLM pins USD *per token*; this table is USD per 1M tokens. Convert, never mix. */
function priceFromSpec(spec: ModelSpec | undefined): ModelPrice | undefined {
  const input = spec?.input_cost_per_token;
  const output = spec?.output_cost_per_token;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return { in: input * 1_000_000, out: output * 1_000_000 };
}

/**
 * Prices one model call.
 *
 * Authority order is override, then pinned spec, then the fallback table. The subscription check
 * runs first because a seat is not merely absent from the price map — it is genuinely unmetered,
 * and charging it published API rates fails Runs that had budget left.
 */
export function priceCall(input: PriceCallInput): CostBasis {
  if (isSubscriptionProvider(input.provider)) return { kind: "subscription" };
  if (!input.modelId) return { kind: "unpriced" };

  const candidates: readonly (readonly [ModelPrice | undefined, PriceSource])[] = [
    [input.overrides ? lookupIn(input.modelId, input.overrides) : undefined, "override"],
    [priceFromSpec(input.spec), "spec"],
    [lookupIn(input.modelId, PRICING), "table"],
  ];
  for (const [price, source] of candidates) {
    if (price === undefined) continue;
    const raw = (input.tokensIn / 1_000_000) * price.in + (input.tokensOut / 1_000_000) * price.out;
    return { kind: "priced", costUsd: Math.round(raw * 1_000_000) / 1_000_000, source };
  }
  return { kind: "unpriced" };
}

/** Whether calls against this entry can be priced at all, asked before one is made. */
export function isPriceable(input: {
  readonly provider: string;
  readonly modelId: string;
  readonly spec?: ModelSpec | undefined;
  readonly overrides?: Record<string, ModelPrice> | undefined;
}): boolean {
  // Zero tokens keeps this a pure pricability question; only the discriminant is read.
  return priceCall({ ...input, tokensIn: 0, tokensOut: 0 }).kind !== "unpriced";
}
