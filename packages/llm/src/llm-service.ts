import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModelV1 } from "ai";
import { LlmNotConfiguredError, UnknownModelError, validateLlmConfig } from "./config";
import { FallbackModel } from "./fallback";
import { createModel } from "./provider";
import { type ModelSelector, type SelectionContext, resolveTier } from "./selection";

export type Tier = "quick" | "standard" | "complex";

const TIERS: Tier[] = ["quick", "standard", "complex"];

const isTier = (value: string): value is Tier => (TIERS as string[]).includes(value);

export type SelectRequest = SelectionContext & {
  model?: ModelSelector;
  sessionModel?: ModelSelector;
};

export class LlmService {
  private models: Map<Tier, LanguageModelV1> | null = null;
  private byModelId: Map<string, LanguageModelV1> = new Map();

  async init(rawConfig: unknown, secrets: SecretsService): Promise<void> {
    if (!rawConfig) {
      console.warn("[llm] no llm.config.yaml found — LLM features disabled");
      return;
    }

    const config = validateLlmConfig(rawConfig);
    const models = new Map<Tier, LanguageModelV1>();
    const byModelId = new Map<string, LanguageModelV1>();

    for (const tier of TIERS) {
      const { providers } = config.tiers[tier];
      const built = await Promise.all(providers.map((entry) => createModel(entry, secrets)));
      built.forEach((model, i) => {
        const id = providers[i]?.model;
        if (id && !byModelId.has(id)) byModelId.set(id, model);
      });
      models.set(tier, new FallbackModel(built));
      console.info(`[llm] tier=${tier} providers=${providers.length}`);
    }

    this.models = models;
    this.byModelId = byModelId;
  }

  getModel(tier: Tier): LanguageModelV1 {
    if (!this.models) throw new LlmNotConfiguredError();
    const model = this.models.get(tier);
    if (!model) throw new LlmNotConfiguredError();
    return model;
  }

  getModelById(id: string): LanguageModelV1 {
    if (!this.models) throw new LlmNotConfiguredError();
    const model = this.byModelId.get(id);
    if (!model) throw new UnknownModelError(id);
    return model;
  }

  /**
   * Resolve a model for one turn. Precedence: per-turn sessionModel, then the
   * caller's configured model, else `auto`. A tier name returns that tier's
   * fallback chain; `auto` runs the rule-based selection; any other string is a
   * raw provider model id that bypasses tiers (single model, no fallback).
   */
  select(req: SelectRequest): LanguageModelV1 {
    const selector = req.sessionModel ?? req.model ?? "auto";
    if (selector === "auto") return this.getModel(resolveTier(req));
    if (isTier(selector)) return this.getModel(selector);
    return this.getModelById(selector);
  }
}
