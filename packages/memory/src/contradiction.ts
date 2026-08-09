/**
 * Bi-temporal contradiction handling (SPEC §14.4).
 *
 * When a new statement contradicts one already stored, the old one is not deleted and not
 * overwritten — its *valid interval* is closed. "Works at Acme" does not become false; it becomes
 * true-until-March. That is what makes `validAt` recall answerable, and it is the difference
 * between a memory store and a cache.
 *
 * Deciding *whether* two statements contradict needs a language model, and this package may not
 * depend on one (`docs/architecture/dependency-rules.md`). So the judgment is a port, exactly like
 * extraction is, and everything that makes the operation *safe* lives here where it cannot be
 * bypassed by swapping the model:
 *
 * - a contradiction never crosses a scope boundary,
 * - a prior the port was not shown can never be closed,
 * - and a less-trusted statement can never invalidate a more-trusted one.
 *
 * That last rule is the one that matters most. Without it, a single inferred sentence could quietly
 * retire something the user stated outright — which is precisely the memory-poisoning path the
 * extraction screen exists to close.
 */

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

/**
 * Judges which of the offered priors a new statement contradicts.
 *
 * Returns assertion ids. Anything it returns that was not offered is discarded — model output is
 * untrusted here for the same reason it is untrusted in extraction.
 */
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

/**
 * How much a statement's origin is trusted, as a comparable rank.
 *
 * Ordered, not just distinct: the whole point is that `user_stated` outranks everything, so a fact
 * inferred from a Slack thread cannot close a fact the user typed.
 */
const TRUST_RANK: Record<MemoryTrustTier, number> = {
  user_stated: 3,
  agent_inferred: 2,
  external_derived: 1,
};

/** Subjects are matched loosely — "Employer" and "employer " name the same thing. */
export function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Whether `candidate` is even eligible to be contradicted by `next`.
 *
 * Everything structural is decided here rather than by the port, so a port that answers "yes" to
 * everything still cannot do damage: it can only ever close rows that already passed every one of
 * these checks.
 */
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

/**
 * Close the valid interval of every prior the new assertion contradicts.
 *
 * Called after the new assertion is stored, and best-effort by construction: the statement the user
 * just made is already durable, so a judge that is slow, absent, or wrong costs some tidiness in
 * recall, never the write itself.
 */
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
