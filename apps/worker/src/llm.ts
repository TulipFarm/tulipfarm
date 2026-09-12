import type { ModelProfileCatalog, ModelRequirements } from "@tulipfarm/agent-runtime";
import { selectModelProfile } from "@tulipfarm/agent-runtime";
import type {
  CostBasis,
  FallbackAttemptBudgetRef,
  FallbackAttemptUsage,
  FallbackAttemptUsageRef,
  FallbackCallGate,
  ModelAttemptRef,
  ModelPrice,
  ModelResponderRef,
  PrincipalRef,
} from "@tulipfarm/llm";
import {
  isPriceable,
  type LlmLogger,
  LlmService,
  priceCall,
  SecretsPrincipalCredentials,
} from "@tulipfarm/llm";
import type { ResolvedLimits } from "@tulipfarm/run-kernel";
import { resolveModelProfileBudgetLimits } from "@tulipfarm/run-kernel";
import {
  asEffortPreset,
  type ConfiguredModelRef,
  configuredModelRef,
  deriveModelProfiles,
  isDeprecatedTierAlias,
  type RunEventEffortInference,
  type RunEventPayloads,
  resolveEffortPreset,
  validateLlmConfig,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModel } from "ai";
import { modelBudgetEvidence } from "./model-budget";

/** Keeps published LLM config hot; credentials stay as `api_key_ref`s unwrapped in Worker. */
export interface SoulLlmOptions {
  /** Reads the published LLM configuration, or `undefined` when the Soul publishes none. */
  source(): Promise<unknown>;
  /** Lazy because the API provisions the active DEK and some deployments never chat. */
  secrets(): Promise<SecretsService>;
  /**
   * Operator price corrections, read from the same published config the control plane parses.
   *
   * This is the branch that charges the Run budget, so an override that does not reach here
   * corrects only reporting. Failure resolves to no overrides rather than failing the turn.
   */
  pricingOverrides?(): Promise<Record<string, ModelPrice>>;
  /** Defaults to `console` when absent, same as `LlmService.init`. */
  logger?: LlmLogger;
}

export type ModelRoutingPayload = RunEventPayloads["model.routed"];

export type LlmModelResolution =
  | {
      readonly kind: "available";
      readonly model: LanguageModel;
      readonly routing: ModelRoutingPayload;
      readonly budgetLimits?: ResolvedLimits;
      /**
       * The provider the head of the chain belongs to, so per-provider limits and the circuit
       * breaker have something to key on. A chain can span providers; this names the one the
       * call is about to be made against.
       */
      readonly provider?: string;
      /** Provider for the configured model that actually answered or was attempted. */
      providerForModel?(model: ModelIdentity | undefined): string | undefined;
      /** The configured identity selected at the head of this route. */
      readonly selectedConfiguredModel?: ConfiguredModelRef;
      /** The last configured chain link whose provider call began. */
      attemptedConfiguredModel?(): ConfiguredModelRef | undefined;
      /** The configured chain link that committed an answer. */
      respondingConfiguredModel?(): ConfiguredModelRef | undefined;
      /** The last chain link that a provider call actually entered. */
      attemptedModelId?(): string | undefined;
      /** Metered usage from links that failed before the fallback chain committed an answer. */
      failedAttemptUsage?(): readonly FallbackAttemptUsage[];
      /** Request-scoped hook installed by the Worker to admit each provider attempt separately. */
      readonly attemptBudget?: FallbackAttemptBudgetRef;
      /** Sequential provider-attempt id for the link that committed an answer. */
      respondingAttemptId?(): number | undefined;
      /**
       * Prices this call against an explicit attempted link, or the link that answered.
       *
       * Passing the attempted identity keeps failed calls attributable; successful calls can omit
       * it because the responder is known after commitment.
       */
      price(tokensIn: number, tokensOut: number, configuredModel?: ConfiguredModelRef): CostBasis;
      /** Conservative price for every fallback link that could be attempted by one logical call. */
      reservationPrice?(tokensIn: number, tokensOut: number): CostBasis;
    }
  | {
      readonly kind: "denied";
      readonly routing: Extract<ModelRoutingPayload, { readonly outcome: "denied" }>;
    };

