import type { LlmService } from "@tulipfarm/llm";
import type { LlmConfig } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { llmProviderForFieldKey } from "@tulipfarm/secrets";
import type { GitSyncService, Logger, SoulLoader } from "@tulipfarm/soul";
import { pruneLlmConfig } from "./prune";
import { deleteLlmConfigFromSoulYaml, writeLlmConfigToSoulYaml } from "./soul-yaml-io";

/**
 * Returns an `onSecretDeleted` callback that keeps `soul.yaml#llm` in sync when a
 * provider api_key secret is removed.
 *
 * On delete the callback:
 * 1. Checks whether the deleted key is an api_key field for a known LLM provider.
 * 2. Prunes matching provider entries from the current config.
 * 3. If every tier still has providers → writes the pruned config and re-inits.
 *    If any tier is left empty  → removes the `llm:` key entirely (clean unconfigured state).
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

    const commitMsg = `soul: remove ${owner.id} provider (secret ${deletedKey} deleted)`;

    if (result.action === "update") {
      await writeLlmConfigToSoulYaml(gitSync.path, result.config);
    } else {
      // "delete" — pruning left a tier empty; remove the `llm:` key for a clean unconfigured state
      await deleteLlmConfigFromSoulYaml(gitSync.path);
    }

    await gitSync.withSync(commitMsg);
    await soulLoader.reload();
    await llmService.init(soulLoader.llmConfig, secretsService, logger);

    logger.info(
      `[llm] config ${result.action === "update" ? "pruned" : "removed"} after secret ${deletedKey} deleted`
    );
  };
}
