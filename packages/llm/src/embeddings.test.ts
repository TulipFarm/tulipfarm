import { EmbeddingUnavailableError } from "@tulipfarm/schema";
import { SecretUnavailableError } from "@tulipfarm/secrets";
import { embedMany as sdkEmbedMany } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_UNAVAILABLE_WARNING,
  type EmbeddingCallUsage,
  EmbeddingService,
} from "./embeddings";

const embedManyMock = vi.mocked(sdkEmbedMany);

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({
    textEmbeddingModel: (modelId: string) => ({ provider: "openai", modelId }),
  })),
}));

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn(() => ({
    textEmbeddingModel: (modelId: string) => ({ provider: "azure", modelId }),
  })),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(({ name }: { name: string }) => ({
    textEmbeddingModel: (modelId: string) => ({ provider: name, modelId }),
  })),
}));

vi.mock("ai", () => ({
  embedMany: vi.fn(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => [0.1, 0.2, 0.3]),
    usage: { tokens: 11 },
  })),
}));

const TIER = { providers: [{ provider: "anthropic", model: "claude-haiku-4-5" }] };
type EmbProvider = Record<string, unknown>;
const cfg = (embeddings?: { providers: EmbProvider[] }) => ({
  tiers: { quick: TIER, standard: TIER, complex: TIER },
  embeddings,
});

const makeSecrets = (values: Record<string, string> = {}) => ({
  get: vi.fn((key: string) => {
    if (key in values) return Promise.resolve(values[key]);
    return Promise.reject(new SecretUnavailableError(`secret not found: ${key}`));
  }),
});

const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
  embedManyMock.mockReset();
  embedManyMock.mockImplementation(
    async ({ values }: { values: string[] }) =>
      ({
        embeddings: values.map(() => [0.1, 0.2, 0.3]),
        usage: { tokens: 11 },
      }) as never
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EmbeddingService", () => {
  it("uses OpenAI embeddings when the key is configured (AC1)", async () => {
    const svc = new EmbeddingService();
    const secrets = makeSecrets({ "openai-api-key": "sk-test" });
    await svc.init(
      cfg({
        providers: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            api_key_ref: "openai-api-key",
            dimension: 1536,
          },
        ],
      }),
      secrets as never,
      logger
    );

    expect(svc.isAvailable()).toBe(true);
    expect(svc.getActive()).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimension: 1536,
    });

    const { embeddings } = await svc.embedMany(["a", "b"]);
    expect(embeddings).toHaveLength(2);
  });

  it("falls back to Ollama when no cloud key but Ollama is reachable (AC2)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok"))
    );
    const svc = new EmbeddingService();
    const secrets = makeSecrets(); // openai-api-key absent → cloud skipped

    await svc.init(
      cfg({
        providers: [
          { provider: "openai", model: "text-embedding-3-small", api_key_ref: "openai-api-key" },
          {
            provider: "ollama",
            model: "nomic-embed-text",
            base_url: "http://localhost:11434/v1",
            dimension: 768,
          },
        ],
      }),
      secrets as never,
      logger
    );

    expect(svc.isAvailable()).toBe(true);
    expect(svc.getActive()).toMatchObject({ provider: "ollama", dimension: 768 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("is unavailable (lexical fallback) when neither cloud nor Ollama is usable (AC3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED")))
    );
    const svc = new EmbeddingService();
    const secrets = makeSecrets();

    await svc.init(
      cfg({
        providers: [
          { provider: "openai", model: "text-embedding-3-small", api_key_ref: "openai-api-key" },
          { provider: "ollama", model: "nomic-embed-text", base_url: "http://localhost:11434/v1" },
        ],
      }),
      secrets as never,
      logger
    );

    expect(svc.isAvailable()).toBe(false);
    expect(svc.getActive()).toBeNull();
    await expect(svc.embedMany(["x"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(EMBEDDING_UNAVAILABLE_WARNING).toBe("embedding-unavailable");
  });

  it("flags a full re-index when the embedding dimension changes (AC4)", async () => {
    const svc = new EmbeddingService();
    const secrets = makeSecrets({ "openai-api-key": "sk-test" });
    const embCfg = (dimension: number) =>
      cfg({
        providers: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            api_key_ref: "openai-api-key",
            dimension,
          },
        ],
      });

    await svc.init(embCfg(1536), secrets as never, logger);
    expect(svc.pendingReindex()).toBe(false);

    await svc.init(embCfg(768), secrets as never, logger);
    expect(svc.pendingReindex()).toBe(true);
    // Reading the flag must not clear it: a re-index that then fails has to be retried.
    expect(svc.pendingReindex()).toBe(true);
    svc.clearPendingReindex();
    expect(svc.pendingReindex()).toBe(false);
  });

  it("is unavailable when no embeddings section is configured (backward compat)", async () => {
    const svc = new EmbeddingService();
    await svc.init(cfg(undefined), makeSecrets() as never, logger);
    expect(svc.isAvailable()).toBe(false);
  });
});

