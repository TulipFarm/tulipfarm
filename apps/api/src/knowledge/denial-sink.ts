import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { KnowledgeDenialSink } from "@tulipfarm/knowledge";
import type { AuditService } from "../audit/service";

/**
 * Sends refused Knowledge writes to the audit ledger.
 *
 * `recordOrWarn` rather than `record`: a ledger outage must not change what the caller is told, or
 * the refusal stops looking like an ordinary "not found" and becomes the oracle the gate closed.
 *
 * The target is the Knowledge boundary, never the Page, path or Space the actor aimed at — naming a
 * withheld subject here would re-expose it to every reader of the ledger. `auditRetrieval` withholds
 * the same way. What survives is enough to spot probing: who, what action, and how often.
 */
export function knowledgeDenialSink(audit: AuditService): KnowledgeDenialSink {
  return {
    recordWriteDenial: (denial) =>
      audit.recordOrWarn({
        ...(denial.actorId === undefined ? {} : { actorId: denial.actorId }),
        action: denial.action,
        target: `knowledge:${DEPLOYMENT_BUSINESS_ID}`,
        decision: "deny",
        reasonCodes: ["access_denied"],
        ...(denial.agentId === undefined ? {} : { agentId: denial.agentId }),
        ...(denial.correlationId === undefined ? {} : { correlationId: denial.correlationId }),
        safeMetadata: { subjectKind: denial.subjectKind },
      }),
  };
}
