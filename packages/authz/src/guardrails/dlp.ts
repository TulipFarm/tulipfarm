/**
 * DLP boundary check (SPEC §13): before data crosses a model, Tool, integration, sandbox, UI,
 * notification, or export boundary, every crossing data classification must have a DLP rule
 * permitting the destination and audience. Default deny: unclassified data, a class with no
 * rule, or a detected secret denies. Denials carry only the reason code and the classification
 * name — never destination, audience, field values, or content — so a blocked response cannot
 * reveal the protected content through its evidence.
 */

import type { GuardrailDecision } from "./decision";

export interface DlpRule {
  /** Data classification this rule permits to cross. */
  readonly dataClass: string;
  /** Destinations permitted; absent leaves destination unconstrained for this class. */
  readonly allowedDestinations?: readonly string[];
  /** Audiences permitted; absent leaves audience unconstrained for this class. */
  readonly allowedAudiences?: readonly string[];
}

/** Data about to cross a boundary; absent dimensions mean "not established". */
export interface DlpCrossing {
  /** Classifications of every piece of crossing data; empty means unverifiable. */
  readonly dataClasses: readonly string[];
  readonly destination?: string;
  readonly audience?: string;
  /** True when a secret scan flagged the crossing content. */
  readonly secretDetected?: boolean;
}

/**
 * Decides whether `crossing` may pass. Allowed only when no secret is detected, the data is
 * classified, and every class has a rule whose destination and audience scopes are satisfied —
 * a scoped rule never permits a crossing that omits the scoped dimension (fail closed).
 */
export function checkDlpBoundary(
  rules: readonly DlpRule[],
  crossing: DlpCrossing
): GuardrailDecision {
  if (crossing.secretDetected) {
    return { effect: "deny", reason: "secret_detected" };
  }
  if (crossing.dataClasses.length === 0) {
    return { effect: "deny", reason: "unclassified_data" };
  }
  for (const dataClass of crossing.dataClasses) {
    const classRules = rules.filter((rule) => rule.dataClass === dataClass);
    if (classRules.length === 0) {
      return { effect: "deny", reason: "no_dlp_rule", dataClass };
    }
    let destinationPassed = false;
    let permitted = false;
    for (const rule of classRules) {
      const destinationOk =
        rule.allowedDestinations === undefined ||
        (crossing.destination !== undefined &&
          rule.allowedDestinations.includes(crossing.destination));
      if (!destinationOk) continue;
      destinationPassed = true;
      const audienceOk =
        rule.allowedAudiences === undefined ||
        (crossing.audience !== undefined && rule.allowedAudiences.includes(crossing.audience));
      if (audienceOk) {
        permitted = true;
        break;
      }
    }
    if (!permitted) {
      return {
        effect: "deny",
        reason: destinationPassed ? "audience_not_allowed" : "destination_not_allowed",
        dataClass,
      };
    }
  }
  return { effect: "allow", reason: "allowed" };
}