describe("EmbeddingService — per-call failover", () => {
  const twoProviders = (secondDimension: number) =>
    cfg({
      providers: [
        {
          provider: "openai",
          model: "text-embedding-3-small",
          api_key_ref: "openai-api-key",
          dimension: 1536,
        },
        {
          provider: "azure",
          model: "text-embedding-3-small",
          api_key_ref: "azure-api-key",
          resource_name: "test-resource",
          dimension: secondDimension,
        },
      ],
    });

  const bothKeys = () =>
    makeSecrets({ "openai-api-key": "sk-test", "azure-api-key": "az-test" }) as never;

  it("falls back to a same-width standby when the active provider fails", async () => {
    const svc = new EmbeddingService();
    await svc.init(twoProviders(1536), bothKeys(), logger);

    embedManyMock.mockRejectedValueOnce(new Error("503 upstream"));
    const out = await svc.embedMany(["a"]);

    expect(out.embeddings).toHaveLength(1);
    expect(embedManyMock).toHaveBeenCalledTimes(2);
    expect(embedManyMock.mock.calls[1]?.[0].model).toMatchObject({ provider: "azure" });
  });

  it("refuses a standby of a different width, because its vectors would be unsearchable", async () => {
    const svc = new EmbeddingService();
    await svc.init(twoProviders(768), bothKeys(), logger);

    embedManyMock.mockRejectedValueOnce(new Error("503 upstream"));
    await expect(svc.embedMany(["a"])).rejects.toThrow("503 upstream");
    expect(embedManyMock).toHaveBeenCalledTimes(1);
  });

  it("skips a provider that just failed instead of retrying it every call", async () => {
    let clock = 1000;
    const svc = new EmbeddingService({ demoteMs: 60_000, now: () => clock });
    await svc.init(twoProviders(1536), bothKeys(), logger);

    embedManyMock.mockRejectedValueOnce(new Error("503 upstream"));
    await svc.embedMany(["a"]);
    expect(embedManyMock).toHaveBeenCalledTimes(2);

    clock += 1_000;
    await svc.embedMany(["b"]);
    // Third call overall: the demoted primary is skipped, not retried.
    expect(embedManyMock).toHaveBeenCalledTimes(3);
    expect(embedManyMock.mock.calls[2]?.[0].model).toMatchObject({ provider: "azure" });

    clock += 120_000;
    await svc.embedMany(["c"]);
    expect(embedManyMock.mock.calls[3]?.[0].model).toMatchObject({ provider: "openai" });
  });

  it("does not treat caller cancellation as a provider failure", async () => {
    const svc = new EmbeddingService();
    await svc.init(twoProviders(1536), bothKeys(), logger);

    const controller = new AbortController();
    controller.abort();
    embedManyMock.mockRejectedValueOnce(new Error("aborted"));

    await expect(svc.embedMany(["a"], controller.signal)).rejects.toThrow("aborted");
    expect(embedManyMock).toHaveBeenCalledTimes(1);
  });

  it("bounds every call with a timeout signal", async () => {
    const svc = new EmbeddingService({ timeoutMs: 25 });
    await svc.init(twoProviders(1536), bothKeys(), logger);

    embedManyMock.mockImplementationOnce(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(new Error("timed out")));
        }) as never
    );

    const out = await svc.embedMany(["a"]);
    expect(out.embeddings).toHaveLength(1);
    expect(embedManyMock.mock.calls[1]?.[0].model).toMatchObject({ provider: "azure" });
  });

  it("reports usage for every call so embedding spend can be priced", async () => {
    const recorded: EmbeddingCallUsage[] = [];
    const svc = new EmbeddingService({ usage: { record: (u) => recorded.push(u) } });
    await svc.init(
      cfg({
        providers: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            api_key_ref: "openai-api-key",
            dimension: 1536,
            spec: { input_cost_per_token: 0.00000002, output_cost_per_token: 0 },
          },
        ],
      }),
      makeSecrets({ "openai-api-key": "sk-test" }) as never,
      logger
    );

    await svc.embedMany(["a", "b"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      tokens: 11,
      values: 2,
    });
    expect(recorded[0]?.spec?.input_cost_per_token).toBe(0.00000002);
  });

  it("corrects a wrongly declared width from what the provider actually returns", async () => {
    const svc = new EmbeddingService();
    await svc.init(
      cfg({
        providers: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            api_key_ref: "openai-api-key",
            dimension: 1536,
          },
        ],
      }),
      makeSecrets({ "openai-api-key": "sk-test" }) as never,
      logger
    );

    // The mock answers with 3-wide vectors; `dim` is stored and queried on exact match, so the
    // declared 1536 is a lie the guard must not keep believing.
    await svc.embedMany(["a"]);
    expect(svc.getDimension()).toBe(3);
    expect(svc.pendingReindex()).toBe(true);
  });
});
