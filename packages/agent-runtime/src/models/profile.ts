import type {
  ModelDataRetention,
  ModelModality,
  ModelProfileSpec,
  ModelReasoningLevel,
  ModelProfileDenialReason as SchemaModelProfileDenialReason,
} from "@tulipfarm/schema";

/** Governed ModelProfile routing; fallbacks must satisfy the same constraints. */

export interface RoutableModelProfile extends ModelProfileSpec {
  readonly profileId: string;
  readonly reasoning: ModelReasoningLevel;
}

export interface ModelProfileCatalog {
  get(profileId: string): RoutableModelProfile | undefined;
}

export interface ModelRequirements {
  readonly needsTools: boolean;
  readonly needsStructuredOutput: boolean;
  readonly estimatedContextTokens: number;
  readonly estimatedCostUsd?: number;
  readonly sensitive: boolean;
  readonly allowTraining?: boolean;
  readonly residency?: string;
  readonly dataRetention?: ModelDataRetention;
  readonly maxLatencyMs?: number;
  readonly requiredCapabilityClass?: string;
  /** Required modalities must be declared; unsupported content is denied, never dropped. */
  readonly inputModalities?: readonly ModelModality[];
  readonly outputModalities?: readonly ModelModality[];
}

export type ModelProfileDenialReason = SchemaModelProfileDenialReason;

export interface ModelProfileAttempt {
  readonly profileId: string;
  readonly reason: ModelProfileDenialReason;
}

export type ModelProfileSelection =
  | {
      readonly outcome: "selected";
      readonly profileId: string;
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

/** Retention strength, narrowest first; a profile may never retain more than requested. */
const RETENTION_RANK: Readonly<Record<ModelDataRetention, number>> = {
  none: 0,
  zero_retention: 1,
  provider_default: 2,
};

const DEFAULT_MODALITIES: readonly ModelModality[] = ["text"];

function covers(
  declared: readonly ModelModality[] | undefined,
  required: readonly ModelModality[] | undefined
): boolean {
  if (required === undefined || required.length === 0) return true;
  const supported = declared ?? DEFAULT_MODALITIES;
  return required.every((modality) => supported.includes(modality));
}

/** Checks one candidate and returns the first violated constraint for denial evidence. */
export function checkModelProfile(
  profile: RoutableModelProfile,
  requirements: ModelRequirements
): ModelProfileDenialReason | null {
  if (requirements.needsTools && !profile.supports.tools) return "tools_unsupported";
  if (requirements.needsStructuredOutput && !profile.supports.structuredOutput) {
    return "structured_output_unsupported";
  }
  if (
    !covers(profile.supports.inputModalities, requirements.inputModalities) ||
    !covers(profile.supports.outputModalities, requirements.outputModalities)
  ) {
    return "modality_unsupported";
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

  const costCeiling = constraints.maxCostUsd;
  if (
    requirements.estimatedCostUsd !== undefined &&
    costCeiling !== undefined &&
    requirements.estimatedCostUsd > costCeiling
  ) {
    return "cost_budget_exceeded";
  }
  const tokenCeiling = constraints.maxTokens;
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

/** Resolve primary plus constraint-equivalent fallbacks; primary failure denies outright. */
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
