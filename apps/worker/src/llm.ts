import type { ModelProfileCatalog, ModelRequirements } from "@tulipfarm/agent-runtime";
import { selectModelProfile } from "@tulipfarm/agent-runtime";
import { LlmService } from "@tulipfarm/llm";
import type { ResolvedLimits } from "@tulipfarm/run-kernel";
import { resolveModelProfileBudgetLimits } from "@tulipfarm/run-kernel";
import {
  asEffortPreset,
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

/**
 * The Soul's configured providers, kept current without a restart.
 *
 * The configuration lives in the Soul repository, which this app cannot read — it arrives over the
 * internal host. Reading it once at boot would mean an operator who edits `soul.yaml#llm` has to
 * restart every worker before the change takes effect, and would leave workers disagreeing about
 * which model a turn ran on in the meantime.
 *
 * So it is re-read before each model call and rebuilt only when it actually changed. The read is a
 * small local request next to a model round-trip, and the comparison is against the exact bytes
 * that were last applied, so an unchanged Soul costs nothing beyond that request.
 *
 * Credentials never travel: the configuration names `api_key_ref`s, and those are unwrapped here
 * against this process's own secret store.
 */
export interface SoulLlmOptions {
  /** Reads the published LLM configuration, or `undefined` when the Soul publishes none. */
  source(): Promise<unknown>;
  /**
   * Opens the secret store. Built on first use rather than at boot: it unwraps the active DEK,
   * which the API provisions, so a worker that starts first would otherwise refuse to boot over a
   * key it will happily find a moment later — and a deployment running no chat never needs it.
   */
  secrets(): Promise<SecretsService>;
}

export type ModelRoutingPayload = RunEventPayloads["model.routed"];

export type LlmModelResolution =
  | {
      readonly kind: "available";
      readonly model: LanguageModel;
      readonly routing: ModelRoutingPayload;
      readonly budgetLimits?: ResolvedLimits;
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

export class SoulLlm {
  private readonly service = new LlmService();
  /** The exact configuration the service was last built from; `null` before the first build. */
  private applied: string | null = null;
  private pending: Promise<void> | null = null;
  private secrets: Promise<SecretsService> | null = null;
  /** ModelProfiles derived from the applied configuration, keyed by profile id. */
  private catalog: ModelProfileCatalog = { get: () => undefined };
  private presets: Parameters<typeof resolveEffortPreset>[1] = {};

  constructor(private readonly options: SoulLlmOptions) {}

  /**
   * Resolve what a turn asked for into the model that will actually serve it.
   *
   * The selector is an effort preset, a ModelProfile id, or — for a Run minted before this existed,
   * whose request Artifact is immutable — a raw provider model id. All three converge on the same
   * router: a preset resolves to a profile, a profile is constraint-checked, and only a raw model id
   * bypasses routing, because there is nothing to check it against.
   *
   * The returned model is the **whole** selected chain, not its head. That is the fix for the
   * fallback that was configured but never reached: selection happened in the API and only the head
   * model id survived the hop, so this process rebuilt a single model and no backup provider was
   * ever tried.
   */
  async model(selector: string, requirements: ModelRequirements): Promise<LanguageModel> {
    const resolution = await this.resolveModel(selector, requirements);
    if (resolution.kind === "denied") {
      throw new ModelProfileDeniedError(
        resolution.routing.profileId,
        resolution.routing.reason,
        resolution.routing
      );
    }
    return resolution.model;
  }

  /**
   * Build an executable model over a chain that has **already** been selected.
   *
   * A Routine routes against its Run's own pinned bundle, so by the time it invokes, the profile
   * and its constraint-equivalent fallbacks are settled. Handing the profile id back to
   * `resolveModel` would re-resolve it against the catalog *derived from current config* — where a
   * bundle-authored profile id does not exist — and it would fall through to `raw_model`, quietly
   * discarding both the pinned bundle and every fallback the router had just chosen. So the chain
   * crosses this boundary as model ids, and only provider construction happens here.
   */
  async chainModel(modelIds: readonly string[]): Promise<LanguageModel> {
    await this.sync();
    return this.service.chainModel(modelIds);
  }

  async resolveModel(
    selector: string,
    requirements: ModelRequirements,
    inference?: RunEventEffortInference
  ): Promise<LlmModelResolution> {
    await this.sync();

    const resolved = this.resolveSelector(selector, inference);
    if (resolved.kind === "raw_model") {
      return {
        kind: "available",
        model: this.service.getModelById(resolved.modelId),
        routing: {
          outcome: "raw_model",
          selector,
          resolution: "raw_model_id",
          modelId: resolved.modelId,
        },
      };
    }

    // The evidence is attached only where it decided something. A turn that inferred a rung the
    // deployment does not configure fell back to the declared default, and claiming otherwise
    // would make the record name a route the Run did not take.
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

    return {
      kind: "available",
      model: this.service.chainModel(selection.chain.map((profile) => profile.model)),
      ...(budgetEvidence === undefined ? {} : { budgetLimits }),
      routing: {
        outcome: "selected",
        selector,
        resolution: resolved.resolution,
        profileId: selection.profileId,
        chain: selection.chain.map((profile) => ({
          profileId: profile.profileId,
          modelId: profile.model,
        })),
        cacheAllowed: selection.cacheAllowed,
        rejectedFallbacks: selection.rejectedFallbacks,
        ...(budgetEvidence === undefined ? {} : { budgetLimits: budgetEvidence }),
        ...evidence,
      },
    };
  }

  /**
   * Which ModelProfile serves this call, and how that was decided.
   *
   * An inferred rung is tried first and is allowed to lose: a deployment that configures no
   * `thorough` preset must still answer the turn, so an unresolvable inference falls through to
   * the selector the participant actually sent — `auto`, which resolves to the declared default.
   * Failing the turn instead would let a routing *preference* deny a turn that has a model to run.
   */
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

  /**
   * Rebuilds the providers when the configuration changed.
   *
   * Concurrent turns share one in-flight rebuild rather than each starting their own: two
   * simultaneous `init` calls on the same service would race to publish their provider maps, and
   * the loser's turn would run against a half-replaced set.
   */
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
    // Held as the promise, not the value, so concurrent first turns share one unwrap — but a
    // failed unwrap is dropped, or one boot ordering would poison every later turn.
    this.secrets ??= this.options.secrets().catch((error: unknown) => {
      this.secrets = null;
      throw error;
    });
    await this.service.init(config, await this.secrets);
    this.rebuildCatalog(config);
    this.applied = published;
  }

  /**
   * Build the routing catalog from the applied configuration.
   *
   * ModelProfiles are *derived* here rather than required to be authored, so that a deployment that
   * has not published any still routes through the one router instead of falling back to a second,
   * weaker selection mechanism — which is the split this convergence exists to close. An authored
   * catalog replaces this source without changing anything downstream.
   */
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
      // `LlmService.init` already logged and disabled itself on an invalid config; routing simply
      // has nothing to offer, which surfaces as an honest denial rather than a crash mid-turn.
      this.catalog = { get: () => undefined };
      this.presets = {};
      return;
    }

    const byId = new Map(
      profiles
        // A profile whose model never built (missing credentials, unknown provider) must not be
        // routable: selecting it would only fail later, past the point where fallback could help.
        .filter((profile) => this.service.hasModelId(profile.model))
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
