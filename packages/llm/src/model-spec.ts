import type { ModelSpec } from "@tulipfarm/schema";

export type { ModelSpec };

/**
 * Config-time model-spec resolution from LiteLLM's community-maintained
 * `model_prices_and_context_window.json` — the de-facto pricing/capability DB across the LLM tooling
 * ecosystem. Resolved once when a model is added/refreshed in Settings and pinned into the soul's
 * llm.config (deterministic + git-audited), rather than fetched per request.
 */

// Canonical location is the repo ROOT (the `litellm/<file>` path 404s).
const LITELLM_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Raw LiteLLM catalog: model key → entry (we read a curated subset of fields). */
export type LiteLlmCatalog = Record<string, Record<string, unknown>>;

/**
 * TulipFarm provider → candidate LiteLLM key prefixes (LiteLLM keys look like `azure_ai/kimi-k2.5`,
 * `xai/grok-4`, `anthropic/claude-...`, or bare `gpt-4o`). `""` means "try the bare model id".
 * Order = match priority. `openai-compatible` can be anything, so we also fall back to a suffix search.
 */
const PROVIDER_PREFIXES: Record<string, string[]> = {
  anthropic: ["", "anthropic/"],
  openai: ["", "openai/"],
  azure: ["azure_ai/", "azure/", ""],
  "openai-compatible": [""],
};

/** Fetch the LiteLLM catalog. Best-effort: network/parse failure resolves to `null` (caller degrades). */
export async function fetchLiteLlmCatalog(opts?: {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LiteLlmCatalog | null> {
  const url = opts?.url ?? LITELLM_CATALOG_URL;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 6000);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== "object") return null;
    return data as LiteLlmCatalog;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Curate a LiteLLM entry into our pinned ModelSpec (chat models only). */
function curate(key: string, entry: Record<string, unknown>, fetchedAt: string): ModelSpec {
  return {
    litellm_key: key,
    input_cost_per_token: num(entry.input_cost_per_token),
    output_cost_per_token: num(entry.output_cost_per_token),
    cache_read_input_token_cost: num(entry.cache_read_input_token_cost),
    cache_creation_input_token_cost: num(entry.cache_creation_input_token_cost),
    max_input_tokens: num(entry.max_input_tokens),
    max_output_tokens: num(entry.max_output_tokens),
    mode: str(entry.mode),
    supports_function_calling: bool(entry.supports_function_calling),
    supports_vision: bool(entry.supports_vision),
    supports_prompt_caching: bool(entry.supports_prompt_caching),
    supports_reasoning: bool(entry.supports_reasoning),
    deprecation_date: str(entry.deprecation_date) ?? null,
    fetched_at: fetchedAt,
  };
}

export interface SpecResolution {
  /** The curated spec, or null when no confident match was found. */
  spec: ModelSpec | null;
  /** The LiteLLM key that matched (null if unmatched). */
  matchedKey: string | null;
  /** Other plausible keys (suffix matches) for the admin to pick from when unmatched/ambiguous. */
  candidates: string[];
}

/** Resolve an explicit LiteLLM candidate selected by an administrator. */
export function resolveModelSpecCandidate(
  key: string,
  catalog: LiteLlmCatalog,
  fetchedAt: string
): SpecResolution {
  const entry = catalog[key];
  if (!entry) return { spec: null, matchedKey: null, candidates: [] };
  const spec = curate(key, entry, fetchedAt);
  if (typeof spec.max_input_tokens !== "number" || spec.max_input_tokens <= 0) {
    return { spec: null, matchedKey: null, candidates: [] };
  }
  return { spec, matchedKey: key, candidates: [] };
}

/**
 * Resolve a TulipFarm (provider, model[, base_url]) to a pinned ModelSpec from the LiteLLM catalog.
 * Tries provider-prefixed + bare keys (exact, then case-insensitive), then a suffix search across the
 * catalog. Returns the best match plus alternative candidates so the UI can confirm/override.
 */
export function resolveModelSpec(
  provider: string,
  model: string,
  catalog: LiteLlmCatalog,
  fetchedAt: string
): SpecResolution {
  const prefixes = PROVIDER_PREFIXES[provider] ?? [""];
  // Exclude LiteLLM's `sample_spec` documentation placeholder from all matching.
  const keys = Object.keys(catalog).filter((k) => k !== "sample_spec");
  const lowerIndex = new Map(keys.map((k) => [k.toLowerCase(), k]));

  // A confident match must carry pricing — a cost-less entry (embedding/image/non-chat model) would
  // pin a misleading "—/— per Mtok" spec, so we route those to candidates instead.
  const confident = (key: string): SpecResolution | null => {
    const spec = curate(key, catalog[key], fetchedAt);
    if (typeof spec.input_cost_per_token !== "number") return null;
    return { spec, matchedKey: key, candidates: [] };
  };

  // 1. Exact / case-insensitive match on each candidate `${prefix}${model}`.
  for (const prefix of prefixes) {
    const candidate = `${prefix}${model}`;
    const hit = catalog[candidate] ? candidate : lowerIndex.get(candidate.toLowerCase());
    const m = hit && hit !== "sample_spec" ? confident(hit) : null;
    if (m) return m;
  }

  // 2. Suffix search: any catalog key whose bare id (after the last `/`) equals the model.
  const m = model.toLowerCase();
  const suffixMatches = keys.filter((k) => k.slice(k.lastIndexOf("/") + 1).toLowerCase() === m);
  if (suffixMatches.length === 1) {
    const hit = confident(suffixMatches[0]);
    if (hit) return hit;
  }
  if (suffixMatches.length >= 1) {
    return { spec: null, matchedKey: null, candidates: suffixMatches.slice(0, 10) };
  }

  // 3. Loose: keys that contain the model as a substring (helps near-misses); offered as candidates.
  const loose = keys.filter((k) => k.toLowerCase().includes(m)).slice(0, 10);
  return { spec: null, matchedKey: null, candidates: loose };
}

/**
 * Bare, chat-capable model ids for a provider, derived from the catalog — used to populate the model
 * picker's suggestions in Settings. Strips the provider prefix (so `anthropic/claude-x` → `claude-x`),
 * keeps only entries that look like chat models (priced, `mode` chat/unset), dedupes and sorts.
 */
export function litellmModelsForProvider(provider: string, catalog: LiteLlmCatalog): string[] {
  const prefixes = PROVIDER_PREFIXES[provider] ?? [""];
  const out = new Set<string>();
  for (const key of Object.keys(catalog)) {
    if (key === "sample_spec") continue;
    const entry = catalog[key];
    if (typeof entry?.input_cost_per_token !== "number") continue; // skip cost-less / non-chat
    const mode = typeof entry.mode === "string" ? entry.mode : undefined;
    if (mode && mode !== "chat") continue; // embeddings/image/rerank etc. aren't tier models
    for (const prefix of prefixes) {
      if (prefix === "") {
        if (!key.includes("/")) out.add(key); // bare ids only, for the "" prefix
      } else if (key.startsWith(prefix)) {
        out.add(key.slice(prefix.length));
      }
    }
  }
  return [...out].sort();
}
