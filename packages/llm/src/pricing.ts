// Best-effort USD-per-million-token prices for observability. Costs freeze at write time; unknown
// models stay `null`, and admins can override this drifting map.

export interface ModelPrice {
  /** USD per 1M input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
}

// Keys are canonical ids or family prefixes used by `priceFor`.
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

export interface PriceResult {
  /** Frozen USD cost, or `null` when the model id is not in the price map (unpriced). */
  costUsd: number | null;
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

/** External/config prices win; unpriced models return `null`, costs round to 6 decimals. */
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
