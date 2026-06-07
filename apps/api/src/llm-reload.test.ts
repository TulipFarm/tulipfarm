import { EventEmitter } from "node:events";
import type { EmbeddingService, LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import type { Logger, SoulLoader } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { registerLlmReload } from "./llm-reload";

function setup(overrides: { reload?: () => Promise<void>; init?: () => Promise<void> } = {}) {
  const gitSync = new EventEmitter();
  const calls: string[] = [];
  const llmConfig = { tiers: {} };
  const soulLoader = {
    llmConfig,
    reload: vi.fn(async () => {
      calls.push("reload");
      await (overrides.reload?.() ?? Promise.resolve());
    }),
  } as unknown as SoulLoader;
  const llmService = {
    init: vi.fn(async () => {
      calls.push("init");
      await (overrides.init?.() ?? Promise.resolve());
    }),
  } as unknown as LlmService;
  const embeddingService = {
    init: vi.fn(async () => {
      calls.push("embeddings.init");
    }),
  } as unknown as EmbeddingService;
  const secrets = {} as SecretsService;
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  registerLlmReload(gitSync, soulLoader, llmService, embeddingService, secrets, logger);
  return { gitSync, soulLoader, llmService, embeddingService, secrets, logger, calls, llmConfig };
}

describe("registerLlmReload", () => {
  it("reloads soul then re-inits the LLM and embedding services with the new config", async () => {
    const { gitSync, soulLoader, llmService, embeddingService, secrets, logger, calls, llmConfig } =
      setup();

    gitSync.emit("soul.synced");
    await vi.waitFor(() => expect(embeddingService.init).toHaveBeenCalled());

    expect(calls).toEqual(["reload", "init", "embeddings.init"]);
    expect(soulLoader.reload).toHaveBeenCalledOnce();
    expect(llmService.init).toHaveBeenCalledWith(llmConfig, secrets, logger);
    expect(embeddingService.init).toHaveBeenCalledWith(llmConfig, secrets, logger);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps serving (logs, does not throw) when re-init fails", async () => {
    const { gitSync, llmService, logger } = setup({
      init: () => Promise.reject(new Error("bad config")),
    });

    gitSync.emit("soul.synced");
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    expect(llmService.init).toHaveBeenCalledOnce();
    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("bad config");
  });

  it("skips re-init when the soul reload fails", async () => {
    const { gitSync, llmService, logger } = setup({
      reload: () => Promise.reject(new Error("reload boom")),
    });

    gitSync.emit("soul.synced");
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    expect(llmService.init).not.toHaveBeenCalled();
  });
});
