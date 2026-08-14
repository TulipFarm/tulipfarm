/** Guardrail decisions expose only safe reason evidence, never payloads or Secrets. */

export type GuardrailEffect = "allow" | "deny" | "require_approval";

export type GuardrailDecisionReason =
  | "allowed"
  | "approval_required"
  | "explicit_deny"
  | "no_matching_rule"
  | "missing_context"
  | "volume_exceeded"
  | "taint_exceeded"
  | "autonomy_exceeded"
  | "unclassified_data"
  | "no_dlp_rule"
  | "destination_not_allowed"
  | "audience_not_allowed"
  | "secret_detected";

export interface GuardrailDecision {
  readonly effect: GuardrailEffect;
  readonly reason: GuardrailDecisionReason;
  /** Id of the rule that decided (denied, required approval, or allowed), when one did. */
  readonly ruleId?: string;
  /** Name of the Context dimension that failed a ceiling (e.g. "recordCount", "taint"). */
  readonly dimension?: string;
  /** Data classification name a DLP denial is about — the class name, never the content. */
  readonly dataClass?: string;
}
