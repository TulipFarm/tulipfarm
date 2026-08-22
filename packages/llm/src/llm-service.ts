import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  asEffortPreset,
  type DerivedModelProfile,
  deriveModelProfiles,
  dropUnusableProviderEntries,
  type EffortPreset,
  isDeprecatedTierAlias,
  type LlmConfig,
  LlmConfigValidationError,
  LlmCredentialError,
  LlmNotConfiguredError,
  type ModelSpec,
  type ProviderEntry,
  resolveEffortPreset,
  UnknownModelError,
  validateLlmConfig,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModel } from "ai";
import {
  type FallbackCallGate,
  type FallbackLogger,
  FallbackModel,
  type ModelAttemptRef,
  type ModelResponderRef,
} from "./fallback";
import { createModel, type PrincipalCredentialResolver, type PrincipalRef } from "./provider";

/**
 * Init-time logger. Wider than {@link FallbackLogger} because provider resolution reports what it
 * skipped and what it built, and those lines belong in the structured pipeline like any other.
 */
export interface LlmLogger extends FallbackLogger {
  info(msg: string): void;
}

/** Retired authored config shape; product routing now uses effort presets and ModelProfiles. */
type Tier = "quick" | "standard" | "complex";

const TIERS: Tier[] = ["quick", "standard", "complex"];

/** One resolved fallback-chain link: provider plus model id, in config order. */
export interface ResolvedModelEntry {
  provider: string;
  modelId: string;
  /** Pinned spec from llm.config (pricing/context/capabilities), when resolved for this model. */
  spec?: ModelSpec;
  /** The authored entry, retained so a principal-scoped model can be rebuilt on demand. */
  entry?: ProviderEntry;
}

export class LlmService {
  /** Whether any provider built. Every accessor refuses rather than pretending on an empty set. */
  private configured = false;
  /** Deployment logger captured at init so fallback events keep call-time context. */
  private logger: FallbackLogger = console;
  // Always a built provider model, never the bare model-id string `LanguageModel` also permits.
  private byModelId: Map<string, LanguageModelV4> = new Map();
  private entryByModelId: Map<string, ResolvedModelEntry> = new Map();
  private presets: Pick<LlmConfig, "presets"> = {};
  private profiles: Map<string, DerivedModelProfile> = new Map();
  /** Retained from init so a principal-scoped model can be built after boot. */
  private secrets: SecretsService | undefined;
  private credentials: PrincipalCredentialResolver | undefined;
  /** Principal-scoped models, keyed `kind:id:modelId`. Built once, then reused like the shared set. */
  private readonly byPrincipal: Map<string, LanguageModelV4> = new Map();

  /** Whether any provider built. Callers that must not start work without one ask this first. */
  get isConfigured(): boolean {
    return this.configured;
  }

