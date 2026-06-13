import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { buildAndStoreTitle, buildConversationTitle, fallbackTitle, sanitizeTitle } from "./title";

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

describe("sanitizeTitle", () => {
  it("strips surrounding quotes, collapses whitespace, drops trailing punctuation", () => {
    expect(sanitizeTitle('  "Inventory   Planning Help."\n')).toBe("Inventory Planning Help");
  });

  it("bounds the length to 80 chars", () => {
    expect(sanitizeTitle("x".repeat(120))).toHaveLength(80);
  });
});

describe("fallbackTitle", () => {
  it("uses the first non-empty line, truncated to 60 chars", () => {
    expect(fallbackTitle("\n\nhelp me plan inventory\nsecond line")).toBe("help me plan inventory");
    expect(fallbackTitle("y".repeat(90))).toHaveLength(60);
  });

  it("returns 'New chat' for an empty prompt", () => {
    expect(fallbackTitle("   \n  ")).toBe("New chat");
  });
});

describe("buildConversationTitle", () => {
  it("returns the sanitized model output", async () => {
    const title = await buildConversationTitle(makeTitleModel('"Q3 Inventory Plan"'), "...");
    expect(title).toBe("Q3 Inventory Plan");
  });

  it("falls back to the truncated prompt when the model throws", async () => {
    const title = await buildConversationTitle(makeTitleModel(null), "help me plan inventory");
    expect(title).toBe("help me plan inventory");
  });

  it("falls back when the model returns blank text", async () => {
    const title = await buildConversationTitle(makeTitleModel("   "), "fix the budget sheet");
    expect(title).toBe("fix the budget sheet");
  });
});

describe("buildAndStoreTitle", () => {
  it("persists the generated title", async () => {
    const setTitle = vi.fn(async () => undefined);
    await buildAndStoreTitle({
      repo: { setTitle },
      getModel: () => makeTitleModel("Q3 Plan"),
      id: "c1",
      prompt: "plan q3",
      log: silentLog,
    });
    expect(setTitle).toHaveBeenCalledWith("c1", "Q3 Plan");
  });

  it("persists the fallback title when the quick tier is unavailable (getModel throws)", async () => {
    const setTitle = vi.fn(async () => undefined);
    await buildAndStoreTitle({
      repo: { setTitle },
      getModel: () => {
        throw new Error("quick tier not configured");
      },
      id: "c1",
      prompt: "help me plan inventory",
      log: silentLog,
    });
    expect(setTitle).toHaveBeenCalledWith("c1", "help me plan inventory");
  });

  it("swallows a persistence failure (a missing title is non-fatal)", async () => {
    const warn = vi.fn();
    await expect(
      buildAndStoreTitle({
        repo: {
          setTitle: async () => {
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
