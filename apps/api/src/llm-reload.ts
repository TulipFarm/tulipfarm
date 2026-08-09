import type { EventEmitter } from "node:events";
import type { EmbeddingService, LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import type { Logger, SoulLoader } from "@tulipfarm/soul";

/**
 * Reload the LLM config on every `soul.synced` event without restarting.
 *
 * Reloads the soul (re-reads `soul.yaml#llm`) then re-initialises the
 * LlmService and EmbeddingService, which re-validate and rebuild from the new
 * config. Both `SoulLoader.reload` and the service `init`s validate/build before
 * mutating their own state, so a failed reload leaves the running server on its
 * previously-loaded, valid config (LLM-V1-003 AC4).
 */
export function registerLlmReload(
  gitSync: EventEmitter,
  soulLoader: SoulLoader,
  llmService: LlmService,
  embeddingService: EmbeddingService,
  secrets: SecretsService,
  logger: Logger,
  afterReload?: () => Promise<void>
): void {
  gitSync.on("soul.synced", () => {
    void (async () => {
      try {
        await soulLoader.reload();
        await llmService.init(soulLoader.llmConfig, secrets, logger);
        await embeddingService.init(soulLoader.llmConfig, secrets, logger);
        // Runs after re-init so a dimension change (consumePendingReindex) triggers a re-index.
        await afterReload?.();
        logger.info("[llm] config reloaded after soul.synced");
      } catch (err) {
        logger.error(
          `[llm] config reload failed, keeping previous config — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })();
  });
}
