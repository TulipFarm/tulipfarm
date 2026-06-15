import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmConfig, LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import { llmProviderForFieldKey } from "@tulipfarm/secrets";
import type { GitSyncService, Logger, SoulLoader } from "@tulipfarm/soul";
import { stringify as stringifyYaml } from "yaml";
import { pruneLlmConfig } from "./prune";

/**
 * Returns an `onSecretDeleted` callback that keeps `llm.config.yaml` in sync when a
 * provider api_key secret is removed.
 *
 * On delete the callback:
 * 1. Checks whether the deleted key is an api_key field for a known LLM provider.
 * 2. Prunes matching provider entries from the current config.
 * 3. If every tier still has providers → writes the pruned config and re-inits.
 *    If any tier is left empty  → deletes the file entirely (clean unconfigured state).
 * 4. Commits via gitSync and reloads the soul + LLM service.
 *
 * Errors are re-thrown so the caller can log and suppress them without crashing the
 * delete response.
 */
export function makeLlmCascadeOnSecretDelete(
  soulLoader: SoulLoader,
  gitSync: GitSyncService,
  llmService: LlmService,
  secretsService: SecretsService,
  logger: Logger
): (deletedKey: string) => Promise<void> {
  return async (deletedKey: string): Promise<void> => {
    const currentConfig = soulLoader.llmConfig as LlmConfig | undefined;
    if (!currentConfig) return;

    const owner = llmProviderForFieldKey(deletedKey);
    const field = owner?.fields.find((f) => f.key === deletedKey);
    if (!owner || field?.role !== "api_key") return;

    const result = pruneLlmConfig(currentConfig, deletedKey, owner);
    if (result.action === "unchanged") return;

    const configPath = join(gitSync.path, "llm.config.yaml");
    const commitMsg = `soul: remove ${owner.id} provider (secret ${deletedKey} deleted)`;

    if (result.action === "update") {
      await writeFile(configPath, stringifyYaml(result.config), "utf8");
    } else {
      // "delete" — pruning left a tier empty; remove the file for a clean unconfigured state
      try {
        await unlink(configPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
    }

    await gitSync.withSync(commitMsg);
    await soulLoader.reload();
    await llmService.init(soulLoader.llmConfig, secretsService, logger);

    logger.info(
      `[llm] config ${result.action === "update" ? "pruned" : "removed"} after secret ${deletedKey} deleted`
    );
  };
}
