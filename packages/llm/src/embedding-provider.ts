import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingProviderEntry } from "@tulipfarm/schema";
import { LlmConfigValidationError } from "@tulipfarm/schema";
import { llmProviderById, providerField, type SecretsService } from "@tulipfarm/secrets";
import type { EmbeddingModel } from "ai";
import { resolveApiKey, resolveStored } from "./provider";

/**
 * Build a text-embedding model from one config entry. Mirrors `createModel`
 * (provider.ts) — same credential resolution, same provider-switch shape.
 *
 * Config fields fall back to the registry-keyed stored connection the same way `createModel`
 * does: an entry that sets nothing still resolves through whatever the operator saved via
 * Providers & credentials, rather than requiring a second, entry-local copy of the same value.
 *
 * These required-field checks are the only guard: `validateLlmConfig` allows an entry with
 * neither field set (same as a chat entry), trusting the stored connection to cover it, so this
 * must still fail loud here rather than hand the AI SDK an unbuildable client.
 */
export async function createEmbeddingModel(
  entry: EmbeddingProviderEntry,
  secrets: SecretsService
): Promise<EmbeddingModel> {
  const info = llmProviderById(entry.provider);

  const apiKeyField = info ? providerField(info, "api_key") : undefined;
  const apiKey = entry.api_key_ref
    ? await resolveApiKey(entry.api_key_ref, secrets)
    : apiKeyField
      ? apiKeyField.optional
        ? await resolveStored(apiKeyField.key, secrets)
        : await resolveApiKey(apiKeyField.key, secrets)
      : undefined;

  const resourceName =
    entry.resource_name ??
    (info ? await resolveStored(providerField(info, "resource_name")?.key, secrets) : undefined);
  const baseUrl =
    entry.base_url ??
    (info ? await resolveStored(providerField(info, "base_url")?.key, secrets) : undefined);

  switch (entry.provider) {
    case "openai": {
      const p = createOpenAI({ apiKey });
      return p.textEmbeddingModel(entry.model);
    }
    case "azure": {
      if (!resourceName && !baseUrl) {
        throw new LlmConfigValidationError("azure provider requires resource_name or base_url");
      }
      const p = createAzure({
        resourceName,
        baseURL: baseUrl,
        apiKey,
      });
      return p.textEmbeddingModel(entry.model);
    }
    case "openai-compatible": {
      if (!baseUrl) {
        throw new LlmConfigValidationError("openai-compatible provider requires base_url");
      }
      const p = createOpenAICompatible({
        baseURL: baseUrl,
        name: "openai-compatible",
        apiKey,
      });
      return p.textEmbeddingModel(entry.model);
    }
    case "ollama": {
      if (!baseUrl) {
        throw new LlmConfigValidationError("ollama provider requires base_url");
      }
      const p = createOpenAICompatible({
        baseURL: baseUrl,
        name: "ollama",
        // Ollama needs no key; a placeholder keeps the SDK from erroring.
        apiKey: apiKey ?? "ollama",
      });
      return p.textEmbeddingModel(entry.model);
    }
    default:
      throw new LlmConfigValidationError(`unknown embedding provider: ${entry.provider}`);
  }
}
