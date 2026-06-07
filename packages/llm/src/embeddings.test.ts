import { SecretUnavailableError } from "@tulipfarm/secrets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_UNAVAILABLE_WARNING, EmbeddingUnavailableError } from "./config";
import { EmbeddingService } from "./embeddings";

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
    expect(svc.consumePendingReindex()).toBe(false);

    await svc.init(embCfg(768), secrets as never, logger);
    expect(svc.consumePendingReindex()).toBe(true);
    // flag is cleared after being consumed
    expect(svc.consumePendingReindex()).toBe(false);
  });

  it("is unavailable when no embeddings section is configured (backward compat)", async () => {
    const svc = new EmbeddingService();
    await svc.init(cfg(undefined), makeSecrets() as never, logger);
    expect(svc.isAvailable()).toBe(false);
  });
});
