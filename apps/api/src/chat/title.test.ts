import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { buildAndStoreTitle } from "./title";

const silentLog = { warn: () => undefined };

const V3_USAGE = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, reasoning: undefined },
};

// Non-streaming fake model whose doGenerate returns fixed text (mirrors the quick-tier mock in
// routes.test.ts). `null` text simulates a model failure path via a thrown doGenerate.
function makeTitleModel(text: string | null): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "quick-model",
    supportedUrls: {},
    doStream: vi.fn(async () => {
      throw new Error("doStream unused");
    }),
    doGenerate: vi.fn(async () => {
      if (text === null) throw new Error("model exploded");
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: V3_USAGE,
        warnings: [],
      };
    }),
  } as unknown as LanguageModelV3 as unknown as LanguageModel;
}

describe("buildAndStoreTitle", () => {
  it("persists the generated title", async () => {
    const setTitleIfUnset = vi.fn(async () => undefined);
    await buildAndStoreTitle({
      repo: { setTitleIfUnset },
      getModel: () => makeTitleModel("Q3 Plan"),
      id: "c1",
      prompt: "plan q3",
      log: silentLog,
    });
    expect(setTitleIfUnset).toHaveBeenCalledWith("c1", "Q3 Plan");
  });

  it("persists the fallback title when the quick tier is unavailable (getModel throws)", async () => {
    const setTitleIfUnset = vi.fn(async () => undefined);
    await buildAndStoreTitle({
      repo: { setTitleIfUnset },
      getModel: () => {
        throw new Error("quick tier not configured");
      },
      id: "c1",
      prompt: "help me plan inventory",
      log: silentLog,
    });
    expect(setTitleIfUnset).toHaveBeenCalledWith("c1", "help me plan inventory");
  });

  it("swallows a persistence failure (a missing title is non-fatal)", async () => {
    const warn = vi.fn();
    await expect(
      buildAndStoreTitle({
        repo: {
          setTitleIfUnset: async () => {
            throw new Error("db down");
          },
        },
        getModel: () => makeTitleModel("X"),
        id: "c1",
        prompt: "p",
        log: { warn },
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
