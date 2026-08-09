import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, generateText, RetryError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { ClassifiedLanguageModel, classifyProviderError, LlmProviderError } from "./provider-error";

function apiError(
  statusCode: number,
  body: Record<string, unknown>,
  isRetryable = statusCode === 429 || statusCode >= 500
): APICallError {
  return new APICallError({
    message: `http ${statusCode}`,
    url: "https://provider.test/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify(body),
    isRetryable,
  });
}

function model(error: unknown): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: vi.fn().mockRejectedValue(error),
    doStream: vi.fn().mockRejectedValue(error),
  } as unknown as LanguageModelV4;
}

const options = {} as LanguageModelV4CallOptions;

describe("classifyProviderError", () => {
  it("recognizes billing failures inside the provider response body", () => {
    expect(
      classifyProviderError(
        apiError(429, { error: { type: "billing_not_active", code: "billing_not_active" } })
      )
    ).toBe("model_billing_inactive");
  });

  it("unwraps the SDK retry envelope", () => {
    const billing = apiError(429, { error: { code: "insufficient_quota" } });
    const retried = new RetryError({
      message: "failed after retries",
      reason: "maxRetriesExceeded",
      errors: [billing, billing],
    });

    expect(classifyProviderError(retried)).toBe("model_billing_inactive");
  });

  it("classifies safe HTTP categories and keeps unknown failures generic", () => {
    expect(classifyProviderError(apiError(401, {}))).toBe("model_authentication_failed");
    expect(classifyProviderError(apiError(404, {}))).toBe("model_not_found");
    expect(classifyProviderError(apiError(429, {}))).toBe("model_rate_limited");
    expect(classifyProviderError(apiError(503, {}))).toBe("model_provider_unavailable");
    expect(classifyProviderError(new Error("secret provider detail"))).toBe("model_error");
  });
});

describe("ClassifiedLanguageModel", () => {
  it("turns retryable billing responses into a permanent safe failure", async () => {
    const underlying = model(apiError(429, { error: { code: "billing_not_active" } }));
    const wrapped = new ClassifiedLanguageModel(underlying);

    await expect(wrapped.doGenerate(options)).rejects.toMatchObject({
      name: "LlmProviderError",
      reason: "model_billing_inactive",
    });
    await expect(wrapped.doStream(options)).rejects.toBeInstanceOf(LlmProviderError);
    await expect(
      generateText({ model: wrapped, prompt: "hello", maxRetries: 2 })
    ).rejects.toMatchObject({ reason: "model_billing_inactive" });
    expect(underlying.doGenerate).toHaveBeenCalledTimes(2);
  });

  it("preserves transient rate-limit errors for the retry policy", async () => {
    const rateLimit = apiError(429, { error: { code: "rate_limit_exceeded" } });
    const wrapped = new ClassifiedLanguageModel(model(rateLimit));

    await expect(wrapped.doGenerate(options)).rejects.toBe(rateLimit);
  });
});
