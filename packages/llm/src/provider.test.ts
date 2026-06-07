import { describe, expect, it, vi } from "vitest";
import { LlmConfigValidationError } from "./config";
import { createModel } from "./provider";

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ provider: "anthropic", modelId })),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => (modelId: string) => ({ provider: "openai", modelId })),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(({ name }: { name: string }) => (modelId: string) => ({
    provider: name,
    modelId,
  })),
}));

const makeSecrets = (values: Record<string, string> = {}) => ({
  get: vi.fn((key: string) => {
    if (key in values) return Promise.resolve(values[key]);
    return Promise.reject(new Error(`secret not found: ${key}`));
  }),
});

describe("createModel", () => {
  it("creates anthropic model with logical api_key_ref", async () => {
    const secrets = makeSecrets({ "anthropic-api-key": "sk-ant-test" });
    const model = await createModel(
      { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "anthropic-api-key" },
      secrets as never
    );
    expect(model.provider).toBe("anthropic");
    expect(model.modelId).toBe("claude-haiku-4-5");
    expect(secrets.get).toHaveBeenCalledWith("anthropic-api-key");
  });

  it("creates openai model with env:// api_key_ref", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const secrets = makeSecrets();
    const model = await createModel(
      { provider: "openai", model: "gpt-4o", api_key_ref: "env://OPENAI_API_KEY" },
      secrets as never
    );
    expect(model.provider).toBe("openai");
    expect(secrets.get).not.toHaveBeenCalled();
    // biome-ignore lint/performance/noDelete: must remove env var to avoid polluting other tests
    delete process.env.OPENAI_API_KEY;
  });

  it("creates openai-compatible model with base_url", async () => {
    const secrets = makeSecrets();
    const model = await createModel(
      { provider: "openai-compatible", model: "llama3", base_url: "http://localhost:11434/v1" },
      secrets as never
    );
    expect(model.modelId).toBe("llama3");
  });

  it("throws LlmConfigValidationError for unknown provider", async () => {
    const secrets = makeSecrets();
    await expect(
      createModel({ provider: "grok", model: "grok-1" }, secrets as never)
    ).rejects.toThrow(LlmConfigValidationError);
    await expect(
      createModel({ provider: "grok", model: "grok-1" }, secrets as never)
    ).rejects.toThrow("unknown provider: grok");
  });

  it("throws LlmConfigValidationError when env:// var is not set", async () => {
    // biome-ignore lint/performance/noDelete: must ensure env var is absent for this test
    delete process.env.MISSING_VAR;
    const secrets = makeSecrets();
    await expect(
      createModel(
        { provider: "openai", model: "gpt-4o", api_key_ref: "env://MISSING_VAR" },
        secrets as never
      )
    ).rejects.toThrow(LlmConfigValidationError);
    await expect(
      createModel(
        { provider: "openai", model: "gpt-4o", api_key_ref: "env://MISSING_VAR" },
        secrets as never
      )
    ).rejects.toThrow("env var MISSING_VAR not set");
  });

  it("throws LlmConfigValidationError when openai-compatible missing base_url", async () => {
    const secrets = makeSecrets();
    await expect(
      createModel({ provider: "openai-compatible", model: "llama3" }, secrets as never)
    ).rejects.toThrow(LlmConfigValidationError);
  });
});