type ProfileSelectorResolution = "effort_preset" | "effort_inferred" | "profile_ref";

type ResolvedProfileSelector =
  | {
      readonly kind: "profile";
      readonly profileId: string;
      readonly resolution: ProfileSelectorResolution;
    }
  | { readonly kind: "raw_model"; readonly modelId: string };

type ModelIdentity = string | ConfiguredModelRef;

export class SoulLlm {
  private readonly service = new LlmService();
  /** The exact configuration the service was last built from; `null` before the first build. */
  private applied: string | null = null;
  private pending: Promise<void> | null = null;
  private secrets: Promise<SecretsService> | null = null;
  /** ModelProfiles derived from the applied configuration, keyed by profile id. */
  private catalog: ModelProfileCatalog = { get: () => undefined };
  private presets: Parameters<typeof resolveEffortPreset>[1] = {};
  /** Operator price corrections refreshed with the config they belong to. */
  private overrides: Record<string, ModelPrice> = {};

  constructor(private readonly options: SoulLlmOptions) {}

  private entryFor(identity: ModelIdentity | undefined) {
    if (identity === undefined) return undefined;
    return typeof identity === "string"
      ? this.service.entryFor(identity)
      : this.service.entryForConfiguredModel(identity);
  }

  private configuredIdentity(identity: ModelIdentity | undefined): ConfiguredModelRef | undefined {
    if (identity === undefined) return undefined;
    if (typeof identity !== "string") return identity;
    const entry = this.service.entryFor(identity);
    return entry === undefined
      ? undefined
      : { connection: entry.connection, modelId: entry.modelId };
  }

  /** The provider behind a configured model, for per-provider limits and the breaker. */
  private providerOf(identity: ModelIdentity | undefined): string | undefined {
    return this.entryFor(identity)?.provider;
  }

  /**
   * Prices a completed call, given the model that actually answered.
   *
   * The provider comes from the configured entry rather than the model id, so a subscription seat
   * is recognised as unmetered instead of being matched against the published API price table.
   */
  priceFor(identity: ModelIdentity | undefined, tokensIn: number, tokensOut: number): CostBasis {
    if (identity === undefined) return { kind: "unpriced" };
    const modelId = typeof identity === "string" ? identity : identity.modelId;
    const entry = this.entryFor(identity);
    return priceCall({
      provider: entry?.provider ?? "",
      modelId,
      tokensIn,
      tokensOut,
      spec: entry?.spec,
      overrides: this.overrides,
    });
  }

  /** The first chain link whose calls could not be priced, or `undefined` when all can. */
  private unpriceableLink(models: readonly ModelIdentity[]): ModelIdentity | undefined {
    return models.find((identity) => {
      const modelId = typeof identity === "string" ? identity : identity.modelId;
      const entry = this.entryFor(identity);
      return !isPriceable({
        provider: entry?.provider ?? "",
        modelId,
        spec: entry?.spec,
        overrides: this.overrides,
      });
    });
  }

  private reservationPrice(
    models: readonly ModelIdentity[],
    tokensIn: number,
    tokensOut: number
  ): CostBasis {
    let costUsd = 0;
    for (const model of models) {
      const cost = this.priceFor(model, tokensIn, tokensOut);
      if (cost.kind === "unpriced") return cost;
      if (cost.kind === "priced") costUsd += cost.costUsd;
    }
    return costUsd === 0 ? { kind: "subscription" } : { kind: "priced", costUsd, source: "table" };
  }

  /** Resolves selectors to the full selected chain; raw model ids bypass profile checks. */
  async model(
    selector: string,
    requirements: ModelRequirements,
    gate?: FallbackCallGate
  ): Promise<LanguageModel> {
    const resolution = await this.resolveModel(selector, requirements, undefined, undefined, gate);
    if (resolution.kind === "denied") {
      throw new ModelProfileDeniedError(
        resolution.routing.profileId,
        resolution.routing.reason,
        resolution.routing
      );
    }
    return resolution.model;
  }

  /** Builds an already-routed Routine chain without re-resolving against current config. */
  async chainModel(
    modelIds: readonly ModelIdentity[],
    gate?: FallbackCallGate
  ): Promise<LanguageModel> {
    await this.sync();
    return this.service.chainModel(modelIds, undefined, undefined, gate);
  }

