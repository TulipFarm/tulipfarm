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
  it("init builds providers and an effort preset resolves to a model", async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    const model = svc.effortModel("fast");
    expect(model).toBeDefined();
  });

  it("every effort preset resolves once its providers are configured", async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    expect(svc.effortModel("fast")).toBeDefined();
    expect(svc.effortModel("balanced")).toBeDefined();
    expect(svc.effortModel("thorough")).toBeDefined();
  });

  it("null config skips init without throwing", async () => {
    const svc = new LlmService();
    await expect(svc.init(null, fakeSecrets)).resolves.toBeUndefined();
  });

  it("asking for a model before init throws LlmNotConfiguredError", () => {
    const svc = new LlmService();
    expect(() => svc.effortModel("fast")).toThrow(LlmNotConfiguredError);
  });

  it("asking for a model after a null config throws LlmNotConfiguredError", async () => {
    const svc = new LlmService();
    await svc.init(null, fakeSecrets);
    expect(() => svc.effortModel("fast")).toThrow(LlmNotConfiguredError);
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
    expect(svc.effortModel("fast")).toBeDefined();
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
    expect(() => svc.effortModel("fast")).toThrow(LlmNotConfiguredError);
    expect(svc.effortModel("balanced")).toBeDefined();
    expect(svc.effortModel("thorough")).toBeDefined();
  });

  it("LlmCredentialError on all tiers disables LLM without throwing", async () => {
    // validConfig has 1 provider per tier = 3 calls total
    vi.mocked(createModel)
      .mockRejectedValueOnce(new LlmCredentialError("secret not found: key"))
      .mockRejectedValueOnce(new LlmCredentialError("secret not found: key"))
      .mockRejectedValueOnce(new LlmCredentialError("secret not found: key"));

    const svc = new LlmService();
    await expect(svc.init(validConfig, fakeSecrets)).resolves.toBeUndefined();
    expect(() => svc.effortModel("fast")).toThrow(LlmNotConfiguredError);
    expect(() => svc.effortModel("balanced")).toThrow(LlmNotConfiguredError);
    expect(() => svc.effortModel("thorough")).toThrow(LlmNotConfiguredError);
  });

  it("unexpected errors during provider init still propagate", async () => {
    // Throws on the first call — init bails before trying the other tiers
    vi.mocked(createModel).mockRejectedValueOnce(new Error("unexpected network failure"));

    const svc = new LlmService();
    await expect(svc.init(validConfig, fakeSecrets)).rejects.toThrow("unexpected network failure");
  });

  it("threads the injected logger into preset fallback chains", async () => {
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
      (svc.effortModel("fast") as LanguageModelV4).doGenerate({} as LanguageModelV4CallOptions)
    ).rejects.toBe(transient);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("LlmService.effortModel", () => {
  it("serves a preset from the derived profile catalog", async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    expect(svc.effortModel("fast")).toBeDefined();
    expect(svc.effortModel("balanced")).toBeDefined();
    expect(svc.effortModel("thorough")).toBeDefined();
  });

  it("resolves auto without a configured preset map", async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    expect(svc.effortModel("auto")).toBeDefined();
  });

  it("honours the Soul's preset map over the preset's own name", async () => {
    const svc = new LlmService();
    await svc.init({ ...validConfig, presets: { fast: "thorough" } }, fakeSecrets);
    // "fast" is mapped to the thorough profile, so the opus chain must serve it.
    expect(svc.effortModel("fast")).toMatchObject({ modelId: "claude-opus-4-8" });
  });

  it("accepts a retired tier name as its effort preset", async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    expect(svc.effortModel("quick")).toMatchObject({ modelId: "claude-haiku-4-5" });
  });

  it("chains every provider configured for the preset, not just the first", async () => {
    const svc = new LlmService();
    await svc.init(
      {
        tiers: {
          quick: {
            providers: [
              { provider: "anthropic", model: "haiku", api_key_ref: "key" },
              { provider: "openai", model: "mini", api_key_ref: "key" },
            ],
          },
          standard: {
            providers: [{ provider: "anthropic", model: "sonnet", api_key_ref: "key" }],
          },
          complex: {
            providers: [{ provider: "anthropic", model: "opus", api_key_ref: "key" }],
          },
        },
      },
      fakeSecrets
    );

    expect(svc.effortModel("fast")).toMatchObject({ modelId: "haiku|mini" });
  });

  it("refuses rather than substituting a weaker chain when the preset's providers fail", async () => {
    // The thorough tier's only provider has bad credentials, so nothing serves that effort.
    // Refusing is the point: quietly answering a deliberate ask for more effort with the balanced
    // chain is exactly the silent downgrade this convergence exists to prevent.
    vi.mocked(createModel).mockImplementation((entry) => {
      if (entry.model === "opus") return Promise.reject(new LlmCredentialError("no key"));
      return Promise.resolve({
        specificationVersion: "v4",
        provider: entry.provider,
        modelId: entry.model,
        supportedUrls: {},
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      } as unknown as LanguageModelV4);
    });

    const svc = new LlmService();
    await svc.init(
      {
        tiers: {
          quick: { providers: [{ provider: "anthropic", model: "haiku", api_key_ref: "key" }] },
          standard: { providers: [{ provider: "anthropic", model: "sonnet", api_key_ref: "key" }] },
          complex: { providers: [{ provider: "anthropic", model: "opus", api_key_ref: "key" }] },
        },
      },
      fakeSecrets
    );
    vi.mocked(createModel).mockReset();

    expect(() => svc.effortModel("thorough")).toThrow(LlmNotConfiguredError);
    expect(svc.effortModel("balanced")).toMatchObject({ modelId: "sonnet" });
  });

  it("treats a raw model id as itself, never as a preset", async () => {
    const svc = new LlmService();
    await svc.init(validConfig, fakeSecrets);
    expect(svc.effortModel("claude-opus-4-8")).toMatchObject({ modelId: "claude-opus-4-8" });
    expect(() => svc.effortModel("no-such-model")).toThrow(UnknownModelError);
  });
});
