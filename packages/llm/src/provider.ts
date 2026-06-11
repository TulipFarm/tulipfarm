import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  llmProviderById,
  providerField,
  type SecretsService,
  SecretUnavailableError,
} from "@tulipfarm/secrets";
import type { ProviderEntry } from "./config";
import { LlmConfigValidationError, LlmCredentialError } from "./config";

export async function resolveApiKey(
  api_key_ref: string | undefined,
  secrets: SecretsService
): Promise<string | undefined> {
  if (!api_key_ref) return undefined;
  if (api_key_ref.startsWith("env://")) {
    const varName = api_key_ref.slice(6);
    const value = process.env[varName];
    if (!value) throw new LlmConfigValidationError(`env var ${varName} not set`);
    return value;
  }
  try {
    return await secrets.get(api_key_ref);
  } catch (err) {
    if (err instanceof SecretUnavailableError) {
      throw new LlmCredentialError(
        `LLM credential "${api_key_ref}" unavailable — set it (PUT /secrets/${api_key_ref}) ` +
          `or use api_key_ref: env://VAR. (${err.message})`
      );
    }
    throw err;
  }
}

// Reads a registry config field's stored value. Unlike an API key, a missing config value is normal
// (optional / not-yet-set) rather than an error, so SecretUnavailableError maps to undefined.
async function resolveStored(
  key: string | undefined,
  secrets: SecretsService
): Promise<string | undefined> {
  if (!key) return undefined;
  try {
    return await secrets.get(key);
  } catch (err) {
    if (err instanceof SecretUnavailableError) return undefined;
    throw err;
  }
}

export async function createModel(
  entry: ProviderEntry,
  secrets: SecretsService
): Promise<LanguageModelV3> {
  const info = llmProviderById(entry.provider);

  // API key: an explicit api_key_ref (incl. env://VAR escape) wins; otherwise the provider's
  // registry secret field. An optional key (e.g. local openai-compatible) may legitimately be unset.
  const apiKeyField = info ? providerField(info, "api_key") : undefined;
  let apiKey: string | undefined;
  if (entry.api_key_ref) {
    apiKey = await resolveApiKey(entry.api_key_ref, secrets);
  } else if (apiKeyField) {
    apiKey = apiKeyField.optional
      ? await resolveStored(apiKeyField.key, secrets)
      : await resolveApiKey(apiKeyField.key, secrets);
  }

  // Config fields: an explicit entry value overrides; else the registry-keyed stored value.
  const resourceName =
    entry.resource_name ??
    (info ? await resolveStored(providerField(info, "resource_name")?.key, secrets) : undefined);
  const baseUrl =
    entry.base_url ??
    (info ? await resolveStored(providerField(info, "base_url")?.key, secrets) : undefined);

  switch (entry.provider) {
    case "anthropic": {
      const p = createAnthropic({ apiKey });
      return p(entry.model);
    }
    case "openai": {
      const p = createOpenAI({ apiKey });
      return p(entry.model);
    }
    case "openai-compatible": {
      if (!baseUrl) {
        throw new LlmConfigValidationError("openai-compatible provider requires base_url");
      }
      const p = createOpenAICompatible({ baseURL: baseUrl, name: "openai-compatible", apiKey });
      return p(entry.model);
    }
    case "azure": {
      if (!resourceName && !baseUrl) {
        throw new LlmConfigValidationError("azure provider requires resource_name or base_url");
      }
      const p = createAzure({ resourceName, baseURL: baseUrl, apiKey });
      return p(entry.model);
    }
    default:
      throw new LlmConfigValidationError(`unknown provider: ${entry.provider}`);
  }
}
