import type { ModelDataRetention, ModelProfileSpec, ModelReasoningLevel } from "@tulipfarm/schema";

/**
 * ModelProfile routing (SPEC §17). Model use is guardrail-driven through Soul-authored
 * ModelProfiles, never hard-coded in an Agent. A profile is usable only when it independently
 * meets every capability, Tool, structured-output, context, data-handling, residency, and budget
 * constraint of the request — and a fallback must meet exactly the same constraints, so degrading
 * to a weaker model is a denial rather than a silent downgrade.
 */

/** A published ModelProfile, flattened to the fields routing depends on. */
export interface RoutableModelProfile extends ModelProfileSpec {
  readonly profileId: string;
  readonly reasoning: ModelReasoningLevel;
}

export interface ModelProfileCatalog {
  get(profileId: string): RoutableModelProfile | undefined;
}

/** What the caller needs from a model for this Run, derived from Guardrail, Agent, and Context. */
export interface ModelRequirements {
  readonly needsTools: boolean;
  readonly needsStructuredOutput: boolean;
  readonly estimatedContextTokens: number;
  readonly estimatedCostUsd?: number;
  /** Sensitive work keeps caching off regardless of what the profile permits (SPEC §17). */
  readonly sensitive: boolean;
  /** Whether the data may be used for provider training. Defaults to forbidden. */
  readonly allowTraining?: boolean;
  readonly residency?: string;
  readonly dataRetention?: ModelDataRetention;
  readonly maxLatencyMs?: number;
  readonly requiredCapabilityClass?: string;
}

export type ModelProfileDenialReason =
  | "unknown_profile"
  | "tools_unsupported"
  | "structured_output_unsupported"
  | "context_window_exceeded"
  | "residency_violation"
  | "data_retention_violation"
  | "training_not_permitted"
  | "cost_budget_exceeded"
  | "token_budget_exceeded"
  | "latency_budget_exceeded"
  | "capability_class_mismatch";

export interface ModelProfileAttempt {
  readonly profileId: string;
  readonly reason: ModelProfileDenialReason;
}

export type ModelProfileSelection =
  | {
      readonly outcome: "selected";
      readonly profileId: string;
      /** Primary first, then every fallback that satisfies the same constraints, in order. */
      readonly chain: readonly RoutableModelProfile[];
      readonly cacheAllowed: boolean;
      readonly rejectedFallbacks: readonly ModelProfileAttempt[];
    }
  | {
      readonly outcome: "denied";
      readonly profileId: string;
      readonly reason: ModelProfileDenialReason;
      readonly attempts: readonly ModelProfileAttempt[];
    };

/** Data retention strength, narrowest first. A profile may never retain more than requested. */
const RETENTION_RANK: Readonly<Record<ModelDataRetention, number>> = {
  none: 0,
  zero_retention: 1,
  provider_default: 2,
};

/**
 * Checks one candidate against the request. Returns the first violated constraint so denial
 * evidence names a cause rather than a generic rejection.
 */
export function checkModelProfile(
  profile: RoutableModelProfile,
  requirements: ModelRequirements
): ModelProfileDenialReason | null {
  if (requirements.needsTools && !profile.supports.tools) return "tools_unsupported";
  if (requirements.needsStructuredOutput && !profile.supports.structuredOutput) {
    return "structured_output_unsupported";
  }
  if (requirements.estimatedContextTokens > profile.supports.contextWindowTokens) {
    return "context_window_exceeded";
  }
  if (
    requirements.requiredCapabilityClass !== undefined &&
    profile.capabilityClass !== requirements.requiredCapabilityClass
  ) {
    return "capability_class_mismatch";
  }

  const constraints = profile.constraints ?? {};
  if (requirements.residency !== undefined && constraints.residency !== requirements.residency) {
    return "residency_violation";
  }
  if (requirements.dataRetention !== undefined) {
    const permitted = RETENTION_RANK[requirements.dataRetention];
    const declared = constraints.dataRetention;
    // An undeclared retention posture is unverifiable, not permissive.
    if (declared === undefined || RETENTION_RANK[declared] > permitted) {
      return "data_retention_violation";
    }
  }
  if (constraints.allowTraining === true && requirements.allowTraining !== true) {
    return "training_not_permitted";
  }

  const costCeiling = constraints.maxCostUsd ?? profile.budgets?.maxCostUsd;
  if (
    requirements.estimatedCostUsd !== undefined &&
    costCeiling !== undefined &&
    requirements.estimatedCostUsd > costCeiling
  ) {
    return "cost_budget_exceeded";
  }
  const tokenCeiling = constraints.maxTokens ?? profile.budgets?.maxTokens;
  if (tokenCeiling !== undefined && requirements.estimatedContextTokens > tokenCeiling) {
    return "token_budget_exceeded";
  }
  if (
    requirements.maxLatencyMs !== undefined &&
    (constraints.maxLatencyMs === undefined || constraints.maxLatencyMs > requirements.maxLatencyMs)
  ) {
    return "latency_budget_exceeded";
  }
  return null;
}

/**
 * Resolves the named profile plus its ordered, constraint-equivalent fallback chain. The primary
 * profile decides the outcome: a primary that fails any constraint denies outright instead of
 * quietly routing to a fallback that would have been chosen for a weaker request.
 */
export function selectModelProfile(
  profileId: string,
  requirements: ModelRequirements,
  catalog: ModelProfileCatalog
): ModelProfileSelection {
  const primary = catalog.get(profileId);
  if (primary === undefined) {
    const attempt: ModelProfileAttempt = { profileId, reason: "unknown_profile" };
    return { outcome: "denied", profileId, reason: "unknown_profile", attempts: [attempt] };
  }

  const primaryViolation = checkModelProfile(primary, requirements);
  if (primaryViolation !== null) {
    return {
      outcome: "denied",
      profileId,
      reason: primaryViolation,
      attempts: [{ profileId, reason: primaryViolation }],
    };
  }

  const chain: RoutableModelProfile[] = [primary];
  const rejected: ModelProfileAttempt[] = [];
  const seen = new Set<string>([primary.profileId]);
  const queue = [...(primary.fallbacks ?? [])];

  while (queue.length > 0) {
    const candidateId = queue.shift() as string;
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);

    const candidate = catalog.get(candidateId);
    if (candidate === undefined) {
      rejected.push({ profileId: candidateId, reason: "unknown_profile" });
      continue;
    }
    const violation = checkModelProfile(candidate, requirements);
    if (violation !== null) {
      rejected.push({ profileId: candidateId, reason: violation });
      continue;
    }
    chain.push(candidate);
    queue.push(...(candidate.fallbacks ?? []));
  }

  return {
    outcome: "selected",
    profileId,
    chain: Object.freeze(chain),
    // Sensitive caching is off by default and cannot be re-enabled by the profile (SPEC §17).
    cacheAllowed: primary.allowCaching && !requirements.sensitive,
    rejectedFallbacks: Object.freeze(rejected),
  };
}
