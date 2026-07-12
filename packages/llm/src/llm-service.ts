import {
  LlmConfigValidationError,
  LlmCredentialError,
  LlmNotConfiguredError,
  type ModelSpec,
  UnknownModelError,
  validateLlmConfig,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModel } from "ai";
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

/** One link in a resolved fallback chain: the configured provider + its model id, in config order. */
export interface ResolvedModelEntry {
  provider: string;
  modelId: string;
  /** Pinned spec from llm.config (pricing/context/capabilities), when resolved for this model. */
  spec?: ModelSpec;
}

/**
 * The outcome of resolving a model for one turn — the `LanguageModel` to run plus the metadata
 * needed to attribute the call (observability): the primary model id, the tier (if tier/auto
 * selection was used), and the ordered provider/model `chain`. For a raw model-id selection the
 * chain holds the single entry. The served model can differ from `modelId` under fallback; callers
 * reconcile via the chain.
 */
export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  tier?: Tier;
  chain: ResolvedModelEntry[];
}

export class LlmService {
  private models: Map<Tier, LanguageModel> | null = null;
  private byModelId: Map<string, LanguageModel> = new Map();
  private chainByTier: Map<Tier, ResolvedModelEntry[]> = new Map();
  private entryByModelId: Map<string, ResolvedModelEntry> = new Map();

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
    const chainByTier = new Map<Tier, ResolvedModelEntry[]>();
    const entryByModelId = new Map<string, ResolvedModelEntry>();

    for (const tier of TIERS) {
      const { providers } = config.tiers[tier];

      // Resolve providers concurrently. Each entry catches expected errors locally and
      // returns null (skip + warn); unexpected errors re-throw immediately via Promise.all.
      // Promise.all preserves result order, so the fallback chain stays in config order.
      const resolved = await Promise.all(
        providers.map(async (entry) => {
          try {
            return {
              model: await createModel(entry, secrets),
              id: entry.model,
              provider: entry.provider,
              spec: entry.spec,
            };
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
      const chain: ResolvedModelEntry[] = [];
      for (const r of resolved) {
        if (r === null) continue;
        built.push(r.model);
        chain.push({ provider: r.provider, modelId: r.id, spec: r.spec });
        if (!byModelId.has(r.id)) byModelId.set(r.id, r.model);
        if (!entryByModelId.has(r.id))
          entryByModelId.set(r.id, { provider: r.provider, modelId: r.id, spec: r.spec });
      }

      if (built.length === 0) {
        console.warn(`[llm] tier=${tier} — no providers available, tier skipped`);
        continue;
      }

      models.set(tier, new FallbackModel(built, logger));
      chainByTier.set(tier, chain);
      console.info(`[llm] tier=${tier} providers=${built.length}`);
    }

    if (models.size === 0) {
      console.warn("[llm] no providers available across all tiers — LLM features disabled");
      return;
    }

    this.models = models;
    this.byModelId = byModelId;
    this.chainByTier = chainByTier;
    this.entryByModelId = entryByModelId;
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
   * Resolve a model for one turn, with attribution metadata. Precedence: per-turn sessionModel,
   * then the caller's configured model, else `auto`. A tier name (or `auto`'s rule-based pick)
   * returns that tier's fallback chain; any other string is a raw provider model id that bypasses
   * tiers (single model, no fallback). See `ResolvedModel`.
   */
  resolve(req: SelectRequest): ResolvedModel {
    const selector = req.sessionModel ?? req.model ?? "auto";
    if (selector === "auto") return this.resolveTierModel(resolveTier(req));
    if (isTier(selector)) return this.resolveTierModel(selector);
    const model = this.getModelById(selector);
    const entry = this.entryByModelId.get(selector) ?? { provider: "unknown", modelId: selector };
    return { model, modelId: selector, chain: [entry] };
  }

  private resolveTierModel(tier: Tier): ResolvedModel {
    const model = this.getModel(tier);
    const chain = this.chainByTier.get(tier) ?? [];
    return { model, modelId: chain[0]?.modelId ?? "", tier, chain };
  }

  /** Backward-compatible accessor: the resolved `LanguageModel` only (see `resolve` for metadata). */
  select(req: SelectRequest): LanguageModel {
    return this.resolve(req).model;
  }
}
