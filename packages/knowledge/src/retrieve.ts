/** ACL-first retrieval authorizes before ranking, re-checks ids, and reauthorizes cache hits. */

import type { AuditEventInput } from "@tulipfarm/audit";
import { canonicalHash } from "@tulipfarm/schema";
import type { CachePort } from "@tulipfarm/storage";
import {
  decideSourceAccess,
  type LiveSourceAuthorizationPort,
  type SourceAccessDenialReason,
} from "./acl";
import type { KnowledgeIndexPort } from "./indexing";
import type { KnowledgePrincipalRef, KnowledgeSourceStore } from "./source";

export interface RetrievalRequest {
  readonly businessId: string;
  /** Acting principal, for audit attribution and cache partitioning. */
  readonly principalId: string;
  /** Every principal the actor holds (self, roles, guest). */
  readonly principals: readonly KnowledgePrincipalRef[];
  readonly query: string;
  readonly limit: number;
  /** Bumps when Guardrail policy changes; invalidates every cached answer under it. */
  readonly guardrailEpoch: string;
  /** Bumps when the assembled Context changes; keeps Run Contexts from sharing candidates. */
  readonly contextEpoch: string;
  readonly correlationId: string;
  readonly agentId?: string;
  readonly runId?: string;
}

export type RetrievalExclusionReason = SourceAccessDenialReason | "index_filter_violation";

/** Aggregate only. Per-source detail here would re-disclose exactly what the ACL withheld. */
export interface RetrievalExclusion {
  readonly reason: RetrievalExclusionReason;
  readonly count: number;
}

export interface RetrievalCitation {
  readonly sourceId: string;
  readonly revision: string;
  readonly aclRevision: string;
}

export interface RetrievedCandidate {
  readonly sourceId: string;
  readonly provider: string;
  readonly chunkId: string;
  readonly revision: string;
  readonly score: number;
  readonly classification: readonly string[];
  readonly digest: string;
  readonly snippet: string;
  readonly citation: RetrievalCitation;
}

export interface RetrievalResult {
  readonly candidates: readonly RetrievedCandidate[];
  readonly exclusions: readonly RetrievalExclusion[];
  readonly cacheKey: string;
  readonly fromCache: boolean;
}

export interface KnowledgeAuditSink {
  record(event: AuditEventInput): Promise<void>;
}

export interface RetrievalDeps {
  readonly sources: KnowledgeSourceStore;
  readonly index: KnowledgeIndexPort;
  readonly live?: LiveSourceAuthorizationPort;
  readonly cache?: CachePort;
  readonly audit?: KnowledgeAuditSink;
  readonly now: () => Date;
  readonly cacheTtlMs?: number;
}

/** Version fingerprint a cached answer was computed against. A mismatch is a miss. */
interface CachedSourceVersion {
  readonly sourceId: string;
  readonly revision: string;
  readonly aclRevision: string;
}

interface CachedRetrieval {
  readonly candidates: readonly RetrievedCandidate[];
  readonly exclusions: readonly RetrievalExclusion[];
  readonly sourceVersions: readonly CachedSourceVersion[];
}

const DEFAULT_CACHE_TTL_MS = 60_000;

function sortedPrincipals(principals: readonly KnowledgePrincipalRef[]): string[] {
  return principals.map((principal) => `${principal.kind}:${principal.id}`).sort();
}

/** Cache keys bind question, principal, Guardrail epoch, and Context epoch. */
export function buildRetrievalCacheKey(request: RetrievalRequest): string {
  return canonicalHash({
    businessId: request.businessId,
    principalId: request.principalId,
    principals: sortedPrincipals(request.principals),
    query: request.query,
    limit: request.limit,
    guardrailEpoch: request.guardrailEpoch,
    contextEpoch: request.contextEpoch,
  });
}

function tally(reasons: readonly RetrievalExclusionReason[]): RetrievalExclusion[] {
  const counts = new Map<RetrievalExclusionReason, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count }));
}

async function authorizeAll(
  deps: RetrievalDeps,
  request: RetrievalRequest
): Promise<{
  allowed: Map<string, { citation: RetrievalCitation; provider: string }>;
  reasons: RetrievalExclusionReason[];
}> {
  const now = deps.now();
  const allowed = new Map<string, { citation: RetrievalCitation; provider: string }>();
  const reasons: RetrievalExclusionReason[] = [];
  for (const source of await deps.sources.list(request.businessId)) {
    const decision = await decideSourceAccess(
      source,
      { businessId: request.businessId, principals: request.principals },
      { live: deps.live },
      now
    );
    if (!decision.allowed) {
      reasons.push(decision.reason);
      continue;
    }
    allowed.set(source.sourceId, {
      citation: {
        sourceId: source.sourceId,
        revision: source.revision,
        aclRevision: decision.aclRevision,
      },
      provider: source.provider,
    });
  }
  return { allowed, reasons };
}

