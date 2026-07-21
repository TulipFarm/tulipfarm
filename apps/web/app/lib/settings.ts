import { apiDelete, apiGet, apiWrite } from "./api";

/*
 * Client for the Settings section (UI-V1-003). Two independent areas:
 *  - LLM config: read/replace soul.yaml's `llm` tiers (structured, via the LLM config form).
 *  - Secrets: list keys (never values) + admin add/update/delete (existing SECRETS backend).
 * Dark mode is handled entirely client-side by ThemeToggle in the sidebar and is not part of this.
 */

// --- LLM config (mirrors @tulipfarm/llm LlmConfig; embeddings is read/preserved but not UI-editable) ---

// Pinned model spec (pricing/context/capabilities), resolved from LiteLLM at config time. Mirrors
// @tulipfarm/llm ModelSpec. Costs are USD per token.
export type ModelSpec = {
  litellm_key?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  mode?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_prompt_caching?: boolean;
  supports_reasoning?: boolean;
  deprecation_date?: string | null;
  fetched_at?: string;
};

export type ProviderEntry = {
  provider: string;
  model: string;
  api_key_ref?: string;
  base_url?: string;
  resource_name?: string;
  spec?: ModelSpec;
};

export type SpecResolution = {
  spec: ModelSpec | null;
  matchedKey: string | null;
  candidates: string[];
};

/** Resolve a model's spec from LiteLLM (admin) so it can be pinned into the config. `refresh` forces
 *  a re-fetch of the catalog past the server's cache. */
export async function resolveModelSpec(
  provider: string,
  model: string,
  refresh = false
): Promise<SpecResolution> {
  const q = new URLSearchParams({ provider, model });
  if (refresh) q.set("refresh", "true");
  return apiGet<SpecResolution>(`/api/v1/llm-config/resolve-spec?${q.toString()}`);
}

// Suggested model ids for a provider, to populate the model picker. `source: "live"` (openai-compatible
// only) lists the configured proxy's actually-deployed models; `source: "catalog"` falls back to the
// LiteLLM catalog; `source: "unavailable"` (+ reason) means neither was reachable and the picker
// degrades to free-text entry. Azure is intentionally not listed here (deployment names can't be
// reliably discovered) — its model field is free-text.
export type ModelOptions = {
  models: string[];
  source: "catalog" | "live" | "unavailable";
  reason?: string;
};

export async function getModelOptions(provider: string): Promise<ModelOptions> {
  const q = new URLSearchParams({ provider });
  return apiGet<ModelOptions>(`/api/v1/llm-config/model-options?${q.toString()}`);
}

// Provider registry (served from @tulipfarm/secrets via GET /api/v1/llm-providers). Each provider
// declares the full set of fields it needs — some secret (API keys), some plain config (resource
// name, base URL). The Secrets tab renders all of a provider's fields; the LLM form enables a
// provider once every non-optional field is stored. Values all live in the secrets store.
export type ProviderField = {
  key: string;
  label: string;
  role: "api_key" | "resource_name" | "base_url";
  kind: "secret" | "config";
  optional?: boolean;
  placeholder?: string;
};

export type LlmProviderInfo = {
  id: string;
  label: string;
  fields: ProviderField[];
};

// A provider is usable once every non-optional field has a stored value.
export function isProviderConfigured(p: LlmProviderInfo, storedKeys: string[]): boolean {
  return p.fields.filter((f) => !f.optional).every((f) => storedKeys.includes(f.key));
}

export async function listProviders(): Promise<LlmProviderInfo[]> {
  const body = await apiGet<{ providers: LlmProviderInfo[] }>("/api/v1/llm-providers");
  return body.providers;
}

// Stored values of CONFIG fields only (resource_name, base_url) so the Secrets UI can show them back.
// Secret-field (API key) values are never returned by the API.
export async function getProviderConfig(): Promise<Record<string, string>> {
  const body = await apiGet<{ values: Record<string, string> }>("/api/v1/provider-config");
  return body.values;
}

export type TierConfig = { providers: ProviderEntry[] };

export type LlmConfig = {
  tiers: { quick: TierConfig; standard: TierConfig; complex: TierConfig };
  embeddings?: { providers: ProviderEntry[] };
};

export async function getLlmConfig(): Promise<LlmConfig> {
  return apiGet<LlmConfig>("/api/v1/llm-config");
}

// Full-replace: the structured form sends the entire config back. The server validates before
// writing, so a structurally invalid config is rejected (422) with the running config untouched.
export async function putLlmConfig(config: LlmConfig): Promise<LlmConfig> {
  return apiWrite<LlmConfig>("PUT", "/api/v1/llm-config", config);
}

// --- Secrets (existing backend; values are never returned) ---

export type SecretMeta = {
  key: string;
  type: "user-provided" | "auto-generated";
  createdAt: string;
  updatedAt: string;
};

export async function listSecrets(): Promise<SecretMeta[]> {
  const body = await apiGet<{ secrets: SecretMeta[] }>("/api/v1/secrets/status");
  return body.secrets;
}

export async function putSecret(key: string, value: string): Promise<void> {
  await apiWrite<{ key: string }>("PUT", `/api/v1/secrets/${encodeURIComponent(key)}`, { value });
}

export async function deleteSecret(key: string): Promise<void> {
  await apiDelete(`/api/v1/secrets/${encodeURIComponent(key)}`);
}
