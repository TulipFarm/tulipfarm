import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModelV1 } from "ai";
import { LlmNotConfiguredError, validateLlmConfig } from "./config";
import { FallbackModel } from "./fallback";
import { createModel } from "./provider";

export type Tier = "quick" | "standard" | "complex";

export class LlmService {
  private models: Map<Tier, LanguageModelV1> | null = null;

  async init(rawConfig: unknown, secrets: SecretsService): Promise<void> {
    if (!rawConfig) {
      console.warn("[llm] no llm.config.yaml found — LLM features disabled");
      return;
    }

    const config = validateLlmConfig(rawConfig);
    const tiers: Tier[] = ["quick", "standard", "complex"];
    const models = new Map<Tier, LanguageModelV1>();

    for (const tier of tiers) {
      const { providers } = config.tiers[tier];
      const built = await Promise.all(providers.map((entry) => createModel(entry, secrets)));
      models.set(tier, new FallbackModel(built));
      console.info(`[llm] tier=${tier} providers=${providers.length}`);
    }

    this.models = models;
  }

  getModel(tier: Tier): LanguageModelV1 {
    if (!this.models) throw new LlmNotConfiguredError();
    const model = this.models.get(tier);
    if (!model) throw new LlmNotConfiguredError();
    return model;
  }
}
