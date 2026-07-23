/**
 * Guardrail decision contract (SPEC §12, §20, §24). Decisions are deterministic and carry only
 * safe reason evidence: a reason code, the deciding rule id, the failing dimension name, or a
 * data classification name. Context values (record ids, destinations, field contents, payloads,
 * Secrets) never appear in a decision, so denial evidence cannot reveal protected content
 * (SPEC §13 DLP, §20 audit reason codes).
 */

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
