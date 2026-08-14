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

/** Keeps published LLM config hot; credentials stay as `api_key_ref`s unwrapped in Worker. */
export interface SoulLlmOptions {
  /** Reads the published LLM configuration, or `undefined` when the Soul publishes none. */
  source(): Promise<unknown>;
  /** Lazy because the API provisions the active DEK and some deployments never chat. */
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

  /** Resolves selectors to the full selected chain; raw model ids bypass profile checks. */
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

  /** Builds an already-routed Routine chain without re-resolving against current config. */
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
    await this.service.init(config, await this.secrets);
    this.rebuildCatalog(config);
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
