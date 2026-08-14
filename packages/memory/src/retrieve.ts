/** Recall reauthorizes assertion scope and evidence now; exclusions reveal reason counts only. */

import type { AuditEventInput } from "@tulipfarm/audit";
import type { MemoryAssertion, MemoryDeps } from "./memory";
import { fuseMemoryCandidates, type MemoryCandidateSignals, rankMemoryCandidates } from "./rank";
import type { MemoryScopeDenialReason, MemoryScopeRequest } from "./scope";
import { authorizeMemoryScope } from "./scope";
import {
  endMemorySpan,
  MEMORY_METRICS,
  MEMORY_SPANS,
  recordMemoryCounter,
  recordMemoryHistogram,
  recordMemorySpanError,
  setMemorySpanAttributes,
  startMemorySpan,
} from "./telemetry";

export type { MemoryEvidenceAuthorizationPort } from "./memory";

/** Retrieval is not an auth boundary; `recallMemory` authorizes every candidate after search. */
export interface MemoryRecallIndex {
  search(request: MemoryRecallIndexRequest): Promise<readonly MemoryCandidateSignals[]>;
}

export interface MemoryRecallIndexRequest {
  readonly businessId: string;
  readonly query: string;
  /** How many candidates each arm should return, before authorization narrows them. */
  readonly limit: number;
}

export type MemoryExclusionReason =
  | MemoryScopeDenialReason
  | "superseded"
  | "forgotten"
  | "not_valid_at"
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
  /**
   * Natural-language query. When set and a recall index is wired, candidates are retrieved and
   * ranked by relevance instead of by recency.
   */
  readonly query?: string;
  /** Ask what was true at this instant, including facts later contradicted. */
  readonly validAt?: string;
}

export interface RecallResult {
  readonly assertions: readonly MemoryAssertion[];
  readonly exclusions: readonly MemoryExclusion[];
}

const DEFAULT_LIMIT = 50;

/** Retrieve past `limit` before auth so withheld hits cannot occupy visible slots. */
const CANDIDATE_WIDENING = 4;

/** Half-open validity: `validTo` is when the next fact became true. */
function validAtMoment(assertion: MemoryAssertion, moment: number): boolean {
  if (Date.parse(assertion.validFrom) > moment) return false;
  return assertion.validTo === undefined || Date.parse(assertion.validTo) > moment;
}

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

/** Recall visible assertions; authorize widened candidates before truncating. */
export async function recallMemory(
  deps: MemoryDeps,
  request: RecallRequest
): Promise<RecallResult> {
  const now = deps.now();
  const startedAt = Date.now();
  const limit = request.limit ?? DEFAULT_LIMIT;
  const validAt = request.validAt === undefined ? undefined : Date.parse(request.validAt);

  // Historical recall bypasses the active-row index so superseded assertions remain askable.
  const ranked = request.query !== undefined && deps.index !== undefined && validAt === undefined;
  const span = startMemorySpan(deps.telemetry, MEMORY_SPANS.recall, {
    ranked,
    point_in_time: validAt !== undefined,
    filter_present: request.subject !== undefined,
    limit,
  });

  try {
    let signals: readonly MemoryCandidateSignals[] = [];
    let candidates: readonly MemoryAssertion[];

    if (ranked && request.query !== undefined && deps.index !== undefined) {
      signals = await deps.index.search({
        businessId: request.businessId,
        query: request.query,
        limit: limit * CANDIDATE_WIDENING,
      });
      candidates = await deps.store.getMany(
        request.businessId,
        signals.map((signal) => signal.assertionId)
      );
    } else {
      candidates = await deps.store.list(request.businessId);
    }

    if (request.subject !== undefined) {
      candidates = candidates.filter((assertion) => assertion.subject === request.subject);
    }

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
      if (validAt === undefined) {
        if (assertion.status === "superseded" || assertion.status === "forgotten") {
          exclude(assertion.status);
          continue;
        }
      } else {
        // Point-in-time recall tests validity; forgotten records still stay hidden.
        if (assertion.status === "forgotten") {
          exclude("forgotten");
          continue;
        }
        if (!validAtMoment(assertion, validAt)) {
          exclude("not_valid_at");
          continue;
        }
      }
      // A durable record whose confirmation never completed is not a memory yet.
      if (assertion.confirmation !== "confirmed") {
        exclude("not_confirmed");
        continue;
      }
      // Expiry is about how long we keep a belief, not about when it was true, so a historical
      // question is not narrowed by it.
      if (
        validAt === undefined &&
        assertion.expiresAt !== undefined &&
        Date.parse(assertion.expiresAt) <= now.getTime()
      ) {
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

    let assertions: readonly MemoryAssertion[];
    if (ranked) {
      assertions = rankMemoryCandidates(allowed, fuseMemoryCandidates(signals), { now })
        .slice(0, limit)
        .map((entry) => entry.assertion);
    } else {
      allowed.sort(
        (a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          a.assertionId.localeCompare(b.assertionId)
      );
      assertions = allowed.slice(0, limit);
    }
    const exclusions = [...excluded.entries()].map(([reason, count]) => ({ reason, count }));

    await deps.audit?.record(
      recallAuditEvent(
        request,
        exclusions.map((exclusion) => exclusion.reason),
        now,
        { recalled: assertions.length, excluded: candidates.length - allowed.length }
      )
    );

    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.recallRequests, 1, {
      outcome: "ok",
      ranked,
      point_in_time: validAt !== undefined,
    });
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.recallResults, assertions.length, {
      ranked,
      point_in_time: validAt !== undefined,
    });
    for (const exclusion of exclusions) {
      recordMemoryCounter(deps.telemetry, MEMORY_METRICS.recallExclusions, exclusion.count, {
        reason: exclusion.reason,
      });
    }
    setMemorySpanAttributes(span, {
      outcome: "ok",
      ranked,
      point_in_time: validAt !== undefined,
      candidates: candidates.length,
      results: assertions.length,
      excluded: candidates.length - allowed.length,
    });

    return { assertions, exclusions };
  } catch (error) {
    recordMemoryCounter(deps.telemetry, MEMORY_METRICS.recallRequests, 1, {
      outcome: "error",
      ranked,
      point_in_time: validAt !== undefined,
    });
    recordMemorySpanError(span, "recall_failed");
    throw error;
  } finally {
    recordMemoryHistogram(deps.telemetry, MEMORY_METRICS.recallLatencyMs, Date.now() - startedAt, {
      ranked,
      point_in_time: validAt !== undefined,
    });
    endMemorySpan(span);
  }
}
