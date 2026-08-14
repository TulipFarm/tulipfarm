import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { LlmService } from "@tulipfarm/llm";
import type { LlmConfig } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { llmProviderForFieldKey } from "@tulipfarm/secrets";
import type { CommitActor, Logger, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { pruneLlmConfig } from "./prune";
import { mergeLlmConfigIntoSoulYaml, removeLlmConfigFromSoulYaml } from "./soul-yaml-io";

/**
 * Returns an `onSecretDeleted` callback that keeps `soul.yaml#llm` in sync when a provider api_key
 * secret is removed. Checks whether the deleted key is an api_key field for a known LLM provider.
 * Prunes matching provider entries from the current config, then commits through the Soul write
 * gateway and re-inits the LLM service.
 */
export function makeLlmCascadeOnSecretDelete(
  soulLoader: SoulLoader,
  soulWriter: SoulWriter,
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

    const { content: currentManifest, baseCommit } = await soulWriter.readWithBase("Settings");
    const nextManifest =
      result.action === "update"
        ? mergeLlmConfigIntoSoulYaml(currentManifest, result.config)
        : // Pruning left a tier empty; remove the `llm:` key for a clean unconfigured state.
          removeLlmConfigFromSoulYaml(currentManifest);
    if (nextManifest === null) return;

    await soulWriter.apply({
      subject: commitMsg,
      source: "api",
      actor,
      businessId: DEPLOYMENT_BUSINESS_ID,
      expectedBaseCommit: baseCommit,
      changes: [{ op: "put", target: { kind: "Settings" }, content: nextManifest }],
    });
    await soulLoader.reload();
    await llmService.init(soulLoader.llmConfig, secretsService, logger);

    logger.info(
      `[llm] config ${result.action === "update" ? "pruned" : "removed"} after secret ${deletedKey} deleted`
    );
  };
}
