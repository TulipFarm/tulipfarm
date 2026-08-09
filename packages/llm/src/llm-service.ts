import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  asEffortPreset,
  type DerivedModelProfile,
  deriveModelProfiles,
  type EffortPreset,
  isDeprecatedTierAlias,
  type LlmConfig,
  LlmConfigValidationError,
  LlmCredentialError,
  LlmNotConfiguredError,
  type ModelSpec,
  resolveEffortPreset,
  UnknownModelError,
  validateLlmConfig,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModel } from "ai";
import { type FallbackLogger, FallbackModel } from "./fallback";
import { createModel } from "./provider";

/**
 * Retired selection primitive, kept only as the shape `llm.config` is still *authored* in.
 *
 * Nothing selects a model by tier any more: effort presets are what the product exposes and
 * ModelProfiles are what the router decides on. The autonomy-to-tier map that used to live beside
 * this is gone outright — it handed a Run with `full` autonomy the *weakest* model, coupling
 * oversight to capability backwards. Risk and effort are orthogonal, and neither belongs to the
 * other.
 */
type Tier = "quick" | "standard" | "complex";

const TIERS: Tier[] = ["quick", "standard", "complex"];

/** One link in a resolved fallback chain: the configured provider + its model id, in config order. */
export interface ResolvedModelEntry {
  provider: string;
  modelId: string;
  /** Pinned spec from llm.config (pricing/context/capabilities), when resolved for this model. */
  spec?: ModelSpec;
}

export class LlmService {
  /** Whether any provider built. Every accessor refuses rather than pretending on an empty set. */
  private configured = false;
  /** The logger the deployment configured at init; fallback events must not lose it at call time. */
  private logger: FallbackLogger = console;
  // Always a built provider model, never the bare model-id string `LanguageModel` also permits.
  private byModelId: Map<string, LanguageModelV4> = new Map();
  private entryByModelId: Map<string, ResolvedModelEntry> = new Map();
  private presets: Pick<LlmConfig, "presets"> = {};
  private profiles: Map<string, DerivedModelProfile> = new Map();

  async init(
    rawConfig: unknown,
    secrets: SecretsService,
    logger: FallbackLogger = console
  ): Promise<void> {
    if (!rawConfig) {
      console.warn("[llm] no soul.yaml#llm config found — LLM features disabled");
      return;
    }

    const config = validateLlmConfig(rawConfig);
    // The same derivation the worker's router uses, so an effort preset means one thing on both
    // sides of the process boundary rather than two that drift.
    this.presets = { presets: config.presets };
    this.profiles = new Map(deriveModelProfiles(config).map((p) => [p.profileId, p]));
    const byModelId = new Map<string, LanguageModelV4>();
    const entryByModelId = new Map<string, ResolvedModelEntry>();

    for (const tier of TIERS) {
      // The schema requires every chain, but the optional access keeps this boundary defensive
      // when called with unchecked JavaScript.
      const providers = config.tiers?.[tier].providers ?? [];
      if (providers.length === 0) continue;

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

      let available = 0;
      for (const r of resolved) {
        if (r === null) continue;
        available += 1;
        if (!byModelId.has(r.id)) byModelId.set(r.id, r.model);
        if (!entryByModelId.has(r.id))
          entryByModelId.set(r.id, { provider: r.provider, modelId: r.id, spec: r.spec });
      }

      if (available === 0) {
        console.warn(`[llm] tier=${tier} — no providers available, tier skipped`);
        continue;
      }
      console.info(`[llm] tier=${tier} providers=${available}`);
    }

    if (byModelId.size === 0) {
      console.warn("[llm] no providers available across all tiers — LLM features disabled");
      return;
    }

    this.configured = true;
    this.logger = logger;
    this.byModelId = byModelId;
    this.entryByModelId = entryByModelId;
  }

  /**
   * The model that serves one effort preset, with its whole fallback chain.
   *
   * This is what the API's own one-shot helpers ask for — titles, personalization, Skill
   * authoring, health probes. They have no declared capability requirements to check, so they
   * resolve straight to the chain the preset names; what matters is that they name *effort*, the
   * concept the product exposes, instead of a tier, the primitive being retired. Preset resolution
   * and the profile catalog are shared with the worker's router, so "fast" cannot mean one model
   * here and another there.
   */
  effortModel(
    selector: EffortPreset | string,
    logger: FallbackLogger = this.logger
  ): LanguageModel {
    if (!this.configured) throw new LlmNotConfiguredError();

    const preset = asEffortPreset(selector);
    if (preset === undefined) return this.getModelById(selector);
    if (isDeprecatedTierAlias(selector)) {
      console.warn(
        `[llm] selector "${selector}" is a retired tier name; use the "${preset}" effort preset`
      );
    }

    const profileId = resolveEffortPreset(preset, this.presets, (id) => this.profiles.has(id));
    const profile = profileId === undefined ? undefined : this.profiles.get(profileId);
    if (profile === undefined) throw new LlmNotConfiguredError();

    const chain = [profile.model, ...(profile.fallbacks ?? []).flatMap(this.modelOf)];
    return this.chainModel(chain, logger);
  }

  /** A fallback ref resolved to its provider model id, or nothing when it is not configured. */
  private readonly modelOf = (profileId: string): string[] => {
    const model = this.profiles.get(profileId)?.model;
    return model === undefined ? [] : [model];
  };

  getModelById(id: string): LanguageModel {
    if (!this.configured) throw new LlmNotConfiguredError();
    const model = this.byModelId.get(id);
    if (!model) throw new UnknownModelError(id);
    return model;
  }

  /** Whether a model id was configured, so a caller can choose a route without catching a throw. */
  hasModelId(id: string): boolean {
    return this.byModelId.has(id);
  }

  /** The pinned spec for a configured model id, for cost attribution and capability derivation. */
  specFor(id: string): ModelSpec | undefined {
    return this.entryByModelId.get(id)?.spec;
  }

  /**
   * Build one `LanguageModel` that tries each model id in order.
   *
   * This is what a resolved ModelProfile chain executes as. It exists because a chain that is only
   * ever collapsed to its head is not a fallback chain at all: the tier path returned a wrapped
   * `FallbackModel` but shipped only `chain[0]`'s id across the process boundary, so the worker
   * re-resolved a single model and every configured backup provider sat inert. Here the caller
   * hands over the whole chain it selected, so what runs is what was chosen.
   */
  chainModel(modelIds: readonly string[], logger: FallbackLogger = this.logger): LanguageModel {
    if (!this.configured) throw new LlmNotConfiguredError();
    const built = modelIds.map((id) => this.byModelId.get(id)).filter((m) => m !== undefined);
    // The ids came from the catalog, so an empty chain means every provider behind them failed to
    // build — a configuration or credential fault, not an unknown model. Callers surface the two
    // very differently, and telling an operator their configured model is "unknown" sends them
    // looking in the wrong place.
    if (built.length === 0) throw new LlmNotConfiguredError();
    // A single link needs no wrapper — and wrapping would hide a genuinely unconfigured chain.
    return built.length === 1 ? built[0] : new FallbackModel(built, logger);
  }
}
