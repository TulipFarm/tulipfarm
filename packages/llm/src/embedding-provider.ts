import { createAzure } from "@ai-sdk/azure";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { SecretsService } from "@tulipfarm/secrets";
import type { EmbeddingModel } from "ai";
import { LlmConfigValidationError } from "./config";
import type { EmbeddingProviderEntry } from "./config";
import { resolveApiKey } from "./provider";

/**
 * Build a text-embedding model from one config entry. Mirrors `createModel`
 * (provider.ts) — same credential resolution, same provider-switch shape.
 */
export async function createEmbeddingModel(
  entry: EmbeddingProviderEntry,
  secrets: SecretsService
): Promise<EmbeddingModel<string>> {
  const apiKey = await resolveApiKey(entry.api_key_ref, secrets);

  switch (entry.provider) {
    case "openai": {
      const p = createOpenAI({ apiKey });
      return p.textEmbeddingModel(entry.model);
    }
    case "azure": {
      if (!entry.resource_name && !entry.base_url) {
        throw new LlmConfigValidationError("azure provider requires resource_name or base_url");
      }
      const p = createAzure({
        resourceName: entry.resource_name,
        baseURL: entry.base_url,
        apiKey,
      });
      return p.textEmbeddingModel(entry.model);
    }
    case "openai-compatible": {
      if (!entry.base_url) {
        throw new LlmConfigValidationError("openai-compatible provider requires base_url");
      }
      const p = createOpenAICompatible({
        baseURL: entry.base_url,
        name: "openai-compatible",
        apiKey,
      });
      return p.textEmbeddingModel(entry.model);
    }
    case "ollama": {
      if (!entry.base_url) {
        throw new LlmConfigValidationError("ollama provider requires base_url");
      }
      const p = createOpenAICompatible({
        baseURL: entry.base_url,
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