  /**
   * An already-routed Routine chain as a full resolution, so the Routine path prices its calls
   * through the same authority the Chat path uses rather than reporting them as free.
   */
  async resolveChain(
    modelIds: readonly ModelIdentity[],
    routing: Extract<ModelRoutingPayload, { readonly outcome: "selected" }>,
    principal?: PrincipalRef,
    gate?: FallbackCallGate,
    budgetLimits?: ResolvedLimits
  ): Promise<LlmModelResolution> {
    await this.sync();
    if (budgetLimits?.costMicros !== undefined) {
      const unpriceable = this.unpriceableLink(modelIds);
      if (unpriceable !== undefined) {
        return {
          kind: "denied",
          routing: {
            outcome: "denied",
            selector: routing.selector,
            resolution: routing.resolution,
            profileId: routing.profileId,
            reason: "cost_unpriceable",
            attempts: [{ profileId: routing.profileId, reason: "cost_unpriceable" }],
          },
        };
      }
    }
    const responder: ModelResponderRef = {};
    const attempted: ModelAttemptRef = {};
    const attemptUsage: FallbackAttemptUsageRef = { attempts: [] };
    const attemptBudget: FallbackAttemptBudgetRef = {};
    const selectedConfiguredModel = this.configuredIdentity(modelIds[0]);
    return {
      kind: "available",
      model: await this.service.chainModelFor(
        modelIds,
        principal,
        undefined,
        responder,
        gate,
        attempted,
        attemptUsage,
        attemptBudget
      ),
      ...(this.providerOf(modelIds[0]) === undefined
        ? {}
        : { provider: this.providerOf(modelIds[0]) }),
      providerForModel: (model) =>
        this.providerOf(typeof model === "string" ? (attempted.configuredModel ?? model) : model),
      ...(selectedConfiguredModel === undefined ? {} : { selectedConfiguredModel }),
      ...(budgetLimits === undefined ? {} : { budgetLimits }),
      routing,
      attemptedModelId: () => attempted.modelId,
      failedAttemptUsage: () => attemptUsage.attempts,
      attemptBudget,
      respondingAttemptId: () => responder.attemptId,
      attemptedConfiguredModel: () => attempted.configuredModel,
      respondingConfiguredModel: () => responder.configuredModel,
      price: (tokensIn, tokensOut, configuredModel) =>
        this.priceFor(
          configuredModel ?? responder.configuredModel ?? responder.modelId,
          tokensIn,
          tokensOut
        ),
      reservationPrice: (tokensIn, tokensOut) =>
        this.reservationPrice(modelIds, tokensIn, tokensOut),
    };
  }

