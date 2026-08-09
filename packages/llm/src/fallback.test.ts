import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { FallbackModel, isHardFailure } from "./fallback";
import { LlmProviderError } from "./provider-error";

const opts = {} as LanguageModelV4CallOptions;

function apiError(statusCode: number, isRetryable: boolean): APICallError {
  return new APICallError({
    message: `http ${statusCode}`,
    url: "https://provider.test",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

function makeModel(
  overrides: Partial<Pick<LanguageModelV4, "doGenerate" | "doStream">> = {}
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: vi.fn().mockRejectedValue(new Error("not implemented")),
    doStream: vi.fn().mockRejectedValue(new Error("not implemented")),
    ...overrides,
  } as unknown as LanguageModelV4;
}

function makeStreamResult(chunks: unknown[], failAfterChunks?: number) {
  let count = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (failAfterChunks !== undefined && count >= failAfterChunks) {
        controller.error(new Error("stream error"));
        return;
      }
      if (count < chunks.length) {
        controller.enqueue(chunks[count++]);
      } else {
        controller.close();
      }
    },
  });
  return { stream, rawCall: { rawPrompt: null, rawSettings: {} } };
}

describe("FallbackModel.doGenerate", () => {
  it("returns first model result on success", async () => {
    const result = {
      text: "hello",
      finishReason: "stop",
      usage: {},
      rawCall: { rawPrompt: null, rawSettings: {} },
    };
    const m1 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const m2 = makeModel();
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).resolves.toBe(result);
    expect(m2.doGenerate).not.toHaveBeenCalled();
  });

  it("falls back to second model on first error", async () => {
    const result = {
      text: "fallback",
      finishReason: "stop",
      usage: {},
      rawCall: { rawPrompt: null, rawSettings: {} },
    };
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(new Error("rate limit")) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).resolves.toBe(result);
  });

  it("rethrows last error when all models fail", async () => {
    const err = new Error("last error");
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(new Error("first")) });
    const m2 = makeModel({ doGenerate: vi.fn().mockRejectedValue(err) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).rejects.toBe(err);
  });

  it("propagates AbortError immediately without fallback", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(abort) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue({}) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).rejects.toBe(abort);
    expect(m2.doGenerate).not.toHaveBeenCalled();
  });
});

describe("FallbackModel.doStream", () => {
  it("returns first model stream on success", async () => {
    const streamResult = makeStreamResult([{ type: "text-delta", textDelta: "hi" }]);
    const m1 = makeModel({ doStream: vi.fn().mockResolvedValue(streamResult) });
    const fallback = new FallbackModel([m1]);
    const result = await fallback.doStream(opts);
    const reader = result.stream.getReader();
    const { value } = await reader.read();
    expect((value as unknown as { textDelta: string }).textDelta).toBe("hi");
  });

  it("falls back when first model doStream rejects before any chunk", async () => {
    const streamResult = makeStreamResult([{ type: "text-delta", textDelta: "fallback" }]);
    const m1 = makeModel({ doStream: vi.fn().mockRejectedValue(new Error("unavailable")) });
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(streamResult) });
    const fallback = new FallbackModel([m1, m2]);
    const result = await fallback.doStream(opts);
    const reader = result.stream.getReader();
    const { value } = await reader.read();
    expect((value as unknown as { textDelta: string }).textDelta).toBe("fallback");
  });

  it("does not fall back after first chunk received", async () => {
    const streamResult = makeStreamResult(
      [{ type: "text-delta", textDelta: "partial" }],
      1 // error after first chunk
    );
    const m1 = makeModel({ doStream: vi.fn().mockResolvedValue(streamResult) });
    const m2 = makeModel();
    const fallback = new FallbackModel([m1, m2]);
    const result = await fallback.doStream(opts);
    const reader = result.stream.getReader();
    await reader.read(); // first chunk ok
    await expect(reader.read()).rejects.toThrow("stream error");
    expect(m2.doStream).not.toHaveBeenCalled();
  });

  it("propagates AbortError immediately in doStream", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const m1 = makeModel({ doStream: vi.fn().mockRejectedValue(abort) });
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(makeStreamResult([])) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doStream(opts)).rejects.toBe(abort);
    expect(m2.doStream).not.toHaveBeenCalled();
  });

  it("aborts without fallback on a hard (401) error before any chunk", async () => {
    const err = apiError(401, false);
    const m1 = makeModel({ doStream: vi.fn().mockRejectedValue(err) });
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(makeStreamResult([])) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doStream(opts)).rejects.toBe(err);
    expect(m2.doStream).not.toHaveBeenCalled();
  });

  it("falls back on a transient (429) stream error before any chunk", async () => {
    const streamResult = makeStreamResult([{ type: "text-delta", textDelta: "ok" }]);
    const m1 = makeModel({ doStream: vi.fn().mockRejectedValue(apiError(429, true)) });
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(streamResult) });
    const fallback = new FallbackModel([m1, m2]);
    const result = await fallback.doStream(opts);
    const reader = result.stream.getReader();
    const { value } = await reader.read();
    expect((value as unknown as { textDelta: string }).textDelta).toBe("ok");
  });
});

