/**
 * Deterministic Guardrail evaluation over action, Resource type, Record, field, data class,
 * destination, audience, volume, taint, and autonomy (SPEC §12). Default deny: with no fully
 * matching allow the decision is a denial. Selector scoping mirrors AccessGrant matching — a
 * rule scoped to a dimension never matches a Context that omits it, for allow and deny alike,
 * so a rule cannot silently widen (SPEC §24 fail-closed defaults). Ceilings (volume, taint,
 * autonomy) deny when exceeded and deny as unverifiable when the Context omits the measured
 * value (missing Context is never assumed safe, SPEC §13). Evaluation is a pure function of its
 * arguments; evidence rules live in ./decision.
 */

import type { GuardrailDecision, GuardrailEffect } from "./decision";
import { type AutonomyLevel, autonomyWithin, type TaintLevel, taintWithin } from "./risk";

export interface GuardrailRule {
  readonly id: string;
  readonly effect: GuardrailEffect;
  /** Action identifier (e.g. "record.read") or "*" for any action. */
  readonly action: string;
  /** Resource type name or "*" for any type. */
  readonly resourceType: string;
  /** Specific Record id; absent or "*" covers every Record of the type. */
  readonly recordSelector?: string;
  /** Fields covered; present, it only matches field-level Contexts. */
  readonly fieldSelector?: readonly string[];
  /** Data classification the rule is scoped to; absent covers any classification. */
  readonly dataClass?: string;
  /** Destination the rule is scoped to; absent covers any destination. */
  readonly destination?: string;
  /** Audience the rule is scoped to; absent covers any audience. */
  readonly audience?: string;
  /** Volume ceiling: highest record count this rule permits. Ignored on deny rules. */
  readonly maxRecordCount?: number;
  /** Taint ceiling: most-tainted input influence this rule permits. Ignored on deny rules. */
  readonly maxTaint?: TaintLevel;
  /** Autonomy ceiling: most-autonomous mode this rule permits. Ignored on deny rules. */
  readonly maxAutonomy?: AutonomyLevel;
}

/** The concrete guarded action being decided; absent dimensions mean "not established". */
export interface GuardrailContext {
  readonly action: string;
  readonly resourceType: string;
  readonly recordId?: string;
  readonly field?: string;
  readonly dataClass?: string;
  readonly destination?: string;
  readonly audience?: string;
  readonly recordCount?: number;
  readonly taint?: TaintLevel;
  readonly autonomy?: AutonomyLevel;
}

function selectorsMatch(rule: GuardrailRule, context: GuardrailContext): boolean {
  if (rule.action !== "*" && rule.action !== context.action) return false;
  if (rule.resourceType !== "*" && rule.resourceType !== context.resourceType) return false;
  if (
    rule.recordSelector !== undefined &&
    rule.recordSelector !== "*" &&
    rule.recordSelector !== context.recordId
  ) {
    return false;
  }
  if (
    rule.fieldSelector !== undefined &&
    (context.field === undefined || !rule.fieldSelector.includes(context.field))
  ) {
    return false;
  }
  if (rule.dataClass !== undefined && rule.dataClass !== context.dataClass) return false;
  if (rule.destination !== undefined && rule.destination !== context.destination) return false;
  if (rule.audience !== undefined && rule.audience !== context.audience) return false;
  return true;
}

/** A ceiling denial for `rule`, or undefined when every ceiling is satisfied. */
function checkCeilings(
  rule: GuardrailRule,
  context: GuardrailContext
): GuardrailDecision | undefined {
  if (rule.maxRecordCount !== undefined) {
    if (context.recordCount === undefined) {
      return {
        effect: "deny",
        reason: "missing_context",
        ruleId: rule.id,
        dimension: "recordCount",
      };
    }
    if (context.recordCount > rule.maxRecordCount) {
      return {
        effect: "deny",
        reason: "volume_exceeded",
        ruleId: rule.id,
        dimension: "recordCount",
      };
    }
  }
  if (rule.maxTaint !== undefined) {
    if (context.taint === undefined) {
      return { effect: "deny", reason: "missing_context", ruleId: rule.id, dimension: "taint" };
    }
    if (!taintWithin(context.taint, rule.maxTaint)) {
      return { effect: "deny", reason: "taint_exceeded", ruleId: rule.id, dimension: "taint" };
    }
  }
  if (rule.maxAutonomy !== undefined) {
    if (context.autonomy === undefined) {
      return { effect: "deny", reason: "missing_context", ruleId: rule.id, dimension: "autonomy" };
    }
    if (!autonomyWithin(context.autonomy, rule.maxAutonomy)) {
      return {
        effect: "deny",
        reason: "autonomy_exceeded",
        ruleId: rule.id,
        dimension: "autonomy",
      };
    }
  }
  return undefined;
}

/**
 * Decides `context` against `rules` in order. Precedence: a matching explicit deny wins; then a
 * fully passing require_approval (stricter than allow); then a fully passing allow; then the
 * first ceiling denial among matching candidates; otherwise default deny (`no_matching_rule`).
 */
export function evaluateGuardrail(
  rules: readonly GuardrailRule[],
  context: GuardrailContext
): GuardrailDecision {
  let approval: GuardrailDecision | undefined;
  let allow: GuardrailDecision | undefined;
  let ceilingDenial: GuardrailDecision | undefined;

  for (const rule of rules) {
    if (!selectorsMatch(rule, context)) continue;
    if (rule.effect === "deny") {
      return { effect: "deny", reason: "explicit_deny", ruleId: rule.id };
    }
    const denial = checkCeilings(rule, context);
    if (denial) {
      ceilingDenial ??= denial;
      continue;
    }
    if (rule.effect === "require_approval") {
      approval ??= { effect: "require_approval", reason: "approval_required", ruleId: rule.id };
    } else {
      allow ??= { effect: "allow", reason: "allowed", ruleId: rule.id };
    }
  }

  return approval ?? allow ?? ceilingDenial ?? { effect: "deny", reason: "no_matching_rule" };
}
