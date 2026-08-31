import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { LlmProviderError, ProviderUnavailableError } from "./provider-error";
import { checkEmbeddingReachability, checkModelReachability } from "./reachability";

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
  it("reports a provider that answers with the asked-for word as reachable", async () => {
    const model = {
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "Pong!" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
      doStream: () => Promise.reject(new Error("unused")),
    };

    // The reply is carried back, not just the verdict: an endpoint that returns 200 with an empty
    // completion is reachable but useless, and only the text tells them apart.
    expect(await checkModelReachability(asModel(model))).toMatchObject({
      verdict: "reachable",
      reply: "Pong!",
      answeredAsAsked: true,
    });
  });

  it("still reports reachable when the answer is not the asked-for word, but flags it", async () => {
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

    // The deployment is healthy — the call worked — so the verdict stays green and the status page
    // does not cry wolf over a chatty model. The weaker fact rides alongside for the operator who
    // pressed Test connection and wants to know the model ignored the instruction.
    expect(await checkModelReachability(asModel(model))).toMatchObject({
      verdict: "reachable",
      reply: "ok",
      answeredAsAsked: false,
    });
  });

  it("flags an empty completion, which a route that accepts anything will return", async () => {
    const model = {
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
      }),
      doStream: () => Promise.reject(new Error("unused")),
    };

    expect(await checkModelReachability(asModel(model))).toMatchObject({
      verdict: "reachable",
      reply: "",
      answeredAsAsked: false,
    });
  });

  it("asks for a word back so the reply proves a model answered, not just an endpoint", async () => {
    const prompts: unknown[] = [];
    const model = {
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      doGenerate: async (options: { prompt: unknown }) => {
        prompts.push(options.prompt);
        return {
          content: [{ type: "text" as const, text: "pong" }],
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
      doStream: () => Promise.reject(new Error("unused")),
    };

    const report = await checkModelReachability(asModel(model));

    expect(report.reply).toBe("pong");
    expect(JSON.stringify(prompts)).toMatch(/pong/);
    expect(report.latencyMs).toBeTypeOf("number");
  });

  it("truncates a model that ignores the instruction instead of printing all of it", async () => {
    const model = {
      specificationVersion: "v4" as const,
      provider: "test",
      modelId: "test-model",
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "x".repeat(5_000) }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
      doStream: () => Promise.reject(new Error("unused")),
    };

    const report = await checkModelReachability(asModel(model));

    expect(report.reply?.length).toBeLessThan(250);
    expect(report.reply?.endsWith("…")).toBe(true);
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

describe("checkEmbeddingReachability", () => {
  const embedder = (result: () => unknown) => ({
    specificationVersion: "v3" as const,
    provider: "test",
    modelId: "text-embedding-3-small",
    maxEmbeddingsPerCall: 1,
    supportsParallelCalls: false,
    doEmbed: async () => result(),
  });

  it("reports the width it got back, which is the number the index needs", async () => {
    const report = await checkEmbeddingReachability(
      asModel(embedder(() => ({ embeddings: [[0.1, 0.2, 0.3]], usage: { tokens: 1 } })))
    );

    expect(report.verdict).toBe("reachable");
    expect(report.dimension).toBe(3);
  });

  it("treats an answer with no vector as degraded, not as a pass", async () => {
    // Accepting the request without doing the job would index Knowledge into nothing, which is
    // worse than a refusal because nothing else on the instance reports it.
    const report = await checkEmbeddingReachability(
      asModel(embedder(() => ({ embeddings: [[]], usage: { tokens: 1 } })))
    );

    expect(report.verdict).toBe("degraded");
    expect(report.detail).toMatch(/without returning a vector/i);
  });

  it("classifies a refused credential the same way the chat probe does", async () => {
    const report = await checkEmbeddingReachability(
      asModel(
        embedder(() => {
          throw new LlmProviderError("model_authentication_failed", new Error("401"));
        })
      )
    );

    expect(report.verdict).toBe("degraded");
    expect(report.detail).toMatch(/refused this deployment's credential/i);
  });
});
