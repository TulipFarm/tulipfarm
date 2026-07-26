/**
 * Memory recall (SPEC §14.2).
 *
 * Recall is not a lookup of what was saved — it is a fresh authorization of every candidate, twice
 * over: the assertion's scope is reauthorized against the caller's identities *now*, and any
 * Knowledge source the assertion was derived from is reauthorized through the evidence port. A
 * statement whose supporting source has since been revoked stops being recalled, even though it is
 * still stored.
 *
 * Exclusions are returned as reason counts. A caller who cannot see an assertion learns only that
 * something was excluded and why in the abstract — never its subject, statement, or id.
 */

import type { AuditEventInput } from "@tulipfarm/audit";
import type { MemoryAssertion, MemoryDeps } from "./memory";
import type { MemoryScopeDenialReason, MemoryScopeRequest } from "./scope";
import { authorizeMemoryScope } from "./scope";

export type { MemoryEvidenceAuthorizationPort } from "./memory";

export type MemoryExclusionReason =
  | MemoryScopeDenialReason
  | "superseded"
  | "forgotten"
  | "not_confirmed"
  | "expired"
  | "evidence_unauthorized"
  | "evidence_unavailable";

export interface MemoryExclusion {
  readonly reason: MemoryExclusionReason;
  readonly count: number;
}

export interface RecallRequest extends MemoryScopeRequest {
  readonly subject?: string;
  readonly limit?: number;
}

export interface RecallResult {
  readonly assertions: readonly MemoryAssertion[];
  readonly exclusions: readonly MemoryExclusion[];
}

const DEFAULT_LIMIT = 50;

/** Every Knowledge source behind this assertion must reauthorize, or the assertion is dropped. */
async function evidenceReason(
  deps: MemoryDeps,
  assertion: MemoryAssertion,
  request: RecallRequest
): Promise<MemoryExclusionReason | undefined> {
  const sources = assertion.provenance.evidence.filter(
    (item) => item.kind === "knowledge_source" && item.sourceId !== undefined
  );
  if (sources.length === 0) return undefined;
  // No port wired is not permission; it is an unanswerable question, which denies.
  if (deps.evidence === undefined) return "evidence_unavailable";

  for (const item of sources) {
    if (item.sourceId === undefined) continue;
    let allowed: boolean | undefined;
    try {
      allowed = await deps.evidence.authorize({
        businessId: request.businessId,
        principalId: request.principalId,
        sourceId: item.sourceId,
        ...(item.revision === undefined ? {} : { revision: item.revision }),
      });
    } catch {
      // Provider errors name the source they failed on; they never reach the caller.
      return "evidence_unavailable";
    }
    if (allowed === undefined) return "evidence_unavailable";
    if (!allowed) return "evidence_unauthorized";
  }
  return undefined;
}

function recallAuditEvent(
  request: RecallRequest,
  reasonCodes: readonly string[],
  occurredAt: Date,
  safeMetadata: Record<string, unknown>
): AuditEventInput {
  const principal = { principalId: request.principalId, businessId: request.businessId };
  return {
    actor: principal,
    effectivePrincipal: principal,
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    action: "memory.recall",
    target: `memory:${request.businessId}`,
    decision: "allow",
    reasonCodes,
    correlationId: `memory.recall:${request.businessId}:${occurredAt.toISOString()}`,
    occurredAt,
    safeMetadata,
  };
}

/**
 * Recall the assertions this caller is authorized to see right now, newest first.
 */
export async function recallMemory(
  deps: MemoryDeps,
  request: RecallRequest
): Promise<RecallResult> {
  const now = deps.now();
  const stored = await deps.store.list(request.businessId);
  const candidates =
    request.subject === undefined
      ? stored
      : stored.filter((assertion) => assertion.subject === request.subject);

  const excluded = new Map<MemoryExclusionReason, number>();
  const exclude = (reason: MemoryExclusionReason) =>
    excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
  const allowed: MemoryAssertion[] = [];

  for (const assertion of candidates) {
    const access = authorizeMemoryScope(deps.settings.scopes, assertion.target, request);
    if (!access.allowed) {
      exclude(access.reason);
      continue;
    }
    if (assertion.status === "superseded" || assertion.status === "forgotten") {
      exclude(assertion.status);
      continue;
    }
    // A durable record whose confirmation never completed is not a memory yet.
    if (assertion.confirmation !== "confirmed") {
      exclude("not_confirmed");
      continue;
    }
    if (assertion.expiresAt !== undefined && Date.parse(assertion.expiresAt) <= now.getTime()) {
      exclude("expired");
      continue;
    }
    const evidence = await evidenceReason(deps, assertion, request);
    if (evidence !== undefined) {
      exclude(evidence);
      continue;
    }
    allowed.push(assertion);
  }

  allowed.sort(
    (a, b) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
      a.assertionId.localeCompare(b.assertionId)
  );
  const assertions = allowed.slice(0, request.limit ?? DEFAULT_LIMIT);
  const exclusions = [...excluded.entries()].map(([reason, count]) => ({ reason, count }));

  await deps.audit?.record(
    recallAuditEvent(
      request,
      exclusions.map((exclusion) => exclusion.reason),
      now,
      { recalled: assertions.length, excluded: candidates.length - allowed.length }
    )
  );

  return { assertions, exclusions };
}