/** A cached answer is only usable if every source it was built from still authorizes identically. */
async function cachedStillValid(
  deps: RetrievalDeps,
  request: RetrievalRequest,
  cached: CachedRetrieval
): Promise<boolean> {
  const now = deps.now();
  for (const version of cached.sourceVersions) {
    const source = await deps.sources.get(request.businessId, version.sourceId);
    if (source === undefined || source.revision !== version.revision) return false;
    const decision = await decideSourceAccess(
      source,
      { businessId: request.businessId, principals: request.principals },
      { live: deps.live },
      now
    );
    if (!decision.allowed || decision.aclRevision !== version.aclRevision) return false;
  }
  return true;
}

async function auditRetrieval(
  deps: RetrievalDeps,
  request: RetrievalRequest,
  result: RetrievalResult
): Promise<void> {
  if (deps.audit === undefined) return;
  const principal = { principalId: request.principalId, businessId: request.businessId };
  await deps.audit.record({
    actor: principal,
    effectivePrincipal: principal,
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    action: "knowledge.retrieve",
    // Target is the Knowledge boundary, never the documents — naming a withheld source in the
    // audit payload would leak it to every reader of the ledger.
    target: `knowledge:${request.businessId}`,
    decision: result.candidates.length > 0 ? "allow" : "deny",
    reasonCodes: result.exclusions.map((exclusion) => exclusion.reason),
    correlationId: request.correlationId,
    occurredAt: deps.now(),
    safeMetadata: {
      candidateCount: result.candidates.length,
      excludedCount: result.exclusions.reduce((total, entry) => total + entry.count, 0),
      guardrailEpoch: request.guardrailEpoch,
      contextEpoch: request.contextEpoch,
      fromCache: result.fromCache,
    },
  });
}

export async function retrieve(
  deps: RetrievalDeps,
  request: RetrievalRequest
): Promise<RetrievalResult> {
  const cacheKey = buildRetrievalCacheKey(request);

  if (deps.cache !== undefined) {
    const cached = await deps.cache.get<CachedRetrieval>(cacheKey);
    if (cached !== undefined) {
      if (await cachedStillValid(deps, request, cached)) {
        const hit: RetrievalResult = {
          candidates: cached.candidates,
          exclusions: cached.exclusions,
          cacheKey,
          fromCache: true,
        };
        await auditRetrieval(deps, request, hit);
        return hit;
      }
      // A stale entry is removed immediately; leaving it would keep answering later requests that
      // happen to arrive before the TTL expires.
      await deps.cache.delete(cacheKey);
    }
  }

  const { allowed, reasons } = await authorizeAll(deps, request);
  const ranked = await deps.index.search({
    businessId: request.businessId,
    query: request.query,
    limit: request.limit,
    allowedSourceIds: new Set(allowed.keys()),
  });

  const candidates: RetrievedCandidate[] = [];
  for (const candidate of ranked) {
    const authorized = allowed.get(candidate.sourceId);
    // Defence in depth: an index adapter that ignores `allowedSourceIds` (a bug, or a swapped
    // implementation) cannot turn into a disclosure. The candidate is dropped whole — its id is
    // not echoed back in the exclusion list either.
    if (authorized === undefined) {
      reasons.push("index_filter_violation");
      continue;
    }
    candidates.push({
      ...candidate,
      provider: authorized.provider,
      citation: authorized.citation,
    });
  }

  const result: RetrievalResult = {
    candidates,
    exclusions: tally(reasons),
    cacheKey,
    fromCache: false,
  };

  if (deps.cache !== undefined) {
    const entry: CachedRetrieval = {
      candidates: result.candidates,
      exclusions: result.exclusions,
      sourceVersions: [...allowed.values()].map(({ citation }) => ({
        sourceId: citation.sourceId,
        revision: citation.revision,
        aclRevision: citation.aclRevision,
      })),
    };
    await deps.cache.set(cacheKey, entry, deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  }

  await auditRetrieval(deps, request, result);
  return result;
}
