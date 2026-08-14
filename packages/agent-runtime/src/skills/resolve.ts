import type { DefinitionTrustTier } from "@tulipfarm/schema";

/** Skill resolution records exact versions; Skills can require abilities, never grant them. */

export interface SkillRef {
  readonly skillId: string;
  readonly version: string;
}

export type SkillScanStatus = "clean" | "pending" | "rejected";

export interface ResolvableSkill extends SkillRef {
  readonly digest: string;
  readonly trustTier: DefinitionTrustTier;
  readonly scan: { readonly status: SkillScanStatus; readonly scannedDigest?: string };
  readonly dependencies: readonly SkillRef[];
  readonly requiredToolAbilities: readonly string[];
  readonly contextTokens: number;
}

export interface SkillCatalog {
  get(skillId: string, version: string): ResolvableSkill | undefined;
}

/** Guardrail-owned trust policy: which tiers may run, and which must carry a current clean scan. */
export interface SkillTrustPolicy {
  readonly allowedTiers: readonly DefinitionTrustTier[];
  readonly requireScanForTiers: readonly DefinitionTrustTier[];
}

export type SkillSelectionReason = "requested" | "dependency";

export interface ResolvedSkill extends SkillRef {
  readonly digest: string;
  readonly trustTier: DefinitionTrustTier;
  readonly selectionReason: SkillSelectionReason;
  readonly requiredBy: readonly string[];
  readonly contextTokens: number;
}

export type SkillResolutionDenialReason =
  | "unknown_skill"
  | "version_conflict"
  | "trust_tier_forbidden"
  | "scan_required"
  | "missing_tool_ability"
  | "context_budget_exceeded";

export type SkillResolution =
  | {
      readonly outcome: "resolved";
      readonly skills: readonly ResolvedSkill[];
      /** Intersection of declared needs with held abilities. Never a superset. */
      readonly abilities: readonly string[];
      readonly contextTokens: number;
      /** Stable identity of this exact selection set, for evidence and replay comparison. */
      readonly selectionKey: string;
    }
  | {
      readonly outcome: "denied";
      readonly reason: SkillResolutionDenialReason;
      readonly skillRef: string;
      readonly detail?: string;
    };

export interface ResolveSkillsInput {
  readonly selections: readonly SkillRef[];
  readonly catalog: SkillCatalog;
  readonly trustPolicy: SkillTrustPolicy;
  /** Tool abilities the invoking user/Agent intersection already holds. */
  readonly grantedToolAbilities: readonly string[];
  readonly contextBudgetTokens: number;
}

export function skillRef(ref: SkillRef): string {
  return `${ref.skillId}@${ref.version}`;
}

function denied(
  reason: SkillResolutionDenialReason,
  ref: string,
  detail?: string
): SkillResolution {
  return detail === undefined
    ? { outcome: "denied", reason, skillRef: ref }
    : { outcome: "denied", reason, skillRef: ref, detail };
}

export function resolveSkills(input: ResolveSkillsInput): SkillResolution {
  const resolved = new Map<string, ResolvedSkill>();
  const selectedVersions = new Map<string, string>();
  const granted = new Set(input.grantedToolAbilities);
  const abilities = new Set<string>();

  const queue: { readonly ref: SkillRef; readonly requiredBy?: string }[] = input.selections.map(
    (ref) => ({ ref })
  );

  while (queue.length > 0) {
    const item = queue.shift() as { ref: SkillRef; requiredBy?: string };
    const ref = skillRef(item.ref);

    const pinned = selectedVersions.get(item.ref.skillId);
    if (pinned !== undefined && pinned !== item.ref.version) {
      // Two exact versions of one Skill is a conflict to report, not a silent "latest wins".
      return denied("version_conflict", ref, `${item.ref.skillId}@${pinned}`);
    }

    const existing = resolved.get(ref);
    if (existing !== undefined) {
      if (item.requiredBy !== undefined && !existing.requiredBy.includes(item.requiredBy)) {
        resolved.set(ref, {
          ...existing,
          requiredBy: [...existing.requiredBy, item.requiredBy],
        });
      }
      continue;
    }

    const skill = input.catalog.get(item.ref.skillId, item.ref.version);
    if (skill === undefined) return denied("unknown_skill", ref);

    if (!input.trustPolicy.allowedTiers.includes(skill.trustTier)) {
      return denied("trust_tier_forbidden", ref, skill.trustTier);
    }
    if (input.trustPolicy.requireScanForTiers.includes(skill.trustTier)) {
      // Changed executable content invalidates its scan: the scan must name the current digest.
      if (skill.scan.status !== "clean" || skill.scan.scannedDigest !== skill.digest) {
        return denied("scan_required", ref, skill.scan.status);
      }
    }
    if (skill.scan.status === "rejected") return denied("scan_required", ref, "rejected");

    for (const ability of skill.requiredToolAbilities) {
      if (!granted.has(ability)) return denied("missing_tool_ability", ref, ability);
      abilities.add(ability);
    }

    selectedVersions.set(item.ref.skillId, item.ref.version);
    resolved.set(ref, {
      skillId: skill.skillId,
      version: skill.version,
      digest: skill.digest,
      trustTier: skill.trustTier,
      selectionReason: item.requiredBy === undefined ? "requested" : "dependency",
      requiredBy: item.requiredBy === undefined ? [] : [item.requiredBy],
      contextTokens: skill.contextTokens,
    });

    for (const dependency of skill.dependencies) {
      queue.push({ ref: dependency, requiredBy: ref });
    }
  }

  const skills = [...resolved.values()];
  const contextTokens = skills.reduce((total, entry) => total + entry.contextTokens, 0);
  if (contextTokens > input.contextBudgetTokens) {
    return denied("context_budget_exceeded", skills.map(skillRef).join(","));
  }

  return {
    outcome: "resolved",
    skills: Object.freeze(skills),
    abilities: Object.freeze([...abilities].sort()),
    contextTokens,
    selectionKey: skills.map(skillRef).sort().join("|"),
  };
}
