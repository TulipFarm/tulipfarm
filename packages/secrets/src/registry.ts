/*
 * Registry of LLM providers the instance supports. Each provider declares the FULL set of inputs it
 * needs — some secret (API keys), some plain config (Azure resource_name, custom base_url). This is
 * the single source of truth: the Settings UI configures a provider in one place by rendering its
 * fields, every value is stored in the secrets store keyed by the field's `key`, and the LLM layer
 * resolves a provider's credentials/config from the store via this registry (so a soul.yaml `llm`
 * row is just { provider, model }). Lives in @tulipfarm/secrets; consumed by @tulipfarm/llm and the web app
 * (over HTTP). Grows as new providers/integrations are added.
 */

export type LlmProviderId =
  | "anthropic"
  | "openai"
  | "azure"
  | "openai-compatible"
  | "claude-code"
  | "codex";

/** Semantic role of a field, so the LLM layer can resolve it without hard-coding key strings. */
export type ProviderFieldRole = "api_key" | "resource_name" | "base_url";

export type ProviderField = {
  /** Canonical store key the value is saved under (e.g. "azure-openai-resource-name"). */
  key: string;
  label: string;
  role: ProviderFieldRole;
  /** secret → encrypted + never shown; config → plain instance config (still stored in the KV). */
  kind: "secret" | "config";
  /** Optional fields don't gate "configured" (e.g. an openai-compatible endpoint may need no key). */
  optional?: boolean;
  placeholder?: string;
  /** Shown under the field (e.g. how to obtain the value) when the field isn't already stored. */
  hint?: string;
};

export type LlmProviderInfo = {
  id: LlmProviderId;
  label: string;
  fields: ProviderField[];
};

export const LLM_PROVIDERS: readonly LlmProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    fields: [{ key: "anthropic-api-key", label: "API key", role: "api_key", kind: "secret" }],
  },
  {
    id: "openai",
    label: "OpenAI",
    fields: [{ key: "openai-api-key", label: "API key", role: "api_key", kind: "secret" }],
  },
  {
    // id stays "azure" (renaming it breaks existing soul.yaml `llm` `provider: azure` rows and
    // the `case "azure"` provider switch); only the display label moves to "Azure Foundry". The two
    // stored keys keep their `azure-openai-*` names so existing secrets aren't orphaned.
    id: "azure",
    label: "Azure Foundry",
    fields: [
      { key: "azure-openai-api-key", label: "API key", role: "api_key", kind: "secret" },
      {
        key: "azure-openai-resource-name",
        label: "Resource name",
        role: "resource_name",
        kind: "config",
        placeholder: "my-resource",
      },
      {
        // Optional override for the Azure AI Foundry inference host. When set it flows through as
        // `base_url` to createAzure (which appends `/v1{path}`); when blank we fall back to the
        // resource name → https://{name}.openai.azure.com/openai/v1. New key ⇒ no orphan risk.
        key: "azure-foundry-endpoint",
        label: "Endpoint",
        role: "base_url",
        kind: "config",
        optional: true,
        placeholder: "https://my-resource.services.ai.azure.com/openai",
      },
    ],
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    fields: [
      {
        key: "openai-compatible-api-key",
        label: "API key",
        role: "api_key",
        kind: "secret",
        optional: true,
      },
      {
        key: "openai-compatible-base-url",
        label: "Base URL",
        role: "base_url",
        kind: "config",
        placeholder: "http://localhost:11434/v1",
      },
    ],
  },
  {
    // Runs the Claude Code CLI as the model, authenticated with a portable token minted from a
    // Claude Pro/Max subscription (`claude setup-token`, read via CLAUDE_CODE_OAUTH_TOKEN) instead
    // of an API key — lets a user with no API budget run TulipFarm. See
    // docs/plans/cli-agent-providers.md. Reuses role: "api_key" so Settings, /setup, and the
    // delete-key-prunes-config cascade all work unchanged.
    id: "claude-code",
    label: "Claude Code (subscription)",
    fields: [
      {
        key: "claude-code-oauth-token",
        label: "OAuth token",
        role: "api_key",
        kind: "secret",
        placeholder: "sk-ant-oat01-…",
        hint: "Run `claude setup-token` in a terminal (requires a Claude Pro/Max subscription), then paste the printed token here.",
      },
    ],
  },
  {
    // Runs the Codex CLI as the model on a ChatGPT Plus/Pro/Business plan. Unlike every other
    // provider the credential is a *file*, not a token: `codex login` writes ~/.codex/auth.json and
    // the CLI reads it back from $CODEX_HOME, so the whole blob is stored as one secret and
    // materialised into the per-turn jail. Subscription-only on purpose — an API-key blob is
    // rejected on save, because accepting it would bill the operator's OpenAI account for turns
    // TulipFarm reports as unpriced. Reuses role: "api_key" so Settings, /setup, and the
    // delete-key-prunes-config cascade all work unchanged.
    id: "codex",
    label: "Codex (subscription)",
    fields: [
      {
        key: "codex-auth-json",
        label: "auth.json",
        role: "api_key",
        kind: "secret",
        placeholder: '{"tokens":{"refresh_token":"…"}}',
        hint: "Run `codex login` in a terminal (requires a ChatGPT Plus/Pro/Business plan), then paste the entire contents of ~/.codex/auth.json here.",
      },
    ],
  },
];

export function llmProviderById(id: string): LlmProviderInfo | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/** The provider that owns a given store key (for labelling a stored secret/config in the UI). */
export function llmProviderForFieldKey(key: string): LlmProviderInfo | undefined {
  return LLM_PROVIDERS.find((p) => p.fields.some((f) => f.key === key));
}

export function providerField(
  info: LlmProviderInfo,
  role: ProviderFieldRole
): ProviderField | undefined {
  return info.fields.find((f) => f.role === role);
}

/** A provider is usable once every non-optional field has a stored value. */
export function isProviderConfigured(info: LlmProviderInfo, storedKeys: string[]): boolean {
  return info.fields.filter((f) => !f.optional).every((f) => storedKeys.includes(f.key));
}
