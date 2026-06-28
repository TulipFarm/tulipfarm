import { describe, expect, it } from "vitest";
import { attributeModel, extractStepUsage, extractToolCalls, type ObservableStep } from "./capture";

describe("extractToolCalls", () => {
  it("maps tool results to name + ok/error and carries arg/result bodies", () => {
    const step: ObservableStep = {
      toolCalls: [{ toolName: "search_knowledge", input: { q: "hi" } }],
      toolResults: [
        { toolName: "search_knowledge", output: { success: true, data: { hits: 1 } } },
        { toolName: "record_create", output: { success: false, error: { code: "not_found" } } },
      ],
    };
    const calls = extractToolCalls(step);
    expect(calls[0]).toMatchObject({
      name: "search_knowledge",
      status: "ok",
      args: { q: "hi" },
      result: { success: true, data: { hits: 1 } },
    });
    expect(calls[1]).toMatchObject({
      name: "record_create",
      status: "error",
      errorCode: "not_found",
    });
  });

  it("returns empty when no tools ran", () => {
    expect(extractToolCalls({})).toEqual([]);
  });
});

describe("extractStepUsage", () => {
  it("reads flat v7 usage totals + cache details + served model id", () => {
    const step: ObservableStep = {
      usage: {
        inputTokens: 4100,
        outputTokens: 820,
        inputTokenDetails: { cacheReadTokens: 3000, cacheWriteTokens: 100 },
        outputTokenDetails: { reasoningTokens: 200 },
      },
      response: { modelId: "claude-opus-4-8" },
    };
    expect(extractStepUsage(step)).toEqual({
      tokensIn: 4100,
      tokensOut: 820,
      servedModelId: "claude-opus-4-8",
      cacheRead: 3000,
      cacheWrite: 100,
      reasoning: 200,
    });
  });

  it("defaults missing usage/response to zero/null", () => {
    expect(extractStepUsage({})).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      servedModelId: null,
      cacheRead: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
    });
  });
});

describe("attributeModel", () => {
  const chain = [
    { provider: "azure", modelId: "gpt-4o-mini", spec: { input_cost_per_token: 0.001 } },
    { provider: "anthropic", modelId: "claude-haiku-4-5" },
  ];

  it("attributes the served model to its provider (primary, no fallback) + carries its spec", () => {
    expect(attributeModel("gpt-4o-mini", chain, "gpt-4o-mini")).toMatchObject({
      model: "gpt-4o-mini",
      provider: "azure",
      fellBack: false,
      entry: { provider: "azure", spec: { input_cost_per_token: 0.001 } },
    });
  });

  it("attributes a fallback-served model to the right provider + flags fellBack", () => {
    expect(attributeModel("claude-haiku-4-5", chain, "gpt-4o-mini")).toMatchObject({
      model: "claude-haiku-4-5",
      provider: "anthropic",
      fellBack: true,
    });
  });

  it("matches a dated served id to its chain entry by prefix (and flags fallback)", () => {
    const r = attributeModel("claude-haiku-4-5-20250901", chain, "gpt-4o-mini");
    expect(r.provider).toBe("anthropic");
    expect(r.fellBack).toBe(true);
  });

  it("falls back to the primary model id when the step reports none (not a fallback)", () => {
    expect(attributeModel(null, chain, "gpt-4o-mini")).toMatchObject({
      model: "gpt-4o-mini",
      provider: "azure",
      fellBack: false,
    });
  });

  it("defaults provider to the chain head when the served model is unknown", () => {
    const r = attributeModel("mystery-model", chain, "gpt-4o-mini");
    expect(r.provider).toBe("azure");
    expect(r.fellBack).toBe(false);
  });
});
