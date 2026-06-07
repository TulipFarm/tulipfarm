import type { LanguageModelV1 } from "ai";
import { describe, expect, it, vi } from "vitest";
import { LlmConfigValidationError, LlmNotConfiguredError, UnknownModelError } from "./config";
import { LlmService } from "./llm-service";

vi.mock("./provider", () => ({
  createModel: vi.fn((entry: { provider: string; model: string }) =>
    Promise.resolve({
      provider: entry.provider,
      modelId: entry.model,
      defaultObjectGenerationMode: "json",
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    } as unknown as LanguageModelV1)
  ),
}));

const validConfig = {
  tiers: {
    quick: {
      providers: [{ provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "key" }],
    },
    standard: {
      providers: [{ provider: "anthropic", model: "claude-sonnet-4-6", api_key_ref: "key" }],
    },
    complex: {
      providers: [{ provider: "anthropic", model: "claude-opus-4-8", api_key_ref: "key" }],
    },
  },
};

const fakeSecrets = {} as never;

describe("LlmService", () => {
  it("init builds tiers and getModel returns FallbackModel", async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    const model = svc.getModel("quick");
    expect(model).toBeDefined();
  });

  it("getModel returns correct tier", async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    expect(svc.getModel("quick")).toBeDefined();
    expect(svc.getModel("standard")).toBeDefined();
    expect(svc.getModel("complex")).toBeDefined();
  });

  it("null config skips init without throwing", async () => {
    const svc = new LlmService();
    await expect(svc.init(null, fakeSecrets)).resolves.toBeUndefined();
  });

  it("getModel before init throws LlmNotConfiguredError", () => {
    const svc = new LlmService();
    expect(() => svc.getModel("quick")).toThrow(LlmNotConfiguredError);
  });

  it("getModel after null config throws LlmNotConfiguredError", async () => {
    const svc = new LlmService();
    await svc.init(null, fakeSecrets);
    expect(() => svc.getModel("quick")).toThrow(LlmNotConfiguredError);
  });

  it("invalid config throws LlmConfigValidationError", async () => {
    const svc = new LlmService();
    await expect(svc.init({ tiers: {} }, fakeSecrets)).rejects.toThrow(LlmConfigValidationError);
  });
});

describe("LlmService.select", () => {
  const init = async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    return svc;
  };

  it("model auto + supervised resolves to standard (AC-V1-001)", async () => {
    const svc = await init();
    expect(svc.select({ model: "auto", autonomy: "supervised" }).modelId).toBe("claude-sonnet-4-6");
  });

  it("explicit tier overrides auto rules (AC3)", async () => {
    const svc = await init();
    expect(svc.select({ model: "complex", autonomy: "full" }).modelId).toBe("claude-opus-4-8");
  });

  it("session model overrides configured tier for the turn (AC4)", async () => {
    const svc = await init();
    expect(svc.select({ model: "complex", sessionModel: "quick" }).modelId).toBe(
      "claude-haiku-4-5"
    );
  });

  it("raw model id bypasses tiers via getModelById", async () => {
    const svc = await init();
    expect(svc.select({ model: "claude-opus-4-8" }).modelId).toBe("claude-opus-4-8");
  });

  it("unknown raw model id throws UnknownModelError", async () => {
    const svc = await init();
    expect(() => svc.select({ sessionModel: "no-such-model" })).toThrow(UnknownModelError);
  });

  it("defaults to auto → standard when no model given", async () => {
    const svc = await init();
    expect(svc.select({}).modelId).toBe("claude-sonnet-4-6");
  });

  it("select before init throws LlmNotConfiguredError", () => {
    const svc = new LlmService();
    expect(() => svc.select({ model: "auto" })).toThrow(LlmNotConfiguredError);
  });
});
