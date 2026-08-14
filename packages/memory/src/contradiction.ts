/** Contradictions close valid intervals; local checks enforce scope, offered rows, and trust rank. */

import type { MemoryAssertion, MemoryDeps, MemoryTrustTier } from "./memory";
import type { MemoryScopeRequest } from "./scope";
import {
  endMemorySpan,
  MEMORY_METRICS,
  MEMORY_SPANS,
  recordMemoryCounter,
  recordMemorySpanError,
  setMemorySpanAttributes,
  startMemorySpan,
} from "./telemetry";

/** Judge returns offered prior ids only; any unoffered id is discarded. */
export interface MemoryContradictionPort {
  contradicts(input: MemoryContradictionInput): Promise<readonly string[]>;
}

export interface MemoryContradictionInput {
  readonly businessId: string;
  readonly statement: { readonly subject: string; readonly statement: string };
  readonly priors: readonly {
    readonly assertionId: string;
    readonly subject: string;
    readonly statement: string;
  }[];
}

/** Origin trust is ordered so lower-trust statements cannot close higher-trust ones. */
const TRUST_RANK: Record<MemoryTrustTier, number> = {
  user_stated: 3,
  agent_inferred: 2,
  external_derived: 1,
};

/** Subjects are matched loosely — "Employer" and "employer " name the same thing. */
export function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Structural eligibility is enforced before the judge, so a bad port cannot close unsafe rows. */
export function isContradictionCandidate(
  next: Pick<MemoryAssertion, "assertionId" | "subject" | "trustTier" | "validFrom">,
  candidate: MemoryAssertion
): boolean {
  if (candidate.assertionId === next.assertionId) return false;
  if (candidate.status !== "active") return false;
  if (candidate.confirmation !== "confirmed") return false;
  if (normalizeSubject(candidate.subject) !== normalizeSubject(next.subject)) return false;
  // A statement may only retire one it is at least as trustworthy as.
  if (TRUST_RANK[candidate.trustTier] > TRUST_RANK[next.trustTier]) return false;
  // A prior whose validity already ended has nothing left to close.
  if (candidate.validTo !== undefined) return false;
  return true;
}

export interface ResolveContradictionsResult {
  /** Ids whose valid interval this write closed. */
  readonly invalidated: readonly string[];
  /** How many same-subject priors were offered to the judge. */
  readonly considered: number;
}

/** Best-effort post-write contradiction cleanup; judge failure leaves stale recall, not a failed save. */
export async function resolveContradictions(
  deps: MemoryDeps,
  next: MemoryAssertion,
  scopeRequest: MemoryScopeRequest,
  port: MemoryContradictionPort | undefined
): Promise<ResolveContradictionsResult> {
  if (port === undefined) return { invalidated: [], considered: 0 };
  const span = startMemorySpan(deps.telemetry, MEMORY_SPANS.contradiction, {
    scope: next.target.scope,
    memory_type: next.memoryType,
    trust_tier: next.trustTier,
  });

  // Scoped at the source: the query itself never reaches beyond the assertion's own owner, so a
  // contradiction crossing into another user's memory is not merely rejected — it is unreachable.
  const owned = await deps.store.listActiveForScope(scopeRequest.businessId, {
    scope: next.target.scope,
    ...(next.target.subjectPrincipalId === undefined
      ? {}
      : { subjectPrincipalId: next.target.subjectPrincipalId }),
    ...(next.target.agentId === undefined ? {} : { agentId: next.target.agentId }),
    ...(next.target.roleId === undefined ? {} : { roleId: next.target.roleId }),
    ...(next.target.runId === undefined ? {} : { runId: next.target.runId }),
  });
  const priors = owned.filter((candidate) => isContradictionCandidate(next, candidate));
  if (priors.length === 0) {
    setMemorySpanAttributes(span, {
      scope: next.target.scope,
      considered: 0,
      invalidated: 0,
    });
    endMemorySpan(span);
    return { invalidated: [], considered: 0 };
  }
  recordMemoryCounter(deps.telemetry, MEMORY_METRICS.contradictionsDetected, priors.length, {
    outcome: "considered",
    scope: next.target.scope,
    trust_tier: next.trustTier,
  });

  let judged: readonly string[];
  try {
    judged = await port.contradicts({
      businessId: scopeRequest.businessId,
      statement: { subject: next.subject, statement: next.statement },
      priors: priors.map((p) => ({
        assertionId: p.assertionId,
        subject: p.subject,
        statement: p.statement,
      })),
    });
  } catch {
    // A judge that fails leaves both statements standing. Recall then shows a stale fact alongside
    // a current one, which is recoverable; closing the wrong interval is not.
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.contradictionsJudgeFailures, 1, {
      scope: next.target.scope,
      trust_tier: next.trustTier,
    });
    recordMemorySpanError(span, "judge_failed");
    setMemorySpanAttributes(span, {
      scope: next.target.scope,
      considered: priors.length,
      invalidated: 0,
      outcome: "judge_failed",
    });
    endMemorySpan(span);
    return { invalidated: [], considered: priors.length };
  }

  // Only ids that were actually offered. A judge naming anything else is answering a question it
  // was not asked, and the id it named would be a row nobody checked the scope of.
  const offered = new Map(priors.map((p) => [p.assertionId, p]));
  const nowIso = deps.now().toISOString();
  const invalidated: string[] = [];

  for (const assertionId of judged) {
    const prior = offered.get(assertionId);
    if (prior === undefined) continue;
    await deps.store.put({
      ...prior,
      status: "superseded",
      supersededById: next.assertionId,
      // Valid time closes when the new truth *began*, not when we noticed — that is what makes a
      // `validAt` query between the two answer with the old fact rather than with neither.
      validTo: next.validFrom,
      recordedUntil: nowIso,
      updatedAt: nowIso,
    });
    invalidated.push(assertionId);
  }

  recordMemoryCounter(deps.telemetry, MEMORY_METRICS.contradictionsDetected, judged.length, {
    outcome: "judged",
    scope: next.target.scope,
    trust_tier: next.trustTier,
  });
  recordMemoryCounter(
    deps.telemetry,
    MEMORY_METRICS.contradictionsInvalidated,
    invalidated.length,
    {
      scope: next.target.scope,
      trust_tier: next.trustTier,
    }
  );
  setMemorySpanAttributes(span, {
    scope: next.target.scope,
    considered: priors.length,
    judged: judged.length,
    invalidated: invalidated.length,
    outcome: "resolved",
  });
  endMemorySpan(span);
  return { invalidated, considered: priors.length };
}