  async init(
    rawConfig: unknown,
    secrets: SecretsService,
    logger: LlmLogger = console,
    credentials?: PrincipalCredentialResolver
  ): Promise<void> {
    if (!rawConfig) {
      logger.warn("[llm] no soul.yaml#llm config found — LLM features disabled");
      return;
    }

    const { config: usable, dropped } = dropUnusableProviderEntries(rawConfig);
    for (const entry of dropped) {
      logger.warn(
        `[llm] tier=${entry.tier} entry ${entry.index + 1} names no provider or model ` +
          `(provider="${entry.provider}" model="${entry.model}") — dropped from the fallback chain`
      );
    }

    const config = validateLlmConfig(usable);
    // The same derivation the worker's router uses, so an effort preset means one thing on two
    // sides of the process boundary rather than two that drift.
    //
    // Held locally until every provider has built. Assigning them here would leave a failed
    // reload pointing new presets at the previous config's model maps.
    const presets = { presets: config.presets };
    const profiles = new Map(deriveModelProfiles(config).map((p) => [p.profileId, p]));
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
              model: await createModel(entry, secrets, { log: logger }),
              id: entry.model,
              provider: entry.provider,
              spec: entry.spec,
              entry,
            };
          } catch (err) {
            if (err instanceof LlmCredentialError || err instanceof LlmConfigValidationError) {
              logger.warn(
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
          entryByModelId.set(r.id, {
            provider: r.provider,
            modelId: r.id,
            spec: r.spec,
            entry: r.entry,
          });
      }

      if (available === 0) {
        logger.warn(`[llm] tier=${tier} — no providers available, tier skipped`);
        continue;
      }
      logger.info(`[llm] tier=${tier} providers=${available}`);
    }

    if (byModelId.size === 0) {
      logger.warn("[llm] no providers available across all tiers — LLM features disabled");
      return;
    }

    // One swap, after everything succeeded: a reload either takes effect whole or not at all.
    this.configured = true;
    this.logger = logger;
    this.byModelId = byModelId;
    this.entryByModelId = entryByModelId;
    this.presets = presets;
    this.profiles = profiles;
    this.secrets = secrets;
    this.credentials = credentials;
    // Principal-scoped models were built from the previous config's entries; keeping them would
    // serve a model the operator has just changed or removed.
    this.byPrincipal.clear();
  }

  /** Resolves one effort preset to the same fallback chain used by worker model routing. */
  effortModel(
    selector: EffortPreset | string,
    logger: FallbackLogger = this.logger
  ): LanguageModel {
    if (!this.configured) throw new LlmNotConfiguredError();

    const preset = asEffortPreset(selector);
    if (preset === undefined) return this.getModelById(selector);
    if (isDeprecatedTierAlias(selector)) {
      logger.warn(
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

  /** The configured entry behind a model id — provider, id and pinned spec, as one pricing input. */
  entryFor(id: string): ResolvedModelEntry | undefined {
    return this.entryByModelId.get(id);
  }

  /**
   * Builds a model that executes the whole selected chain, not only its first id.
   *
   * `responder` is filled in with whichever link actually served, so the caller can price the
   * answer rather than the request.
   */
  /**
   * The same chain as `chainModel`, but built to act as `principal` wherever that principal holds
   * their own provider credential.
   *
   * Links the principal has no credential for fall back to the shared deployment model, so a
   * partially-connected principal still gets a whole chain rather than a truncated one.
   */
  async chainModelFor(
    modelIds: readonly string[],
    principal: PrincipalRef | undefined,
    logger: FallbackLogger = this.logger,
    responder?: ModelResponderRef,
    gate?: FallbackCallGate,
    attempted?: ModelAttemptRef
  ): Promise<LanguageModel> {
    if (principal === undefined || this.credentials === undefined) {
      return this.chainModel(modelIds, logger, responder, gate, attempted);
    }
    const built = (
      await Promise.all(
        modelIds.map(async (id) => ({ id, model: await this.principalModel(id, principal) }))
      )
    ).filter((link): link is { id: string; model: LanguageModelV4 } => link.model !== undefined);
    if (built.length === 0) throw new LlmNotConfiguredError();
    if (built.length === 1 && gate === undefined) {
      if (responder !== undefined) responder.modelId = built[0].model.modelId;
      return built[0].model;
    }
    return new FallbackModel(
      built.map((link) => link.model),
      logger,
      responder,
      gate,
      built.map((link) => this.entryByModelId.get(link.id)?.provider ?? link.model.provider),
      attempted
    );
  }

  /** One model built for one principal, cached; falls back to the shared model when they have none. */
  private async principalModel(
    id: string,
    principal: PrincipalRef
  ): Promise<LanguageModelV4 | undefined> {
    const shared = this.byModelId.get(id);
    const entry = this.entryByModelId.get(id)?.entry;
    const secrets = this.secrets;
    const credentials = this.credentials;
    if (entry === undefined || secrets === undefined || credentials === undefined) return shared;

    const cacheKey = `${principal.kind}:${principal.id}:${id}`;
    const cached = this.byPrincipal.get(cacheKey);
    if (cached !== undefined) return cached;

    if ((await credentials.resolve(principal, entry.provider)) === undefined) return shared;

    try {
      const model = await createModel(entry, secrets, {
        principal,
        credentials,
        log: this.logger,
      });
      this.byPrincipal.set(cacheKey, model);
      return model;
    } catch (err) {
      // A principal's own credential being unusable must not take down a call the deployment
      // credential could still serve; the shared model is the safe, already-working route.
      this.logger.warn(
        `[llm] principal credential unusable for model=${id} — using the shared credential (${
          err instanceof Error ? err.message : String(err)
        })`
      );
      return shared;
    }
  }

  chainModel(
    modelIds: readonly string[],
    logger: FallbackLogger = this.logger,
    responder?: ModelResponderRef,
    gate?: FallbackCallGate,
    attempted?: ModelAttemptRef
  ): LanguageModel {
    if (!this.configured) throw new LlmNotConfiguredError();
    const built = modelIds.flatMap((id) => {
      const model = this.byModelId.get(id);
      return model === undefined ? [] : [{ id, model }];
    });
    // The ids came from the catalog, so an empty chain means every provider behind them failed to
    // build — a configuration or credential fault, not an unknown model. Callers surface the two
    // very differently, and telling an operator their configured model is "unknown" sends them
    // looking in the wrong place.
    if (built.length === 0) throw new LlmNotConfiguredError();
    // A single link needs no wrapper — and wrapping would hide a genuinely unconfigured chain.
    // Its responder is known without executing anything: there is nothing else that could answer.
    if (built.length === 1 && gate === undefined) {
      if (responder !== undefined) responder.modelId = built[0].model.modelId;
      return built[0].model;
    }
    return new FallbackModel(
      built.map((link) => link.model),
      logger,
      responder,
      gate,
      built.map((link) => this.entryByModelId.get(link.id)?.provider ?? link.model.provider),
      attempted
    );
  }
}