describe("FallbackModel error classification", () => {
  it("aborts without fallback on a 401 auth error", async () => {
    const err = apiError(401, false);
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(err) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue({}) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).rejects.toBe(err);
    expect(m2.doGenerate).not.toHaveBeenCalled();
  });

  it("aborts without fallback on a 404 model-not-found error", async () => {
    const err = apiError(404, false);
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(err) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue({}) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).rejects.toBe(err);
    expect(m2.doGenerate).not.toHaveBeenCalled();
  });

  it("aborts without fallback on a missing/invalid API key", async () => {
    const err = new LoadAPIKeyError({ message: "no key" });
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(err) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue({}) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).rejects.toBe(err);
    expect(m2.doGenerate).not.toHaveBeenCalled();
  });

  it("falls back on a transient (429) rate-limit error", async () => {
    const result = { text: "ok", finishReason: "stop", usage: {}, rawCall: {} };
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(apiError(429, true)) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).resolves.toBe(result);
  });

  it("falls back on a transient (503) server error", async () => {
    const result = { text: "ok", finishReason: "stop", usage: {}, rawCall: {} };
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(apiError(503, true)) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).resolves.toBe(result);
  });
});

describe("FallbackModel logging", () => {
  it("logs a fallback event with provider name and error reason", async () => {
    const result = { text: "ok", finishReason: "stop", usage: {}, rawCall: {} };
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(apiError(503, true)) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const logger = { warn: vi.fn() };
    const fallback = new FallbackModel([m1, m2], logger);
    await fallback.doGenerate(opts);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = logger.warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain("fallback");
    expect(msg).toContain("provider=test");
    expect(msg).toContain("503");
  });

  it("logs an exhausted event and propagates the last error when all fail", async () => {
    const last = apiError(503, true);
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(apiError(429, true)) });
    const m2 = makeModel({ doGenerate: vi.fn().mockRejectedValue(last) });
    const logger = { warn: vi.fn() };
    const fallback = new FallbackModel([m1, m2], logger);
    await expect(fallback.doGenerate(opts)).rejects.toBe(last);
    const messages = logger.warn.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes("all providers exhausted"))).toBe(true);
  });

  it("does not log a fallback event on a hard error", async () => {
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(apiError(401, false)) });
    const logger = { warn: vi.fn() };
    const fallback = new FallbackModel([m1], logger);
    await expect(fallback.doGenerate(opts)).rejects.toBeInstanceOf(APICallError);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("isHardFailure", () => {
  it("classifies abort and credential errors as hard", () => {
    expect(isHardFailure(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isHardFailure(new LoadAPIKeyError({ message: "no key" }))).toBe(true);
    expect(
      isHardFailure(new LlmProviderError("model_billing_inactive", new Error("provider response")))
    ).toBe(true);
  });

  it("classifies non-retryable API errors (401/404/400) as hard", () => {
    expect(isHardFailure(apiError(401, false))).toBe(true);
    expect(isHardFailure(apiError(404, false))).toBe(true);
    expect(isHardFailure(apiError(400, false))).toBe(true);
  });

  it("classifies retryable API errors, network and unknown errors as transient", () => {
    expect(isHardFailure(apiError(429, true))).toBe(false);
    expect(isHardFailure(apiError(500, true))).toBe(false);
    expect(isHardFailure(new Error("ECONNREFUSED"))).toBe(false);
    expect(isHardFailure("weird")).toBe(false);
  });
});
