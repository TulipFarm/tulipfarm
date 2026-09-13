/** Guardrail evidence for one approval: what demanded a human, recorded at the instant it did. */

import { canonicalHash } from "@tulipfarm/schema";
import type { ApprovalDemandEvidence } from "@tulipfarm/tool-broker";

const APPROVAL_DEMAND_SOURCES = new Set([
  "autonomy_policy",
  "guardrail_rule",
  "sandbox_contract",
  "tool_contract",
]);

/**
 * Why an approval was asked for, as the policy evaluation that asked stated it (I-13).
 *
 * `autonomy_policy` is the third producer: the Turn declared `approval-required` autonomy, so a
 * mutating Tool needs a human even where no Guardrail rule and no contract demanded one. It is
 * named rather than folded into the Guardrail cases so the record never claims a rule fired.
 */
export interface ApprovalGuardrailEvidence {
  readonly demandedBy: ApprovalDemandEvidence["requiredBy"] | "autonomy_policy" | "tool_contract";
  /** Guardrail revision the demanding evaluation ran against; "none" when none was bound. */
  readonly guardrailRevision: string;
  readonly reason: string;
  /** The Guardrail rule that decided, when a rule did. */
  readonly ruleId?: string;
  readonly toolName: string;
  /** The exact intent the approver is being asked about, as {@link intentOf} computes it. */
  readonly intentDigest: string;
  readonly demandedAt: string;
}

/** What a caller knows about the demand before the intent is digested. */
export type ApprovalDemand = Pick<
  ApprovalGuardrailEvidence,
  "demandedBy" | "guardrailRevision" | "reason" | "ruleId"
>;

/** The demand a Turn's own autonomy setting makes, where no rule and no contract made one. */
export const AUTONOMY_APPROVAL_DEMAND: Pick<ApprovalDemand, "demandedBy" | "reason"> = {
  demandedBy: "autonomy_policy",
  reason: "autonomy_requires_approval",
};

export const DECLARED_TOOL_APPROVAL_DEMAND: Pick<ApprovalDemand, "demandedBy" | "reason"> = {
  demandedBy: "tool_contract",
  reason: "tool_requires_approval",
};

/**
 * The demand a gate reported without attributing it. Recorded verbatim rather than guessed at: an
 * approval that names a rule which never fired is worse evidence than one that names nothing.
 */
export const UNATTRIBUTED_APPROVAL_DEMAND: Pick<ApprovalDemand, "demandedBy" | "reason"> = {
  demandedBy: "guardrail_rule",
  reason: "unattributed",
};

/** Content address of the evidence; recomputed before any decision to detect substitution. */
export function approvalEvidenceDigest(evidence: ApprovalGuardrailEvidence): string {
  return canonicalHash({
    demandedBy: evidence.demandedBy,
    guardrailRevision: evidence.guardrailRevision,
    reason: evidence.reason,
    ruleId: evidence.ruleId ?? null,
    toolName: evidence.toolName,
    intentDigest: evidence.intentDigest,
    demandedAt: evidence.demandedAt,
  });
}

/** Reads a stored evidence value back, or `null` when the row holds nothing usable. */
export function readApprovalEvidence(value: unknown): ApprovalGuardrailEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        ![
          "demandedBy",
          "guardrailRevision",
          "reason",
          "ruleId",
          "toolName",
          "intentDigest",
          "demandedAt",
        ].includes(key)
    )
  ) {
    return null;
  }
  const candidate = value as Partial<ApprovalGuardrailEvidence>;
  if (
    typeof candidate.demandedBy !== "string" ||
    !APPROVAL_DEMAND_SOURCES.has(candidate.demandedBy) ||
    typeof candidate.guardrailRevision !== "string" ||
    candidate.guardrailRevision.length === 0 ||
    typeof candidate.reason !== "string" ||
    candidate.reason.length === 0 ||
    (candidate.ruleId !== undefined &&
      (typeof candidate.ruleId !== "string" || candidate.ruleId.length === 0)) ||
    typeof candidate.toolName !== "string" ||
    candidate.toolName.length === 0 ||
    typeof candidate.intentDigest !== "string" ||
    candidate.intentDigest.length === 0 ||
    typeof candidate.demandedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.demandedAt)) ||
    new Date(candidate.demandedAt).toISOString() !== candidate.demandedAt
  ) {
    return null;
  }
  return candidate as ApprovalGuardrailEvidence;
}
