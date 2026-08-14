import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ProviderEntry } from "@tulipfarm/schema";
import { LlmConfigValidationError, LlmCredentialError } from "@tulipfarm/schema";
import {
  DecryptError,
  llmProviderById,
  providerField,
  type SecretsService,
  SecretUnavailableError,
} from "@tulipfarm/secrets";
import { ClaudeCodeModel } from "./cli/claude-code";
import { CodexModel } from "./cli/codex";
import { ClassifiedLanguageModel } from "./provider-error";

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
    // Undecryptable stored credentials skip this provider at init; use surfaces the broken tier.
    if (err instanceof DecryptError) {
      throw new LlmCredentialError(
        `LLM credential "${api_key_ref}" could not be decrypted — the encryption key may have ` +
          `changed since it was saved. Re-enter it (PUT /secrets/${api_key_ref}). (${err.message})`
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
    // Missing OR undecryptable config value → treat as not-set; the downstream provider check
    // (e.g. "azure requires resource_name or base_url") then skips the provider gracefully.
    if (err instanceof SecretUnavailableError || err instanceof DecryptError) return undefined;
    throw err;
  }
}

/** Per-call knobs a caller can impose on the built model. */
export interface CreateModelOptions {
  /** Wall clock for one model call; `/setup` passes a short probe timeout. */
  timeoutMs?: number;
}

export async function createModel(
  entry: ProviderEntry,
  secrets: SecretsService,
  options: CreateModelOptions = {}
): Promise<LanguageModelV4> {
  const info = llmProviderById(entry.provider);

  // API key: explicit api_key_ref wins; optional keys may be unset.
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
      return new ClassifiedLanguageModel(p(entry.model));
    }
    case "openai": {
      const p = createOpenAI({ apiKey });
      return new ClassifiedLanguageModel(p(entry.model));
    }
    case "openai-compatible": {
      if (!baseUrl) {
        throw new LlmConfigValidationError("openai-compatible provider requires base_url");
      }
      const p = createOpenAICompatible({ baseURL: baseUrl, name: "openai-compatible", apiKey });
      return new ClassifiedLanguageModel(p(entry.model));
    }
    case "azure": {
      if (!resourceName && !baseUrl) {
        throw new LlmConfigValidationError("azure provider requires resource_name or base_url");
      }
      const p = createAzure({ resourceName, baseURL: baseUrl, apiKey });
      return new ClassifiedLanguageModel(p(entry.model));
    }
    case "claude-code": {
      // Subscription Provider errors are already plain Error/LlmProviderError.
      return new ClaudeCodeModel(entry.model, apiKey, options.timeoutMs);
    }
    case "codex": {
      // `apiKey` is Codex `auth.json`; write back to the same field before deleting the jail.
      const key = entry.api_key_ref ?? apiKeyField?.key;
      const persist =
        key && !key.startsWith("env://")
          ? async (authJson: string) => {
              await secrets.set(key, authJson);
            }
          : undefined;
      return new CodexModel(entry.model, apiKey, options.timeoutMs, persist);
    }
    default:
      throw new LlmConfigValidationError(`unknown provider: ${entry.provider}`);
  }
}
