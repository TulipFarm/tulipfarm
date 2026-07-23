/**
 * Risk dimension orderings for Guardrail ceilings (SPEC §13). Taint tracks whether untrusted
 * input influenced the action; autonomy tracks how much human oversight the Run has. Both are
 * totally ordered so a ceiling check is deterministic: an actual level is within a ceiling only
 * when its rank does not exceed the ceiling's rank.
 */

export type TaintLevel = "trusted" | "untrusted";

export type AutonomyLevel = "interactive" | "approved" | "autonomous";

const TAINT_RANK: Readonly<Record<TaintLevel, number>> = {
  trusted: 0,
  untrusted: 1,
};

const AUTONOMY_RANK: Readonly<Record<AutonomyLevel, number>> = {
  interactive: 0,
  approved: 1,
  autonomous: 2,
};

/** True when `actual` taint is at or below the `ceiling`. */
export function taintWithin(actual: TaintLevel, ceiling: TaintLevel): boolean {
  return TAINT_RANK[actual] <= TAINT_RANK[ceiling];
}

/** True when `actual` autonomy is at or below the `ceiling`. */
export function autonomyWithin(actual: AutonomyLevel, ceiling: AutonomyLevel): boolean {
  return AUTONOMY_RANK[actual] <= AUTONOMY_RANK[ceiling];
}
