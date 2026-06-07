import type { EventEmitter } from "node:events";
import type { LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import type { Logger, SoulLoader } from "@tulipfarm/soul";

/**
 * Reload the LLM config on every `soul.synced` event without restarting.
 *
 * Reloads the soul (re-reads `llm.config.yaml`) then re-initialises the
 * LlmService, which re-validates and rebuilds the tier models. Both
 * `SoulLoader.reload` and `LlmService.init` validate/build before mutating
 * their own state, so a failed reload leaves the running server on its
 * previously-loaded, valid config (LLM-V1-003 AC4).
 */
export function registerLlmReload(
  gitSync: EventEmitter,
  soulLoader: SoulLoader,
  llmService: LlmService,
  secrets: SecretsService,
  logger: Logger
): void {
  gitSync.on("soul.synced", () => {
    void (async () => {
      try {
        await soulLoader.reload();
        await llmService.init(soulLoader.llmConfig, secrets, logger);
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
