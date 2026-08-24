import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { type FallbackCallGate, FallbackModel, isHardFailure } from "./fallback";
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

  it("ends the call when a model fails after output has been committed", async () => {
    const streamResult = makeStreamResult(
      [{ type: "text-delta", textDelta: "partial" }],
      1 // error after first chunk
    );
    const m1 = makeModel({ doStream: vi.fn().mockResolvedValue(streamResult) });
    const fallbackResult = makeStreamResult([{ type: "text-delta", textDelta: "complete" }]);
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(fallbackResult) });
    const fallback = new FallbackModel([m1, m2]);
    const result = await fallback.doStream(opts);
    const reader = result.stream.getReader();

    const { value } = await reader.read();
    expect((value as unknown as { textDelta: string }).textDelta).toBe("partial");
    // Switching links here would splice two different answers into one reply.
    await expect(reader.read()).rejects.toThrow("stream error");
    expect(m2.doStream).not.toHaveBeenCalled();
  });

  /** The regression guard: draining first made time-to-first-token the provider's last token. */
  it("forwards the first output part before the provider has finished", async () => {
    let release = (): void => {};
    const stillWorking = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        if (sent === 0) {
          sent += 1;
          controller.enqueue({ type: "text-delta", textDelta: "first" });
          return;
        }
        await stillWorking;
        controller.enqueue({ type: "text-delta", textDelta: "last" });
        controller.close();
      },
    });
    const m1 = makeModel({
      doStream: vi
        .fn()
        .mockResolvedValue({ stream, rawCall: { rawPrompt: null, rawSettings: {} } }),
    });
    const fallback = new FallbackModel([m1]);

    const result = await fallback.doStream(opts);
    const reader = result.stream.getReader();
    const first = await reader.read();
    expect((first.value as unknown as { textDelta: string }).textDelta).toBe("first");

    release();
    const last = await reader.read();
    expect((last.value as unknown as { textDelta: string }).textDelta).toBe("last");
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("still falls back when only metadata arrived before the failure", async () => {
    const streamResult = makeStreamResult(
      [{ type: "stream-start", warnings: [] }],
      1 // error after the metadata part, before any output
    );
    const m1 = makeModel({ doStream: vi.fn().mockResolvedValue(streamResult) });
    const fallbackResult = makeStreamResult([{ type: "text-delta", textDelta: "complete" }]);
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(fallbackResult) });
    const fallback = new FallbackModel([m1, m2]);
    const result = await fallback.doStream(opts);
    const reader = result.stream.getReader();

    const { value } = await reader.read();
    expect((value as unknown as { textDelta: string }).textDelta).toBe("complete");
    expect(m2.doStream).toHaveBeenCalledOnce();
  });

  it("forwards held-back metadata ahead of the output it preceded", async () => {
    const streamResult = makeStreamResult([
      { type: "stream-start", warnings: [] },
      { type: "text-delta", textDelta: "hi" },
    ]);
    const m1 = makeModel({ doStream: vi.fn().mockResolvedValue(streamResult) });
    const fallback = new FallbackModel([m1]);
    const result = await fallback.doStream(opts);

    const seen: string[] = [];
    for await (const part of result.stream) seen.push((part as { type: string }).type);
    expect(seen).toEqual(["stream-start", "text-delta"]);
  });

  it("propagates AbortError immediately in doStream", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const m1 = makeModel({ doStream: vi.fn().mockRejectedValue(abort) });
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(makeStreamResult([])) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doStream(opts)).rejects.toBe(abort);
    expect(m2.doStream).not.toHaveBeenCalled();
  });

  it("falls back on a non-retryable 401 error before any chunk", async () => {
    const err = apiError(401, false);
    const m1 = makeModel({ doStream: vi.fn().mockRejectedValue(err) });
    const result = makeStreamResult([{ type: "text-delta", textDelta: "fallback" }]);
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(result) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doStream(opts)).resolves.toBeDefined();
    expect(m2.doStream).toHaveBeenCalledOnce();
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
  it("falls back on a 401 auth error", async () => {
    const err = apiError(401, false);
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(err) });
    const result = { text: "fallback", finishReason: "stop", usage: {}, rawCall: {} };
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).resolves.toBe(result);
    expect(m2.doGenerate).toHaveBeenCalledOnce();
  });

  it("falls back on a 404 model-not-found error", async () => {
    const err = apiError(404, false);
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(err) });
    const result = { text: "fallback", finishReason: "stop", usage: {}, rawCall: {} };
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).resolves.toBe(result);
    expect(m2.doGenerate).toHaveBeenCalledOnce();
  });

  it("falls back on a missing or invalid API key", async () => {
    const err = new LoadAPIKeyError({ message: "no key" });
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(err) });
    const result = { text: "fallback", finishReason: "stop", usage: {}, rawCall: {} };
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const fallback = new FallbackModel([m1, m2]);
    await expect(fallback.doGenerate(opts)).resolves.toBe(result);
    expect(m2.doGenerate).toHaveBeenCalledOnce();
  });

  it("falls back when the primary subscription has no credit", async () => {
    const exhausted = new LlmProviderError(
      "model_billing_inactive",
      new Error("subscription exhausted")
    );
    const result = { text: "fallback", finishReason: "stop", usage: {}, rawCall: {} };
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(exhausted) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue(result) });
    const fallback = new FallbackModel([m1, m2]);

    await expect(fallback.doGenerate(opts)).resolves.toBe(result);
    expect(m2.doGenerate).toHaveBeenCalledOnce();
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

  it("logs a fallback event for a non-retryable provider error", async () => {
    const m1 = makeModel({ doGenerate: vi.fn().mockRejectedValue(apiError(401, false)) });
    const m2 = makeModel({ doGenerate: vi.fn().mockResolvedValue({}) });
    const logger = { warn: vi.fn() };
    const fallback = new FallbackModel([m1, m2], logger);
    await fallback.doGenerate(opts);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe("isHardFailure", () => {
  it("classifies only caller cancellation as hard", () => {
    expect(isHardFailure(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isHardFailure(new LoadAPIKeyError({ message: "no key" }))).toBe(false);
    expect(
      isHardFailure(new LlmProviderError("model_billing_inactive", new Error("provider response")))
    ).toBe(false);
    expect(isHardFailure(apiError(401, false))).toBe(false);
    expect(isHardFailure(apiError(404, false))).toBe(false);
    expect(isHardFailure(apiError(400, false))).toBe(false);
  });

  it("classifies retryable API errors, network and unknown errors as transient", () => {
    expect(isHardFailure(apiError(429, true))).toBe(false);
    expect(isHardFailure(apiError(500, true))).toBe(false);
    expect(isHardFailure(new Error("ECONNREFUSED"))).toBe(false);
    expect(isHardFailure("weird")).toBe(false);
  });
});

describe("FallbackModel link health", () => {
  it("skips a failed primary on later calls and records the fallback separately", async () => {
    const blocked = new Set<string>();
    const calls: string[] = [];
    const gate: FallbackCallGate = {
      async acquire(provider) {
        calls.push(provider);
        if (blocked.has(provider)) throw new Error(`${provider} unavailable`);
        return {
          succeeded() {},
          failed() {
            blocked.add(provider);
          },
          release() {},
        };
      },
    };
    const sonnet = makeModel({ doGenerate: vi.fn().mockRejectedValue(new Error("no credits")) });
    const terraResult = { text: "terra", finishReason: "stop", usage: {}, rawCall: {} };
    const terra = makeModel({ doGenerate: vi.fn().mockResolvedValue(terraResult) });
    const fallback = new FallbackModel([sonnet, terra], undefined, undefined, gate, [
      "anthropic",
      "codex",
    ]);

    await expect(fallback.doGenerate(opts)).resolves.toBe(terraResult);
    await expect(fallback.doGenerate(opts)).resolves.toBe(terraResult);

    expect(sonnet.doGenerate).toHaveBeenCalledOnce();
    expect(terra.doGenerate).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["anthropic", "codex", "anthropic", "codex"]);
  });
});

describe("FallbackModel lease settlement after commit", () => {
  function recordingGate() {
    const outcomes: string[] = [];
    let released = 0;
    const gate: FallbackCallGate = {
      async acquire() {
        return {
          succeeded() {
            outcomes.push("succeeded");
          },
          failed(reason: string) {
            outcomes.push(`failed:${reason}`);
          },
          release() {
            released += 1;
          },
        };
      },
    };
    return { gate, outcomes, releases: () => released };
  }

  function openStreamModel(): LanguageModelV4 {
    return makeModel({
      doStream: vi.fn().mockResolvedValue({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "1", delta: "hi" });
          },
          pull: () => new Promise<void>(() => {}),
        }),
      }),
    });
  }

  it("settles the lease exactly once when a committed stream is cancelled", async () => {
    const { gate, outcomes, releases } = recordingGate();
    const fallback = new FallbackModel([openStreamModel()], undefined, undefined, gate, [
      "anthropic",
    ]);

    const { stream } = await fallback.doStream(opts);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("caller done");

    expect(outcomes).toEqual(["succeeded"]);
    expect(releases()).toBe(1);
  });

  it("releases the lease when the caller's signal aborts mid-stream", async () => {
    const { gate, outcomes, releases } = recordingGate();
    const fallback = new FallbackModel([openStreamModel()], undefined, undefined, gate, [
      "anthropic",
    ]);
    const controller = new AbortController();

    const { stream } = await fallback.doStream({
      abortSignal: controller.signal,
    } as LanguageModelV4CallOptions);
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    await Promise.resolve();

    expect(outcomes).toEqual(["succeeded"]);
    expect(releases()).toBe(1);
  });

  it("does not mark the provider down when the caller aborts after commit", async () => {
    const { gate, outcomes, releases } = recordingGate();
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    const model = makeModel({
      doStream: vi.fn().mockResolvedValue({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "1", delta: "hi" });
          },
          pull(controller) {
            controller.error(aborted);
          },
        }),
      }),
    });
    const fallback = new FallbackModel([model], undefined, undefined, gate, ["anthropic"]);

    const { stream } = await fallback.doStream(opts);
    const reader = stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow("aborted");

    expect(outcomes).toEqual(["succeeded"]);
    expect(releases()).toBe(1);
  });
});
