import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModel } from "ai";
import {
  LlmConfigValidationError,
  LlmCredentialError,
  LlmNotConfiguredError,
  UnknownModelError,
  validateLlmConfig,
} from "./config";
import { type FallbackLogger, FallbackModel } from "./fallback";
import { createModel } from "./provider";
import { type ModelSelector, resolveTier, type SelectionContext } from "./selection";

export type Tier = "quick" | "standard" | "complex";

const TIERS: Tier[] = ["quick", "standard", "complex"];

const isTier = (value: string): value is Tier => (TIERS as string[]).includes(value);

export type SelectRequest = SelectionContext & {
  model?: ModelSelector;
  sessionModel?: ModelSelector;
};

export class LlmService {
  private models: Map<Tier, LanguageModel> | null = null;
  private byModelId: Map<string, LanguageModel> = new Map();

  async init(
    rawConfig: unknown,
    secrets: SecretsService,
    logger: FallbackLogger = console
  ): Promise<void> {
    if (!rawConfig) {
      console.warn("[llm] no llm.config.yaml found — LLM features disabled");
      return;
    }

    const config = validateLlmConfig(rawConfig);
    const models = new Map<Tier, LanguageModel>();
    const byModelId = new Map<string, LanguageModel>();

    for (const tier of TIERS) {
      const { providers } = config.tiers[tier];

      // Resolve providers concurrently. Each entry catches expected errors locally and
      // returns null (skip + warn); unexpected errors re-throw immediately via Promise.all.
      // Promise.all preserves result order, so the fallback chain stays in config order.
      const resolved = await Promise.all(
        providers.map(async (entry) => {
          try {
            return { model: await createModel(entry, secrets), id: entry.model };
          } catch (err) {
            if (err instanceof LlmCredentialError || err instanceof LlmConfigValidationError) {
              console.warn(
                `[llm] skip tier=${tier} provider=${entry.provider} model=${entry.model} — ${err.message}`
              );
              return null;
            }
            throw err;
          }
        })
      );

      const built: Awaited<ReturnType<typeof createModel>>[] = [];
      for (const r of resolved) {
        if (r === null) continue;
        built.push(r.model);
        if (!byModelId.has(r.id)) byModelId.set(r.id, r.model);
      }

      if (built.length === 0) {
        console.warn(`[llm] tier=${tier} — no providers available, tier skipped`);
        continue;
      }

      models.set(tier, new FallbackModel(built, logger));
      console.info(`[llm] tier=${tier} providers=${built.length}`);
    }

    if (models.size === 0) {
      console.warn("[llm] no providers available across all tiers — LLM features disabled");
      return;
    }

    this.models = models;
    this.byModelId = byModelId;
  }

  getModel(tier: Tier): LanguageModel {
    if (!this.models) throw new LlmNotConfiguredError();
    const model = this.models.get(tier);
    if (!model) throw new LlmNotConfiguredError();
    return model;
  }

  getModelById(id: string): LanguageModel {
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
  select(req: SelectRequest): LanguageModel {
    const selector = req.sessionModel ?? req.model ?? "auto";
    if (selector === "auto") return this.getModel(resolveTier(req));
    if (isTier(selector)) return this.getModel(selector);
    return this.getModelById(selector);
  }
}
