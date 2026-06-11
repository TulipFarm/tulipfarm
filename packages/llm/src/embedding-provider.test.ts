import { describe, expect, it, vi } from "vitest";
import { LlmConfigValidationError } from "./config";
import { createEmbeddingModel } from "./embedding-provider";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({
    textEmbeddingModel: (modelId: string) => ({ provider: "openai", modelId }),
  })),
}));

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn(({ resourceName, baseURL }: { resourceName?: string; baseURL?: string }) => ({
    textEmbeddingModel: (modelId: string) => ({
      provider: "azure",
      modelId,
      resourceName,
      baseURL,
    }),
  })),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(({ name, apiKey }: { name: string; apiKey?: string }) => ({
    textEmbeddingModel: (modelId: string) => ({ provider: name, modelId, apiKey }),
  })),
}));

const makeSecrets = (values: Record<string, string> = {}) => ({
  get: vi.fn((key: string) => {
    if (key in values) return Promise.resolve(values[key]);
    return Promise.reject(new Error(`secret not found: ${key}`));
  }),
});

describe("createEmbeddingModel", () => {
  it("creates an openai embedding model with a logical api_key_ref", async () => {
    const secrets = makeSecrets({ "openai-api-key": "sk-test" });
    const model = await createEmbeddingModel(
      { provider: "openai", model: "text-embedding-3-small", api_key_ref: "openai-api-key" },
      secrets as never
    );
    expect(model).toMatchObject({ provider: "openai", modelId: "text-embedding-3-small" });
    expect(secrets.get).toHaveBeenCalledWith("openai-api-key");
  });

  it("creates an openai embedding model with an env:// api_key_ref", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    const secrets = makeSecrets();
    const model = await createEmbeddingModel(
      { provider: "openai", model: "text-embedding-3-small", api_key_ref: "env://OPENAI_API_KEY" },
      secrets as never
    );
    expect(model).toMatchObject({ provider: "openai" });
    expect(secrets.get).not.toHaveBeenCalled();
    delete process.env.OPENAI_API_KEY;
  });

  it("creates an azure embedding model from resource_name", async () => {
    const secrets = makeSecrets({ "azure-key": "az-test" });
    const model = await createEmbeddingModel(
      {
        provider: "azure",
        model: "my-embed-deployment",
        resource_name: "my-resource",
        api_key_ref: "azure-key",
      },
      secrets as never
    );
    expect(model).toMatchObject({
      provider: "azure",
      modelId: "my-embed-deployment",
      resourceName: "my-resource",
    });
  });

  it("creates an azure embedding model from base_url when resource_name is absent", async () => {
    const secrets = makeSecrets({ "azure-key": "az-test" });
    const model = await createEmbeddingModel(
      {
        provider: "azure",
        model: "my-embed-deployment",
        base_url: "https://my.openai.azure.com/openai",
        api_key_ref: "azure-key",
      },
      secrets as never
    );
    expect(model).toMatchObject({ provider: "azure" });
  });

  it("throws when azure has neither resource_name nor base_url", async () => {
    const secrets = makeSecrets();
    await expect(
      createEmbeddingModel({ provider: "azure", model: "d" }, secrets as never)
    ).rejects.toThrow(LlmConfigValidationError);
    await expect(
      createEmbeddingModel({ provider: "azure", model: "d" }, secrets as never)
    ).rejects.toThrow("azure provider requires resource_name or base_url");
  });

  it("creates an openai-compatible embedding model with base_url", async () => {
    const secrets = makeSecrets();
    const model = await createEmbeddingModel(
      { provider: "openai-compatible", model: "bge-m3", base_url: "http://host/v1" },
      secrets as never
    );
    expect(model).toMatchObject({ provider: "openai-compatible", modelId: "bge-m3" });
  });

  it("throws when openai-compatible is missing base_url", async () => {
    const secrets = makeSecrets();
    await expect(
      createEmbeddingModel({ provider: "openai-compatible", model: "bge-m3" }, secrets as never)
    ).rejects.toThrow(LlmConfigValidationError);
  });

  it("creates an ollama embedding model with a placeholder key and no credentials", async () => {
    const secrets = makeSecrets();
    const model = await createEmbeddingModel(
      { provider: "ollama", model: "nomic-embed-text", base_url: "http://localhost:11434/v1" },
      secrets as never
    );
    expect(model).toMatchObject({
      provider: "ollama",
      modelId: "nomic-embed-text",
      apiKey: "ollama",
    });
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("throws when ollama is missing base_url", async () => {
    const secrets = makeSecrets();
    await expect(
      createEmbeddingModel({ provider: "ollama", model: "nomic-embed-text" }, secrets as never)
    ).rejects.toThrow(LlmConfigValidationError);
  });

  it("throws LlmConfigValidationError for an unknown provider", async () => {
    const secrets = makeSecrets();
    await expect(
      createEmbeddingModel({ provider: "cohere", model: "embed-v3" }, secrets as never)
    ).rejects.toThrow("unknown embedding provider: cohere");
  });
});
