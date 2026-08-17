import {
  type AuthorityLayer,
  checkDlpBoundary,
  type DlpRule,
  decideEffectivePermission,
  evaluateGuardrail,
  type GuardrailDecisionReason,
  type GuardrailRule,
} from "@tulipfarm/authz";
import type { PublishedToolContract } from "./contract";
import type { ToolIntent } from "./intent";
import type { ToolRiskContext } from "./risk";

export interface ToolAuthorizationContext extends ToolRiskContext {
  readonly authorityLayers: readonly AuthorityLayer[];
  readonly guardrailRules: readonly GuardrailRule[];
  readonly dlpRules: readonly DlpRule[];
  readonly guardrailRevision: string;
  readonly autonomy?:
    | "answer_only"
    | "propose_actions"
    | "execute_low_risk"
    | "execute_policy_authorized";
  readonly audience?: string;
  readonly secretDetected?: boolean;
  readonly now?: Date;
}

export type ToolAuthorizationDenialReason =
  | "authorization_denied"
  | "guardrail_denied"
  | "dlp_denied"
  | "destination_denied"
  | "missing_guardrail_revision";

/**
 * Why this policy evaluation demanded a human. Carried out of the decision so the approval a
 * caller then creates can be bound to the evaluation that caused it, rather than to the bare fact
 * that something did (I-13).
 */
export interface ApprovalDemandEvidence {
  readonly requiredBy: "guardrail_rule" | "sandbox_contract";
  readonly reason: GuardrailDecisionReason | "sandbox_mutating_adapter";
  /** Id of the Guardrail rule whose `require_approval` effect decided; absent for the contract. */
  readonly ruleId?: string;
}

export type ToolPolicyOutcome =
  | { readonly outcome: "authorized" }
  | { readonly outcome: "awaiting_approval"; readonly demand?: ApprovalDemandEvidence }
  | { readonly outcome: "denied"; readonly reason: ToolAuthorizationDenialReason };

function protectedRequests(intent: ToolIntent, contract: PublishedToolContract) {
  const actions = contract.requiredActions.length > 0 ? contract.requiredActions : [intent.action];
  const targets =
    intent.targetRefs.length > 0
      ? intent.targetRefs
      : contract.requiredResources.map((type) => ({ type, id: undefined }));
  const resolvedTargets =
    targets.length > 0 ? targets : [{ type: "Tool", id: contract.toolId as string | undefined }];
  return actions.flatMap((action) =>
    resolvedTargets.map((target) => ({
      action,
      resourceType: target.type,
      recordId: target.id,
      ...("domain" in target && target.domain !== undefined ? { domain: target.domain } : {}),
      dataClass: contract.dataClasses[0],
      destination: intent.destination,
    }))
  );
}

export function authorizeToolIntent(
  intent: ToolIntent,
  contract: PublishedToolContract,
  context: ToolAuthorizationContext
): ToolPolicyOutcome {
  if (context.guardrailRevision.length === 0) {
    return { outcome: "denied", reason: "missing_guardrail_revision" };
  }
  if (
    intent.destination !== undefined &&
    !contract.allowedDestinations.includes(intent.destination)
  ) {
    return { outcome: "denied", reason: "destination_denied" };
  }

  // A sandbox script may perform an opaque provider mutation. Its source and exact intent must be
  // approved even when a broader Guardrail would normally allow unattended low-risk execution.
  let demand: ApprovalDemandEvidence | undefined =
    contract.adapter.kind === "sandbox" && contract.mutating
      ? { requiredBy: "sandbox_contract", reason: "sandbox_mutating_adapter" }
      : undefined;
  for (const request of protectedRequests(intent, contract)) {
    const authz = decideEffectivePermission(context.authorityLayers, request, context.now);
    if (!authz.allowed) return { outcome: "denied", reason: "authorization_denied" };
    const guardrail = evaluateGuardrail(context.guardrailRules, {
      ...request,
      recordCount: context.recordCount,
      taint: context.taint,
      autonomy: context.autonomy,
      audience: context.audience,
    });
    if (guardrail.effect === "deny") {
      return { outcome: "denied", reason: "guardrail_denied" };
    }
    // The first rule that demands a human is the one the approver is shown; a later rule saying
    // the same thing adds no evidence, and overwriting would attribute the ask to the wrong rule.
    if (guardrail.effect === "require_approval" && demand === undefined) {
      demand = {
        requiredBy: "guardrail_rule",
        reason: guardrail.reason,
        ...(guardrail.ruleId === undefined ? {} : { ruleId: guardrail.ruleId }),
      };
    }
  }

  const dlp = checkDlpBoundary(context.dlpRules, {
    dataClasses: contract.dataClasses,
    destination: intent.destination,
    audience: context.audience,
    secretDetected: context.secretDetected,
  });
  if (dlp.effect === "deny") return { outcome: "denied", reason: "dlp_denied" };
  return demand === undefined
    ? { outcome: "authorized" }
    : { outcome: "awaiting_approval", demand };
}
