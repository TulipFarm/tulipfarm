import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { cliModelSpec, type LlmService } from "@tulipfarm/llm";
import type { LlmConfig } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { llmProviderForFieldKey } from "@tulipfarm/secrets";
import type { CommitActor, Logger, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { mergeLlmConfigIntoSoulYaml } from "@tulipfarm/soul";

/**
 * Subscription CLI providers ship a fixed, known model per tier (`packages/llm/src/cli/specs.ts`),
 * unlike API-key providers where many models exist and no default is obviously right. Only these
 * two get auto-wired; everything else still requires a manual trip to the Models page.
 */
const CLI_TIER_MODELS: Record<string, { quick: string; standard: string; complex: string }> = {
  "claude-code": { quick: "haiku", standard: "sonnet", complex: "opus" },
  codex: { quick: "gpt-5.6-luna", standard: "gpt-5.6-terra", complex: "gpt-5.6-sol" },
};

/**
 * Returns an `onSecretSet` callback that auto-connects a subscription CLI provider (Claude Code,
 * Codex) the first time its credential is saved, so "Connect a model provider" clears without a
 * separate trip to the Models page. Only fires when no `llm.tiers` exist yet — an already-configured
 * instance is never overwritten.
 */
export function makeLlmCascadeOnSecretSet(
  soulLoader: SoulLoader,
  soulWriter: SoulWriter,
  llmService: LlmService,
  secretsService: SecretsService,
  logger: Logger,
  /** Kicks the Task reconciler outside its 15-minute cron so "Connect a model provider" clears
   * within seconds of the auto-connect commit, not on the next scheduled tick. */
  triggerTaskReconcile?: () => Promise<void>
): (setKey: string, actor: CommitActor) => Promise<void> {
  return async (setKey: string, actor: CommitActor): Promise<void> => {
    const currentConfig = soulLoader.llmConfig as LlmConfig | undefined;
    if (currentConfig?.tiers) return; // already configured — never clobber an existing setup

    const owner = llmProviderForFieldKey(setKey);
    const field = owner?.fields.find((f) => f.key === setKey);
    if (!owner || field?.role !== "api_key") return;

    const tierModels = CLI_TIER_MODELS[owner.id];
    if (!tierModels) return; // not a known subscription CLI provider — no safe default to pick

    const nextConfig: LlmConfig = {
      ...currentConfig,
      tiers: {
        quick: {
          providers: [
            {
              provider: owner.id,
              model: tierModels.quick,
              api_key_ref: setKey,
              spec: cliModelSpec(owner.id, tierModels.quick),
            },
          ],
        },
        standard: {
          providers: [
            {
              provider: owner.id,
              model: tierModels.standard,
              api_key_ref: setKey,
              spec: cliModelSpec(owner.id, tierModels.standard),
            },
          ],
        },
        complex: {
          providers: [
            {
              provider: owner.id,
              model: tierModels.complex,
              api_key_ref: setKey,
              spec: cliModelSpec(owner.id, tierModels.complex),
            },
          ],
        },
      },
    };

    const { content: currentManifest, baseCommit } = await soulWriter.readWithBase("Settings");
    await soulWriter.apply({
      subject: `soul: auto-connect ${owner.label} (secret ${setKey} added)`,
      source: "api",
      actor,
      businessId: DEPLOYMENT_BUSINESS_ID,
      expectedBaseCommit: baseCommit,
      changes: [
        {
          op: "put",
          target: { kind: "Settings" },
          content: mergeLlmConfigIntoSoulYaml(currentManifest, nextConfig),
        },
      ],
    });
    await soulLoader.reload();
    await llmService.init(soulLoader.llmConfig, secretsService, logger);

    if (triggerTaskReconcile) {
      try {
        await triggerTaskReconcile();
      } catch (err) {
        logger.error(
          `[llm] task-reconcile kick after ${owner.id} auto-connect failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    logger.info(`[llm] ${owner.id} auto-connected after secret ${setKey} added`);
  };
}
