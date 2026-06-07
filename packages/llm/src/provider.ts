import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { SecretUnavailableError, type SecretsService } from "@tulipfarm/secrets";
import type { LanguageModelV1 } from "ai";
import { LlmConfigValidationError, LlmCredentialError } from "./config";
import type { ProviderEntry } from "./config";

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

export async function createModel(
  entry: ProviderEntry,
  secrets: SecretsService
): Promise<LanguageModelV1> {
  const apiKey = await resolveApiKey(entry.api_key_ref, secrets);

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
      if (!entry.base_url) {
        throw new LlmConfigValidationError("openai-compatible provider requires base_url");
      }
      const p = createOpenAICompatible({
        baseURL: entry.base_url,
        name: "openai-compatible",
        apiKey,
      });
      return p(entry.model);
    }
    default:
      throw new LlmConfigValidationError(`unknown provider: ${entry.provider}`);
  }
}
