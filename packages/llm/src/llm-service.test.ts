import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  LlmConfigValidationError,
  LlmCredentialError,
  LlmNotConfiguredError,
  UnknownModelError,
} from "@tulipfarm/schema";
import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { LlmService } from "./llm-service";
import { createModel } from "./provider";

vi.mock("./provider", () => ({
  createModel: vi.fn((entry: { provider: string; model: string }) =>
    Promise.resolve({
      specificationVersion: "v4",
      provider: entry.provider,
      modelId: entry.model,
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    } as unknown as LanguageModelV4)
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

  it("LlmCredentialError on a provider skips it and keeps the tier if another provider succeeds", async () => {
    const okModel = (entry: { provider: string; model: string }) =>
      Promise.resolve({
        specificationVersion: "v4",
        provider: entry.provider,
        modelId: entry.model,
        supportedUrls: {},
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      } as unknown as LanguageModelV4);

    // quick has 2 providers (1 rejected, 1 ok) + standard (ok) + complex (ok) = 4 calls total
    vi.mocked(createModel)
      .mockRejectedValueOnce(new LlmCredentialError("secret not found: azure-openai-api-key"))
      .mockImplementationOnce(okModel)
      .mockImplementationOnce(okModel)
      .mockImplementationOnce(okModel);

    const config = {
      tiers: {
        quick: {
          providers: [
            { provider: "azure", model: "gpt-4o", api_key_ref: "azure-openai-api-key" },
            { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "anthropic-api-key" },
          ],
        },
        standard: validConfig.tiers.standard,
        complex: validConfig.tiers.complex,
      },
    };

    const svc = new LlmService();
    await expect(svc.init(config, fakeSecrets)).resolves.toBeUndefined();
    expect(svc.getModel("quick")).toBeDefined();
  });

  it("LlmCredentialError on all providers of a tier skips the tier without throwing", async () => {
    const okModel = (entry: { provider: string; model: string }) =>
      Promise.resolve({
        specificationVersion: "v4",
        provider: entry.provider,
        modelId: entry.model,
        supportedUrls: {},
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      } as unknown as LanguageModelV4);

    // quick has 1 provider (rejected) + standard (ok) + complex (ok) = 3 calls total
    vi.mocked(createModel)
      .mockRejectedValueOnce(new LlmCredentialError("secret not found: key"))
      .mockImplementationOnce(okModel)
      .mockImplementationOnce(okModel);

    const config = {
      tiers: {
        quick: {
          providers: [{ provider: "azure", model: "gpt-4o", api_key_ref: "key" }],
        },
        standard: validConfig.tiers.standard,
        complex: validConfig.tiers.complex,
      },
    };

    const svc = new LlmService();
    await expect(svc.init(config, fakeSecrets)).resolves.toBeUndefined();
    expect(() => svc.getModel("quick")).toThrow(LlmNotConfiguredError);
    expect(svc.getModel("standard")).toBeDefined();
    expect(svc.getModel("complex")).toBeDefined();
  });

  it("LlmCredentialError on all tiers disables LLM without throwing", async () => {
    // validConfig has 1 provider per tier = 3 calls total
    vi.mocked(createModel)
      .mockRejectedValueOnce(new LlmCredentialError("secret not found: key"))
      .mockRejectedValueOnce(new LlmCredentialError("secret not found: key"))
      .mockRejectedValueOnce(new LlmCredentialError("secret not found: key"));

    const svc = new LlmService();
    await expect(svc.init(validConfig, fakeSecrets)).resolves.toBeUndefined();
    expect(() => svc.getModel("quick")).toThrow(LlmNotConfiguredError);
    expect(() => svc.getModel("standard")).toThrow(LlmNotConfiguredError);
    expect(() => svc.getModel("complex")).toThrow(LlmNotConfiguredError);
  });

  it("unexpected errors during provider init still propagate", async () => {
    // Throws on the first call — init bails before trying the other tiers
    vi.mocked(createModel).mockRejectedValueOnce(new Error("unexpected network failure"));

    const svc = new LlmService();
    await expect(svc.init(validConfig, fakeSecrets)).rejects.toThrow("unexpected network failure");
  });

  it("threads the injected logger into tier fallback chains", async () => {
    const transient = new APICallError({
      message: "503",
      url: "https://provider.test",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    const rejecting = (entry: { provider: string; model: string }) =>
      Promise.resolve({
        specificationVersion: "v4",
        provider: entry.provider,
        modelId: entry.model,
        supportedUrls: {},
        doGenerate: vi.fn().mockRejectedValue(transient),
        doStream: vi.fn(),
      } as unknown as LanguageModelV4);
    // Only the two quick-tier providers reject; standard/complex use the default mock.
    vi.mocked(createModel).mockImplementationOnce(rejecting).mockImplementationOnce(rejecting);

    const twoProviderConfig = {
      tiers: {
        quick: {
          providers: [
            { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "key" },
            { provider: "openai", model: "gpt-4o-mini", api_key_ref: "key" },
          ],
        },
        standard: validConfig.tiers.standard,
        complex: validConfig.tiers.complex,
      },
    };

    const logger = { warn: vi.fn() };
    const svc = new LlmService();
    await svc.init(twoProviderConfig, fakeSecrets, logger);
    await expect(
      (svc.getModel("quick") as LanguageModelV4).doGenerate({} as LanguageModelV4CallOptions)
    ).rejects.toBe(transient);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("LlmService.select", () => {
  const init = async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    return svc;
  };

  it("model auto + supervised resolves to standard", async () => {
    const svc = await init();
    expect((svc.select({ model: "auto", autonomy: "supervised" }) as LanguageModelV4).modelId).toBe(
      "claude-sonnet-4-6"
    );
  });

  it("explicit tier overrides auto rules (AC3)", async () => {
    const svc = await init();
    expect((svc.select({ model: "complex", autonomy: "full" }) as LanguageModelV4).modelId).toBe(
      "claude-opus-4-8"
    );
  });

  it("session model overrides configured tier for the turn (AC4)", async () => {
    const svc = await init();
    expect(
      (svc.select({ model: "complex", sessionModel: "quick" }) as LanguageModelV4).modelId
    ).toBe("claude-haiku-4-5");
  });

  it("raw model id bypasses tiers via getModelById", async () => {
    const svc = await init();
    expect((svc.select({ model: "claude-opus-4-8" }) as LanguageModelV4).modelId).toBe(
      "claude-opus-4-8"
    );
  });

  it("unknown raw model id throws UnknownModelError", async () => {
    const svc = await init();
    expect(() => svc.select({ sessionModel: "no-such-model" })).toThrow(UnknownModelError);
  });

  it("defaults to auto → standard when no model given", async () => {
    const svc = await init();
    expect((svc.select({}) as LanguageModelV4).modelId).toBe("claude-sonnet-4-6");
  });

  it("select before init throws LlmNotConfiguredError", () => {
    const svc = new LlmService();
    expect(() => svc.select({ model: "auto" })).toThrow(LlmNotConfiguredError);
  });
});

describe("LlmService.resolve", () => {
  // A tier with two providers so chain ordering (config order) is observable.
  const multiConfig = {
    tiers: {
      quick: {
        providers: [
          { provider: "azure", model: "gpt-4o-mini", api_key_ref: "key" },
          { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "key" },
        ],
      },
      standard: {
        providers: [{ provider: "anthropic", model: "claude-sonnet-4-6", api_key_ref: "key" }],
      },
      complex: {
        providers: [{ provider: "anthropic", model: "claude-opus-4-8", api_key_ref: "key" }],
      },
    },
  };
  const init = async () => {
    const svc = new LlmService();
    await svc.init(multiConfig, fakeSecrets);
    return svc;
  };

  it("resolves a tier with its ordered provider/model chain + primary id", async () => {
    const r = (await init()).resolve({ model: "quick" });
    expect(r.tier).toBe("quick");
    expect(r.modelId).toBe("gpt-4o-mini");
    expect(r.chain).toEqual([
      { provider: "azure", modelId: "gpt-4o-mini" },
      { provider: "anthropic", modelId: "claude-haiku-4-5" },
    ]);
  });

  it("auto selection carries tier metadata", async () => {
    const r = (await init()).resolve({ model: "auto", autonomy: "supervised" });
    expect(r.tier).toBe("standard");
    expect(r.modelId).toBe("claude-sonnet-4-6");
  });

  it("raw model id resolves to a single-entry chain with provider, no tier", async () => {
    const r = (await init()).resolve({ model: "claude-opus-4-8" });
    expect(r.tier).toBeUndefined();
    expect(r.modelId).toBe("claude-opus-4-8");
    expect(r.chain).toEqual([{ provider: "anthropic", modelId: "claude-opus-4-8" }]);
  });

  it("unknown raw model id throws UnknownModelError", async () => {
    const svc = await init();
    expect(() => svc.resolve({ model: "no-such-model" })).toThrow(UnknownModelError);
  });
});
