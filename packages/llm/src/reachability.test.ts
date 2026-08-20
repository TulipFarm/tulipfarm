import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { LlmProviderError, ProviderUnavailableError } from "./provider-error";
import { checkModelReachability } from "./reachability";

/**
 * A provider that answers is reachable even when it refuses what it was asked. Collapsing the two
 * is what makes a health row untrustworthy: swallow the difference and an outage reads `ok`;
 * ignore it and a provider that merely disliked the probe's own request reads `down`.
 */

function failing(error: unknown) {
  return {
    specificationVersion: "v4" as const,
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: () => Promise.reject(error),
    doStream: () => Promise.reject(error),
  };
}

function apiError(statusCode: number | undefined, message: string) {
  return new APICallError({
    message,
    url: "https://provider.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    isRetryable: false,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: the AI SDK model type is structural here.
const asModel = (model: unknown) => model as any;

describe("checkModelReachability", () => {
  it("reports a provider that answers as reachable", async () => {
    const model = {
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
      doStream: () => Promise.reject(new Error("unused")),
    };

    expect(await checkModelReachability(asModel(model))).toEqual({ verdict: "reachable" });
  });

  it("degrades on a refused credential and names the page that fixes it", async () => {
    const report = await checkModelReachability(
      asModel(failing(new LlmProviderError("model_authentication_failed", new Error("401"))))
    );

    expect(report.verdict).toBe("degraded");
    expect(report.detail).toContain("Business → Models");
  });

  it("degrades, rather than blaming the provider, when its own request is refused", async () => {
    const report = await checkModelReachability(asModel(failing(apiError(400, "bad request"))));

    expect(report.verdict).toBe("degraded");
    expect(report.detail).toContain("the provider itself is reachable");
  });

  it("degrades on a throttle, which proves the credential and the model are fine", async () => {
    const report = await checkModelReachability(asModel(failing(apiError(429, "slow down"))));

    expect(report.verdict).toBe("degraded");
    expect(report.detail).toContain("rate limiting");
  });

  it("reports unreachable when no response arrives at all", async () => {
    const report = await checkModelReachability(
      asModel(failing(apiError(undefined, "Cannot connect to API")))
    );

    expect(report.verdict).toBe("unreachable");
    expect(report.detail).toContain("test-model");
  });

  it("reports unreachable when the provider answers that it is not serving", async () => {
    const report = await checkModelReachability(asModel(failing(apiError(503, "overloaded"))));

    expect(report.verdict).toBe("unreachable");
    expect(report.detail).toContain("503");
  });

  it("reports unreachable when the call is shed before it dials out", async () => {
    const report = await checkModelReachability(
      asModel(failing(new ProviderUnavailableError("test", "circuit open")))
    );

    expect(report.verdict).toBe("unreachable");
  });

  it("reports unreachable, naming the budget, when the provider never answers", async () => {
    const hanging = {
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      doGenerate: (options: { abortSignal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      doStream: () => Promise.reject(new Error("unused")),
    };

    const report = await checkModelReachability(asModel(hanging), 5);

    expect(report.verdict).toBe("unreachable");
    expect(report.detail).toContain("did not answer");
  });

  it("keeps the provider's own words out of the verdict", async () => {
    const report = await checkModelReachability(
      asModel(failing(apiError(401, "invalid api key sk-live-do-not-log")))
    );

    expect(report.detail ?? "").not.toContain("sk-live");
  });
});
