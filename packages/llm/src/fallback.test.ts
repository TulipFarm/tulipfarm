import type { LanguageModelV1, LanguageModelV1CallOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import { FallbackModel } from "./fallback";

const opts = {} as LanguageModelV1CallOptions;

function makeModel(
  overrides: Partial<Pick<LanguageModelV1, "doGenerate" | "doStream">> = {}
): LanguageModelV1 {
  return {
    provider: "test",
    modelId: "test-model",
    defaultObjectGenerationMode: "json",
    doGenerate: vi.fn().mockRejectedValue(new Error("not implemented")),
    doStream: vi.fn().mockRejectedValue(new Error("not implemented")),
    ...overrides,
  } as unknown as LanguageModelV1;
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
    expect((value as { textDelta: string }).textDelta).toBe("hi");
  });

  it("falls back when first model doStream rejects before any chunk", async () => {
    const streamResult = makeStreamResult([{ type: "text-delta", textDelta: "fallback" }]);
    const m1 = makeModel({ doStream: vi.fn().mockRejectedValue(new Error("unavailable")) });
    const m2 = makeModel({ doStream: vi.fn().mockResolvedValue(streamResult) });
    const fallback = new FallbackModel([m1, m2]);
    const result = await fallback.doStream(opts);
    const reader = result.stream.getReader();
    const { value } = await reader.read();
    expect((value as { textDelta: string }).textDelta).toBe("fallback");
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
});
