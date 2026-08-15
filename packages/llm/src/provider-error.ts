import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError, NoSuchModelError, RetryError } from "ai";

export type LlmProviderFailureReason =
  | "model_billing_inactive"
  | "model_authentication_failed"
  | "model_not_found"
  | "model_rate_limited"
  | "model_provider_unavailable"
  | "model_error";

const BILLING_CODES = new Set(["billing_not_active", "insufficient_quota"]);
const AUTH_CODES = new Set(["invalid_api_key", "authentication_error"]);
const MODEL_CODES = new Set(["model_not_found", "invalid_model"]);

/** A safe provider-neutral failure. Its cause remains operator-only. */
export class LlmProviderError extends Error {
  constructor(
    readonly reason: Exclude<
      LlmProviderFailureReason,
      "model_rate_limited" | "model_provider_unavailable" | "model_error"
    >,
    cause: unknown
  ) {
    super(reason, { cause });
    this.name = "LlmProviderError";
  }
}

/**
 * A call shed before it ever reached the provider: local admission control — the per-provider
 * concurrency queue or its circuit breaker — refused to dial out.
 *
 * Deliberately not an `LlmProviderError`, which marks permanent failures the SDK must stop
 * retrying. A shed call is transient by construction. It lives here rather than beside the gate
 * that throws it because `classifyProviderError` is the only classification authority, and a
 * package may not import from an application.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    reason: string
  ) {
    super(`provider ${provider} is not accepting calls: ${reason}`);
    this.name = "ProviderUnavailableError";
  }
}

function lastProviderError(error: unknown): unknown {
  return RetryError.isInstance(error) ? lastProviderError(error.lastError) : error;
}

function errorCodes(error: APICallError): Set<string> {
  const codes = new Set<string>();
  if (!error.responseBody) return codes;
  try {
    const parsed = JSON.parse(error.responseBody) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return codes;
    const root = parsed as Record<string, unknown>;
    const detail =
      typeof root.error === "object" && root.error !== null && !Array.isArray(root.error)
        ? (root.error as Record<string, unknown>)
        : root;
    for (const field of ["code", "type"]) {
      if (typeof detail[field] === "string") codes.add(detail[field].toLowerCase());
    }
  } catch {
    // Provider bodies are untrusted and inconsistent. Classification falls back to HTTP status.
  }
  return codes;
}

export function classifyProviderError(error: unknown): LlmProviderFailureReason {
  const providerError = lastProviderError(error);
  if (providerError instanceof LlmProviderError) return providerError.reason;
  if (providerError instanceof ProviderUnavailableError) return "model_provider_unavailable";
  if (LoadAPIKeyError.isInstance(providerError)) return "model_authentication_failed";
  if (NoSuchModelError.isInstance(providerError)) return "model_not_found";
  if (!APICallError.isInstance(providerError)) return "model_error";

  const codes = errorCodes(providerError);
  if ([...codes].some((code) => BILLING_CODES.has(code))) return "model_billing_inactive";
  if ([...codes].some((code) => AUTH_CODES.has(code))) return "model_authentication_failed";
  if ([...codes].some((code) => MODEL_CODES.has(code))) return "model_not_found";
  if (providerError.statusCode === 401 || providerError.statusCode === 403) {
    return "model_authentication_failed";
  }
  if (providerError.statusCode === 404) return "model_not_found";
  if (providerError.statusCode === 429) return "model_rate_limited";
  if (providerError.statusCode !== undefined && providerError.statusCode >= 500) {
    return "model_provider_unavailable";
  }
  return "model_error";
}

function permanentProviderError(error: unknown): unknown {
  const reason = classifyProviderError(error);
  return reason === "model_billing_inactive" ||
    reason === "model_authentication_failed" ||
    reason === "model_not_found"
    ? new LlmProviderError(reason, error)
    : error;
}

/**
 * Prevent the AI SDK from retrying permanent provider failures. Transient 429/5xx failures retain
 * their original retry metadata and continue through the configured retry/fallback policy.
 */
export class ClassifiedLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: LanguageModelV4["supportedUrls"];

  constructor(private readonly model: LanguageModelV4) {
    this.provider = model.provider;
    this.modelId = model.modelId;
    this.supportedUrls = model.supportedUrls;
    for (const property of Reflect.ownKeys(model)) {
      if (property in this) continue;
      const descriptor = Object.getOwnPropertyDescriptor(model, property);
      if (descriptor !== undefined) Object.defineProperty(this, property, descriptor);
    }
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    try {
      return await this.model.doGenerate(options);
    } catch (error) {
      throw permanentProviderError(error);
    }
  }

  async doStream(options: LanguageModelV4CallOptions) {
    try {
      return await this.model.doStream(options);
    } catch (error) {
      throw permanentProviderError(error);
    }
  }
}
