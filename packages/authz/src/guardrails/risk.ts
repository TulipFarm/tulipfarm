/**
 * Risk dimension orderings for Guardrail ceilings (SPEC §13). Taint tracks whether untrusted
 * input influenced the action; autonomy uses the canonical Agent autonomy ceilings from the
 * authored schema. Both are totally ordered so a ceiling check is deterministic: an actual level
 * is within a ceiling only when its rank does not exceed the ceiling's rank.
 */

import type { AgentAutonomyCeiling } from "@tulipfarm/schema";

export type TaintLevel = "trusted" | "untrusted";

export type AutonomyLevel = AgentAutonomyCeiling;

const TAINT_RANK: Readonly<Record<TaintLevel, number>> = {
  trusted: 0,
  untrusted: 1,
};

const AUTONOMY_RANK: Readonly<Record<AutonomyLevel, number>> = {
  answer_only: 0,
  propose_actions: 1,
  execute_low_risk: 2,
  execute_policy_authorized: 3,
};

/** True when `actual` taint is at or below the `ceiling`. */
export function taintWithin(actual: TaintLevel, ceiling: TaintLevel): boolean {
  return TAINT_RANK[actual] <= TAINT_RANK[ceiling];
}

/** True when `actual` autonomy is at or below the `ceiling`. */
export function autonomyWithin(actual: AutonomyLevel, ceiling: AutonomyLevel): boolean {
  return AUTONOMY_RANK[actual] <= AUTONOMY_RANK[ceiling];
}