  async resolveModel(
    selector: string,
    requirements: ModelRequirements,
    inference?: RunEventEffortInference,
    principal?: PrincipalRef,
    gate?: FallbackCallGate
  ): Promise<LlmModelResolution> {
    await this.sync();

    const resolved = this.resolveSelector(selector, inference);
    if (resolved.kind === "raw_model") {
      const responder: ModelResponderRef = {};
      const attempted: ModelAttemptRef = {};
      const attemptUsage: FallbackAttemptUsageRef = { attempts: [] };
      const attemptBudget: FallbackAttemptBudgetRef = {};
      const selectedConfiguredModel = this.configuredIdentity(resolved.modelId);
      return {
        kind: "available",
        model: await this.service.chainModelFor(
          [resolved.modelId],
          principal,
          undefined,
          responder,
          gate,
          attempted,
          attemptUsage,
          attemptBudget
        ),
        ...(this.providerOf(resolved.modelId) === undefined
          ? {}
          : { provider: this.providerOf(resolved.modelId) }),
        providerForModel: (model) => this.providerOf(model),
        ...(selectedConfiguredModel === undefined ? {} : { selectedConfiguredModel }),
        routing: {
          outcome: "raw_model",
          selector,
          resolution: "raw_model_id",
          modelId: resolved.modelId,
        },
        attemptedModelId: () => attempted.modelId,
        failedAttemptUsage: () => attemptUsage.attempts,
        attemptBudget,
        respondingAttemptId: () => responder.attemptId,
        attemptedConfiguredModel: () => attempted.configuredModel,
        respondingConfiguredModel: () => responder.configuredModel,
        // A raw model id names exactly one model; nothing else could answer.
        price: (tokensIn, tokensOut, configuredModel) =>
          this.priceFor(
            configuredModel ?? responder.configuredModel ?? resolved.modelId,
            tokensIn,
            tokensOut
          ),
        reservationPrice: (tokensIn, tokensOut) =>
          this.reservationPrice([resolved.modelId], tokensIn, tokensOut),
      };
    }

    // Attach inference evidence only when it actually selected the profile.
    const evidence =
      resolved.resolution === "effort_inferred" && inference !== undefined
        ? { effortInference: inference }
        : {};

    const selection = selectModelProfile(resolved.profileId, requirements, this.catalog);
    if (selection.outcome === "denied") {
      return {
        kind: "denied",
        routing: {
          outcome: "denied",
          selector,
          resolution: resolved.resolution,
          profileId: selection.profileId,
          reason: selection.reason,
          attempts: selection.attempts,
          ...evidence,
        },
      };
    }
    const primary = selection.chain[0];
    if (primary === undefined) {
      return {
        kind: "denied",
        routing: {
          outcome: "denied",
          selector,
          resolution: resolved.resolution,
          profileId: selection.profileId,
          reason: "unknown_profile",
          attempts: [{ profileId: selection.profileId, reason: "unknown_profile" }],
          ...evidence,
        },
      };
    }
    const budgetLimits = resolveModelProfileBudgetLimits(primary);
    const budgetEvidence = modelBudgetEvidence(budgetLimits);
    const chain = selection.chain.map(configuredModelRef);

    // An unpriceable call cannot be charged against a cost ceiling, so a profile that declares one
    // must not route to a chain we cannot price — otherwise the ceiling is strictest on the models
    // we understand and absent on the ones we do not. Profiles with no cost ceiling are untouched:
    // there is nothing to enforce, and denying them would fail Runs that never asked for a limit.
    if (budgetLimits.costMicros !== undefined) {
      const unpriceable = this.unpriceableLink(chain);
      if (unpriceable !== undefined) {
        return {
          kind: "denied",
          routing: {
            outcome: "denied",
            selector,
            resolution: resolved.resolution,
            profileId: selection.profileId,
            reason: "cost_unpriceable",
            attempts: [{ profileId: selection.profileId, reason: "cost_unpriceable" }],
            ...evidence,
          },
        };
      }
    }

    const responder: ModelResponderRef = {};
    const attempted: ModelAttemptRef = {};
    const attemptUsage: FallbackAttemptUsageRef = { attempts: [] };
    const attemptBudget: FallbackAttemptBudgetRef = {};

    return {
      kind: "available",
      model: await this.service.chainModelFor(
        chain,
        principal,
        undefined,
        responder,
        gate,
        attempted,
        attemptUsage,
        attemptBudget
      ),
      ...(this.providerOf(chain[0]) === undefined ? {} : { provider: this.providerOf(chain[0]) }),
      providerForModel: (model) =>
        this.providerOf(typeof model === "string" ? (attempted.configuredModel ?? model) : model),
      selectedConfiguredModel: chain[0],
      ...(budgetEvidence === undefined ? {} : { budgetLimits }),
      // Attributed to the link that answered: a chain that rate-limits through to a cheaper model
      // must not be billed at the head model's price.
      price: (tokensIn, tokensOut, configuredModel) =>
        this.priceFor(
          configuredModel ?? responder.configuredModel ?? responder.modelId,
          tokensIn,
          tokensOut
        ),
      reservationPrice: (tokensIn, tokensOut) => this.reservationPrice(chain, tokensIn, tokensOut),
      routing: {
        outcome: "selected",
        selector,
        resolution: resolved.resolution,
        profileId: selection.profileId,
        chain: selection.chain.map((profile) => ({
          profileId: profile.profileId,
          modelId: profile.model,
          connection: configuredModelRef(profile).connection,
        })),
        cacheAllowed: selection.cacheAllowed,
        rejectedFallbacks: selection.rejectedFallbacks,
        ...(budgetEvidence === undefined ? {} : { budgetLimits: budgetEvidence }),
        ...evidence,
      },
      attemptedModelId: () => attempted.modelId,
      failedAttemptUsage: () => attemptUsage.attempts,
      attemptBudget,
      respondingAttemptId: () => responder.attemptId,
      attemptedConfiguredModel: () => attempted.configuredModel,
      respondingConfiguredModel: () => responder.configuredModel,
    };
  }

