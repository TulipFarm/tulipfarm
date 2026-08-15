import { createAnthropic } from "@ai-sdk/anthropic";
import { LlmConfigValidationError, LlmCredentialError } from "@tulipfarm/schema";
import { DecryptError, SecretUnavailableError } from "@tulipfarm/secrets";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModel } from "./provider";
import { ClassifiedLanguageModel, classifyProviderError, LlmProviderError } from "./provider-error";

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

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn((opts: { resourceName?: string }) => (modelId: string) => ({
    provider: "azure",
    modelId,
    resourceName: opts.resourceName,
  })),
}));

const makeSecrets = (values: Record<string, string> = {}) => ({
  get: vi.fn((key: string) => {
    if (key in values) return Promise.resolve(values[key]);
    // Mirror the real SecretsService: an unavailable key throws SecretUnavailableError (so config
    // lookups treat it as "unset" and required keys surface as LlmCredentialError).
    return Promise.reject(new SecretUnavailableError(`secret not found: ${key}`));
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

  it("creates an azure model with resource_name + api_key_ref", async () => {
    const secrets = makeSecrets({ "azure-openai-api-key": "az-test" });
    const model = await createModel(
      {
        provider: "azure",
        model: "gpt-4o",
        api_key_ref: "azure-openai-api-key",
        resource_name: "my-resource",
      },
      secrets as never
    );
    expect(model.provider).toBe("azure");
    expect(model.modelId).toBe("gpt-4o");
    // resourceName is passed through createAzure by the mock (not part of LanguageModelV1).
    expect((model as unknown as { resourceName: string }).resourceName).toBe("my-resource");
    expect(secrets.get).toHaveBeenCalledWith("azure-openai-api-key");
  });

  it("throws LlmConfigValidationError when azure has a key but no resource_name or base_url", async () => {
    // Key present (so resolution gets past the api key) but no resource_name/base_url configured.
    const secrets = makeSecrets({ "azure-openai-api-key": "az-test" });
    await expect(
      createModel({ provider: "azure", model: "gpt-4o" }, secrets as never)
    ).rejects.toThrow("azure provider requires resource_name or base_url");
  });

  it("resolves anthropic's key from the registry when api_key_ref is omitted", async () => {
    const secrets = makeSecrets({ "anthropic-api-key": "sk-ant" });
    const model = await createModel(
      { provider: "anthropic", model: "claude-haiku-4-5" },
      secrets as never
    );
    expect(model.provider).toBe("anthropic");
    expect(secrets.get).toHaveBeenCalledWith("anthropic-api-key");
  });

  it("resolves azure's key + resource_name from the registry store (row is just provider+model)", async () => {
    const secrets = makeSecrets({
      "azure-openai-api-key": "az-test",
      "azure-openai-resource-name": "my-resource",
    });
    const model = await createModel({ provider: "azure", model: "gpt-4o" }, secrets as never);
    expect(model.provider).toBe("azure");
    expect((model as unknown as { resourceName: string }).resourceName).toBe("my-resource");
    expect(secrets.get).toHaveBeenCalledWith("azure-openai-api-key");
    expect(secrets.get).toHaveBeenCalledWith("azure-openai-resource-name");
  });

  it("resolves openai-compatible base_url from the registry store; keyless when no key stored", async () => {
    const secrets = makeSecrets({ "openai-compatible-base-url": "http://localhost:11434/v1" });
    const model = await createModel(
      { provider: "openai-compatible", model: "llama3" },
      secrets as never
    );
    expect(model.modelId).toBe("llama3");
  });

  it("wraps SecretUnavailableError as LlmCredentialError naming the key + hint (AC3)", async () => {
    const secrets = {
      get: vi.fn(() =>
        Promise.reject(new SecretUnavailableError("secret not found: anthropic-api-key"))
      ),
    };
    const promise = createModel(
      { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "anthropic-api-key" },
      secrets as never
    );
    await expect(promise).rejects.toBeInstanceOf(LlmCredentialError);
    await expect(promise).rejects.toThrow("anthropic-api-key");
    await expect(promise).rejects.toThrow(/env:\/\/|\/secrets\//);
  });

  it("never leaks the resolved credential value in the error (AC4)", async () => {
    // get() throws *before* any value exists, but assert the secret value can never appear.
    const secretValue = "sk-ant-supersecret-value";
    const secrets = {
      get: vi.fn(() =>
        Promise.reject(new SecretUnavailableError("secret not found: anthropic-api-key"))
      ),
    };
    let err: Error | undefined;
    try {
      await createModel(
        { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "anthropic-api-key" },
        secrets as never
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(LlmCredentialError);
    expect(err?.message).not.toContain(secretValue);
    expect(err?.stack ?? "").not.toContain(secretValue);
  });

  it("does not log the resolved credential value on success (AC4)", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secretValue = "sk-ant-supersecret-value";
    const secrets = makeSecrets({ "anthropic-api-key": secretValue });
    await createModel(
      { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "anthropic-api-key" },
      secrets as never
    );
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(" ");
    expect(logged).not.toContain(secretValue);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("propagates non-SecretUnavailableError from secrets.get unchanged", async () => {
    const boom = new TypeError("unexpected internal failure");
    const secrets = { get: vi.fn(() => Promise.reject(boom)) };
    await expect(
      createModel(
        { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "anthropic-api-key" },
        secrets as never
      )
    ).rejects.toBe(boom);
  });

  it("converts a DecryptError (stale key) into LlmCredentialError so init skips the provider", async () => {
    const secrets = {
      get: vi.fn(() => Promise.reject(new DecryptError("unable to decrypt secret"))),
    };
    await expect(
      createModel(
        { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "anthropic-api-key" },
        secrets as never
      )
    ).rejects.toBeInstanceOf(LlmCredentialError);
  });
});

describe("createModel — whose credential the call spends", () => {
  const ENTRY = {
    provider: "anthropic" as const,
    model: "claude-haiku-4-5",
    api_key_ref: "shared-key",
  };
  const ALICE = { kind: "user", id: "alice" };

  /** The key handed to the provider SDK, which is what actually authenticates the call. */
  function spentKey(): string | undefined {
    const calls = vi.mocked(createAnthropic).mock.calls;
    return (calls.at(-1)?.[0] as { apiKey?: string } | undefined)?.apiKey;
  }

  beforeEach(() => {
    vi.mocked(createAnthropic).mockClear();
  });

  it("spends the principal's own credential when they hold one", async () => {
    // Every model call used to act as the deployment, so one key served every principal and the
    // provider's own ACLs never entered the decision.
    const secrets = makeSecrets({ "shared-key": "sk-deployment" });
    await createModel(ENTRY, secrets as never, {
      principal: ALICE,
      credentials: { resolve: async () => "sk-alice" },
    });

    expect(spentKey()).toBe("sk-alice");
  });

  it("falls back to the deployment credential when the principal holds none", async () => {
    // Most principals have connected nothing; refusing here would break every such deployment.
    const secrets = makeSecrets({ "shared-key": "sk-deployment" });
    await createModel(ENTRY, secrets as never, {
      principal: ALICE,
      credentials: { resolve: async () => undefined },
    });

    expect(spentKey()).toBe("sk-deployment");
  });

  it("spends the deployment credential when no principal was named", async () => {
    const secrets = makeSecrets({ "shared-key": "sk-deployment" });
    await createModel(ENTRY, secrets as never, {});

    expect(spentKey()).toBe("sk-deployment");
  });
});

/**
 * L5-U. The API branches wrap in `ClassifiedLanguageModel`; the two CLI branches deliberately do
 * not, because a CLI turn already fails as `Error`/`LlmProviderError` rather than `APICallError`
 * and `classifyProviderError` reads those directly. That is correct today and invisible tomorrow:
 * dropping a wrap from an API branch would silently collapse every retryable provider failure to
 * `model_error`, and the suite would stay green. These pin the shape, not new behaviour.
 */
describe("createModel — provider error classification is wrapped for API providers only", () => {
  const secrets = () =>
    makeSecrets({
      "anthropic-api-key": "k",
      "openai-api-key": "k",
      "azure-api-key": "k",
      "compat-api-key": "k",
      "claude-code-key": "k",
      "codex-key": "{}",
    }) as never;

  const API_ENTRIES = [
    { provider: "anthropic", model: "claude-haiku-4-5", api_key_ref: "anthropic-api-key" },
    { provider: "openai", model: "gpt-4o-mini", api_key_ref: "openai-api-key" },
    {
      provider: "openai-compatible",
      model: "m",
      api_key_ref: "compat-api-key",
      base_url: "http://localhost:1234/v1",
    },
    {
      provider: "azure",
      model: "m",
      api_key_ref: "azure-api-key",
      resource_name: "res",
    },
  ];

  it.each(API_ENTRIES)("wraps $provider so APICallError is classified", async (entry) => {
    const model = await createModel(entry, secrets());
    expect(model).toBeInstanceOf(ClassifiedLanguageModel);
  });

  it("leaves claude-code unwrapped, and classification still recognises its errors", async () => {
    const model = await createModel(
      { provider: "claude-code", model: "sonnet", api_key_ref: "claude-code-key" },
      secrets()
    );
    expect(model).not.toBeInstanceOf(ClassifiedLanguageModel);
    expect(classifyProviderError(new LlmProviderError("model_not_found", "no model"))).toBe(
      "model_not_found"
    );
  });

  it("leaves codex unwrapped, and classification still recognises its errors", async () => {
    const model = await createModel(
      { provider: "codex", model: "gpt-5", api_key_ref: "codex-key" },
      secrets()
    );
    expect(model).not.toBeInstanceOf(ClassifiedLanguageModel);
    expect(classifyProviderError(new LlmProviderError("model_authentication_failed", "401"))).toBe(
      "model_authentication_failed"
    );
  });
});
