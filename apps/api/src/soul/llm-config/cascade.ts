import type { LlmService } from "@tulipfarm/llm";
import type { LlmConfig } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { llmProviderForFieldKey } from "@tulipfarm/secrets";
import type { CommitActor, GitSyncService, Logger, SoulLoader } from "@tulipfarm/soul";
import { pruneLlmConfig } from "./prune";
import { deleteLlmConfigFromSoulYaml, writeLlmConfigToSoulYaml } from "./soul-yaml-io";

/**
 * Returns an `onSecretDeleted` callback that keeps `soul.yaml#llm` in sync when a provider api_key
 * secret is removed. Checks whether the deleted key is an api_key field for a known LLM provider.
 * Prunes matching provider entries from the current config.
 */
export function makeLlmCascadeOnSecretDelete(
  soulLoader: SoulLoader,
  gitSync: GitSyncService,
  llmService: LlmService,
  secretsService: SecretsService,
  logger: Logger
): (deletedKey: string, actor: CommitActor) => Promise<void> {
  return async (deletedKey: string, actor: CommitActor): Promise<void> => {
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
      await deleteLlmConfigFromSoulYaml(gitSync.path);
    }

    await gitSync.withSync(commitMsg, actor);
    await soulLoader.reload();
    await llmService.init(soulLoader.llmConfig, secretsService, logger);

    logger.info(
      `[llm] config ${result.action === "update" ? "pruned" : "removed"} after secret ${deletedKey} deleted`
    );
  };
}
