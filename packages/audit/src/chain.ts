/** Audit hashes cover the event plus previous hash; edits, reorders, or drops break the tail. */

import { canonicalHash } from "@tulipfarm/schema";
import type { AuditEvent, AuditEventInput } from "./event";

/** Fields hashed into an event, with `occurredAt` normalized to an ISO string (Date is not
 *  canonicalizable) and `safeRefs` flattened to plain arrays for deterministic serialization. */
function hashableBody(
  input: AuditEventInput,
  id: string,
  businessId: string,
  chainIndex: number,
  previousHash: string | null
): Record<string, unknown> {
  return {
    id,
    businessId,
    chainIndex,
    previousHash,
    actor: input.actor,
    effectivePrincipal: input.effectivePrincipal,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    stateId: input.stateId ?? null,
    action: input.action,
    target: input.target,
    decision: input.decision,
    reasonCodes: [...input.reasonCodes],
    guardrailDigest: input.guardrailDigest ?? null,
    bundleDigest: input.bundleDigest ?? null,
    sourceClassification: input.sourceClassification ?? null,
    destinationClassification: input.destinationClassification ?? null,
    requestHash: input.requestHash ?? null,
    resultHash: input.resultHash ?? null,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    occurredAt: input.occurredAt.toISOString(),
    safeMetadata: input.safeMetadata ?? {},
    safeRefs: (input.safeRefs ?? []).map((ref) => ({ key: ref.key, hash: ref.hash })),
  };
}

/** Computes the hash for a new event given its input and its position in the chain. */
export function computeEventHash(
  input: AuditEventInput,
  id: string,
  businessId: string,
  chainIndex: number,
  previousHash: string | null
): string {
  return canonicalHash(hashableBody(input, id, businessId, chainIndex, previousHash));
}

/** Recomputes the hash of an already-stored event, to check it against its recorded `hash`. */
export function recomputeEventHash(event: AuditEvent): string {
  return computeEventHash(event, event.id, event.businessId, event.chainIndex, event.previousHash);
}