  /** Inferred rungs may lose; unresolved inference falls back to the participant selector. */
  private resolveSelector(
    selector: string,
    inference: RunEventEffortInference | undefined
  ): ResolvedProfileSelector {
    if (inference !== undefined) {
      const available = (id: string) => this.catalog.get(id) !== undefined;
      const profileId = resolveEffortPreset(inference.rung, this.presets, available);
      if (profileId !== undefined) {
        return { kind: "profile", profileId, resolution: "effort_inferred" };
      }
    }
    return this.resolveProfileSelector(selector);
  }

  /** Which ModelProfile a selector names, or that it is a raw provider Model ID. */
  private resolveProfileSelector(selector: string): ResolvedProfileSelector {
    const available = (id: string) => this.catalog.get(id) !== undefined;

    const preset = asEffortPreset(selector);
    if (preset !== undefined) {
      if (isDeprecatedTierAlias(selector)) {
        console.warn(
          `[llm] selector "${selector}" is a retired tier name; use the "${preset}" effort preset`
        );
      }
      const profileId = resolveEffortPreset(preset, this.presets, available);
      if (profileId !== undefined) {
        return { kind: "profile", profileId, resolution: "effort_preset" };
      }
    }

    return available(selector)
      ? { kind: "profile", profileId: selector, resolution: "profile_ref" }
      : { kind: "raw_model", modelId: selector };
  }

  /** Serializes provider rebuilds so concurrent turns never see a half-replaced service. */
  private async sync(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.rebuildIfChanged().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async rebuildIfChanged(): Promise<void> {
    const config = await this.options.source();
    const published = JSON.stringify(config ?? null);
    if (published === this.applied) return;
    // Store the promise so first turns share one unwrap; drop failures so boot order cannot poison later turns.
    this.secrets ??= this.options.secrets().catch((error: unknown) => {
      this.secrets = null;
      throw error;
    });
    const secrets = await this.secrets;
    await this.service.init(
      config,
      secrets,
      this.options.logger,
      new SecretsPrincipalCredentials(secrets)
    );
    this.rebuildCatalog(config);
    // Price corrections travel with the config they correct. A failure here must not fail the
    // turn: pricing degrades to the pinned specs and the built-in table, which is what the
    // deployment had before the operator wrote an override.
    this.overrides = (await this.options.pricingOverrides?.().catch(() => ({}))) ?? {};
    this.applied = published;
  }

  /** Derives profiles so deployments without authored ModelProfiles still use one router. */
  private rebuildCatalog(rawConfig: unknown): void {
    if (!rawConfig) {
      this.catalog = { get: () => undefined };
      this.presets = {};
      return;
    }

    let profiles: ReturnType<typeof deriveModelProfiles>;
    let presets: Parameters<typeof resolveEffortPreset>[1];
    try {
      const config = validateLlmConfig(rawConfig);
      profiles = deriveModelProfiles(config);
      presets = { presets: config.presets };
    } catch {
      // Invalid config leaves routing empty, producing denial instead of a mid-turn crash.
      this.catalog = { get: () => undefined };
      this.presets = {};
      return;
    }

    const byId = new Map(
      profiles
        // Unbuilt models are not routable; fallback must happen before selection commits.
        .filter((profile) => this.service.hasConfiguredModel(configuredModelRef(profile)))
        .map((profile) => [profile.profileId, profile])
    );
    this.catalog = { get: (id) => byId.get(id) };
    this.presets = presets;
  }
}

/** A profile that cannot serve the request. Carries the violated constraint as evidence. */
export class ModelProfileDeniedError extends Error {
  constructor(
    readonly profileId: string,
    readonly reason: string,
    readonly routing?: Extract<ModelRoutingPayload, { readonly outcome: "denied" }>
  ) {
    super(`model profile "${profileId}" denied: ${reason}`);
    this.name = "ModelProfileDeniedError";
  }
}
