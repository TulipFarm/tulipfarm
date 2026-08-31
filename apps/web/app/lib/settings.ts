import { apiDelete, apiGet, apiWrite } from "./api";

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
  supports_pdf_input?: boolean;
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

/** An embedding entry also pins its vector width: failover may only cross providers of equal
 *  `dimension`, since a different width writes vectors the next query can never match. */
export type EmbeddingEntry = ProviderEntry & { dimension?: number };

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
  refresh = false,
  candidate?: string
): Promise<SpecResolution> {
  const q = new URLSearchParams({ provider, model });
  if (refresh) q.set("refresh", "true");
  if (candidate) q.set("candidate", candidate);
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

export async function getModelOptions(
  provider: string,
  mode: "chat" | "embedding" = "chat"
): Promise<ModelOptions> {
  const q = new URLSearchParams({ provider, mode });
  return apiGet<ModelOptions>(`/api/v1/llm-config/model-options?${q.toString()}`);
}

// One live round-trip against a single entry, before it is saved. `verdict: "degraded"` means the
// provider answered but refused or throttled the call — its credential and network path are fine,
// which is a different fix from `unreachable`.
export type ConnectionTest = {
  verdict: "reachable" | "degraded" | "unreachable";
  detail?: string;
  /** Chat only: what the model wrote back. */
  reply?: string;
  latencyMs?: number;
  /** Embedding only: the width of the vector it returned. */
  dimension?: number;
};

export async function testLlmConnection(
  entry: ProviderEntry,
  kind: "chat" | "embedding" = "chat"
): Promise<ConnectionTest> {
  return apiWrite<ConnectionTest>("POST", "/api/v1/llm-config/test-connection", {
    kind,
    provider: entry.provider,
    model: entry.model,
    ...(entry.api_key_ref ? { api_key_ref: entry.api_key_ref } : {}),
    ...(entry.base_url ? { base_url: entry.base_url } : {}),
    ...(entry.resource_name ? { resource_name: entry.resource_name } : {}),
  });
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
  hint?: string;
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

export type ProviderConnection = {
  provider: string;
  api_key_ref?: string;
  base_url?: string;
  resource_name?: string;
};

export type EffortPresetMappings = {
  default?: string;
  fast?: string;
  balanced?: string;
  thorough?: string;
};

export type LlmConfig = {
  connections?: Record<string, ProviderConnection>;
  tiers?: { quick: TierConfig; standard: TierConfig; complex: TierConfig };
  presets?: EffortPresetMappings;
  embeddings?: { providers: EmbeddingEntry[] };
};

export async function getLlmConfig(): Promise<LlmConfig> {
  return apiGet<LlmConfig>("/api/v1/llm-config");
}

// Full-replace: the structured form sends the entire config back. The server validates before
// writing, so a structurally invalid config is rejected (422) with the running config untouched.
export async function putLlmConfig(config: LlmConfig): Promise<LlmConfig> {
  return apiWrite<LlmConfig>("PUT", "/api/v1/llm-config", config);
}

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

/* Personal access tokens: `token` is returned exactly once, on create. */

export type ApiToken = {
  id: string;
  userId: string;
  name: string;
  // The leading characters of the raw token. The only part the server can still show, and enough
  // to tell two tokens apart when revoking one.
  prefix: string;
  createdAt: string;
};

export async function listApiTokens(): Promise<ApiToken[]> {
  return (await apiGet<{ tokens: ApiToken[]; nextCursor: string | null }>("/api/v1/auth/tokens"))
    .tokens;
}

export async function createApiToken(name: string): Promise<ApiToken & { token: string }> {
  return apiWrite<ApiToken & { token: string }>("POST", "/api/v1/auth/tokens", { name });
}

export async function revokeApiToken(id: string): Promise<void> {
  await apiDelete(`/api/v1/auth/tokens/${encodeURIComponent(id)}`);
}

/* Custom instructions are prepended to every agent turn for this user. */

export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4_000;

export async function getCustomInstructions(): Promise<string> {
  return (await apiGet<{ instructions: string }>("/api/v1/preferences/custom-instructions"))
    .instructions;
}

export async function putCustomInstructions(instructions: string): Promise<string> {
  return (
    await apiWrite<{ instructions: string }>("PUT", "/api/v1/preferences/custom-instructions", {
      instructions,
    })
  ).instructions;
}

/* Business profile writes the identity block in soul.yaml. */

export type BusinessProfile = {
  name: string;
  description: string;
  website: string;
};

export async function getBusinessProfile(): Promise<BusinessProfile> {
  return apiGet<BusinessProfile>("/api/v1/business");
}

export async function putBusinessProfile(profile: BusinessProfile): Promise<BusinessProfile> {
  return apiWrite<BusinessProfile>("PUT", "/api/v1/business", profile);
}
