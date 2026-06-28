// Best-effort model price map for cost accounting (observability). Prices are USD per **million**
// tokens, split input/output, and are a starting point only — they drift and are not authoritative.
// Cost is computed and frozen at write time so historical spend stays stable across price changes;
// an unknown model resolves to `null` (surfaced as "unpriced" rather than a wrong number). Admins
// override/extend this map via config. Figures approximate as of 2026-06; verify against billing.

export interface ModelPrice {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

// Keyed by canonical model id (or family prefix — see `priceFor`'s prefix fallback, which lets a
// dated provider id like `claude-opus-4-20250901` match the `claude-opus-4` family entry).
export const PRICING: Record<string, ModelPrice> = {
  // Anthropic (TulipFarm tier defaults)
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-opus-4": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 0.8, out: 4 },
  "claude-haiku-4": { in: 0.8, out: 4 },
  // OpenAI
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  o3: { in: 2, out: 8 },
  "o3-mini": { in: 1.1, out: 4.4 },
  // Google
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  // xAI
  "grok-4": { in: 3, out: 15 },
};

export interface PriceResult {
  /** Frozen USD cost, or `null` when the model id is not in the price map (unpriced). */
  costUsd: number | null;
}

// Resolve a price entry for a model id within a given map: exact match first, then a normalized
// (lowercased) match, then the longest family-prefix key the id extends (so dated/suffixed provider
// ids — e.g. `claude-3-5-sonnet-20241022` → `claude-3-5-sonnet` — still price).
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

/**
 * Compute the frozen USD cost of one model call from its token counts. `extra` (external/LiteLLM
 * prices merged with config overrides) takes precedence over the built-in map; both are matched
 * prefix-tolerantly. Returns `{ costUsd: null }` when the model is unpriced. Rounded to 6 decimals
 * to avoid floating-point dust in the numeric column while keeping sub-cent calls meaningful.
 */
export function priceFor(
  modelId: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
  extra?: Record<string, ModelPrice>
): PriceResult {
  if (!modelId) return { costUsd: null };
  const price = (extra && lookupIn(modelId, extra)) ?? lookupIn(modelId, PRICING);
  if (!price) return { costUsd: null };
  const raw = (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
  return { costUsd: Math.round(raw * 1_000_000) / 1_000_000 };
}
