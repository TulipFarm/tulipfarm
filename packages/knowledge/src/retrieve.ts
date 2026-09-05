/** ACL-first retrieval authorizes before ranking, re-checks ids, and reauthorizes cache hits. */

import type { AuditEventInput } from "@tulipfarm/audit";
import { canonicalHash } from "@tulipfarm/schema";
import type { CachePort } from "@tulipfarm/storage";
import {
  decideKnowledgeAccess,
  type LiveSourceAuthorizationPort,
  type SourceAccessDenialReason,
} from "./acl";
import {
  effectiveScore,
  expandHops,
  type KnowledgeLinkGraphPort,
  scoreBounds,
} from "./graph-expand";
import type { KnowledgeIndexPort } from "./indexing";
import {
  DEFAULT_KNOWLEDGE_ACCESS,
  type GraphExpandConfig,
  type KnowledgeAccessConfig,
  MAX_GRAPH_EXPAND_DEPTH,
} from "./retrieval-config";
import type { KnowledgePrincipalRef, KnowledgeSourceStore } from "./source";
import {
  type KnowledgeOwnershipPort,
  type KnowledgeSubject,
  type KnowledgeSubjectStore,
  type PrincipalResolverPort,
  sourceSubject,
} from "./subject";

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
  /** Authored Pages, consulted only when `access.authoredPagesInRetrieval` is on. */
  readonly subjects?: KnowledgeSubjectStore;
  readonly ownership?: KnowledgeOwnershipPort;
  /** Expands the actor's principals once per query so group grants resolve at query time. */
  readonly principalResolver?: PrincipalResolverPort;
  readonly access?: KnowledgeAccessConfig;
  /** Page-to-page edges for `graph-expand`. Absent means the walk cannot run. */
  readonly links?: KnowledgeLinkGraphPort;
  readonly graph?: GraphExpandConfig;
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
  /** Absent means `source`, so entries written before authored Pages existed still read back. */
  readonly subjectKind?: KnowledgeSubject["subjectKind"];
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

/**
 * Cache keys bind question, principal, Guardrail epoch, and Context epoch.
 *
 * `resolved` binds the actor's *expanded* principals, so losing a group membership changes the key
 * rather than replaying an answer the group grant paid for.
 */
export function buildRetrievalCacheKey(
  request: RetrievalRequest,
  resolved?: readonly KnowledgePrincipalRef[],
  graphDepth?: number
): string {
  return canonicalHash({
    businessId: request.businessId,
    principalId: request.principalId,
    principals: sortedPrincipals(resolved ?? request.principals),
    query: request.query,
    limit: request.limit,
    guardrailEpoch: request.guardrailEpoch,
    contextEpoch: request.contextEpoch,
    // Added only when the walk is on, so a deployment with it off hashes exactly as it always did.
    ...(graphDepth === undefined ? {} : { graphDepth }),
  });
}

function tally(reasons: readonly RetrievalExclusionReason[]): RetrievalExclusion[] {
  const counts = new Map<RetrievalExclusionReason, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count }));
}

interface Authorized {
  readonly citation: RetrievalCitation;
  readonly provider: string;
  readonly subjectKind: KnowledgeSubject["subjectKind"];
}

/** Every subject retrieval may return: source records always, authored Pages behind the flag. */
async function subjectsToAuthorize(
  deps: RetrievalDeps,
  businessId: string
): Promise<readonly KnowledgeSubject[]> {
  const sourceRecords = await deps.sources.list(businessId);
  const ownership = await deps.ownership?.entriesFor(
    businessId,
    sourceRecords.map((source) => ({ kind: "source", id: source.sourceId }))
  );
  const sources = sourceRecords.map((source) =>
    sourceSubject(source, ownership?.get(`source:${source.sourceId}`) ?? [])
  );
  const access = deps.access ?? DEFAULT_KNOWLEDGE_ACCESS;
  if (!access.authoredPagesInRetrieval || deps.subjects === undefined) return sources;
  return [...sources, ...(await deps.subjects.listAuthored(businessId))];
}

async function authorizeAll(
  deps: RetrievalDeps,
  request: RetrievalRequest,
  principals: readonly KnowledgePrincipalRef[]
): Promise<{ allowed: Map<string, Authorized>; reasons: RetrievalExclusionReason[] }> {
  const now = deps.now();
  const access = deps.access ?? DEFAULT_KNOWLEDGE_ACCESS;
  const allowed = new Map<string, Authorized>();
  const reasons: RetrievalExclusionReason[] = [];
  // Keyed by bare id, which is safe only while Page chunks stay in `knowledge_chunks` behind
  // `page-search-adapter` rather than in `KnowledgeIndexPort`. Whoever merges those two chunk
  // namespaces must key this by `subjectKind` too, or a Source named after a Page's uuid would
  // authorize that Page's chunks.
  for (const subject of await subjectsToAuthorize(deps, request.businessId)) {
    const decision = await decideKnowledgeAccess(
      subject,
      {
        businessId: request.businessId,
        principals,
        maxEntries: access.maxAclEntriesPerSubject,
      },
      { live: deps.live },
      now
    );
    if (!decision.allowed) {
      reasons.push(decision.reason);
      continue;
    }
    allowed.set(subject.subjectId, {
      citation: {
        sourceId: subject.subjectId,
        revision: subject.revision,
        aclRevision: decision.aclRevision,
      },
      provider: subject.provider,
      subjectKind: subject.subjectKind,
    });
  }
  return { allowed, reasons };
}

/** A cached answer is only usable if every subject it was built from still authorizes identically. */
async function cachedStillValid(
  deps: RetrievalDeps,
  request: RetrievalRequest,
  cached: CachedRetrieval,
  principals: readonly KnowledgePrincipalRef[]
): Promise<boolean> {
  const now = deps.now();
  const access = deps.access ?? DEFAULT_KNOWLEDGE_ACCESS;
  for (const version of cached.sourceVersions) {
    const subject = await reloadSubject(deps, request.businessId, version);
    if (subject === undefined || subject.revision !== version.revision) return false;
    const decision = await decideKnowledgeAccess(
      subject,
      {
        businessId: request.businessId,
        principals,
        maxEntries: access.maxAclEntriesPerSubject,
      },
      { live: deps.live },
      now
    );
    if (!decision.allowed || decision.aclRevision !== version.aclRevision) return false;
  }
  return true;
}

async function reloadSubject(
  deps: RetrievalDeps,
  businessId: string,
  version: CachedSourceVersion
): Promise<KnowledgeSubject | undefined> {
  if (version.subjectKind === "page" || version.subjectKind === "space") {
    return deps.subjects?.getAuthored(businessId, version.sourceId);
  }
  const source = await deps.sources.get(businessId, version.sourceId);
  if (source === undefined) return undefined;
  const ownership = await deps.ownership?.entriesFor(businessId, [
    { kind: "source", id: source.sourceId },
  ]);
  return sourceSubject(source, ownership?.get(`source:${source.sourceId}`) ?? []);
}

/**
 * Walk out from the seed pages and merge in the neighbours the actor may read.
 *
 * `allowed` is the result of the authorization pass that has already run over every subject, so a
 * neighbour is admitted only if the gate passed it *before* this stage. Reusing that decision is
 * deliberate: re-deciding here would count the same denial twice in the exclusion tally, which is
 * itself a signal about how a withheld page is connected.
 */
async function expandCandidates(
  deps: RetrievalDeps,
  request: RetrievalRequest,
  seeds: readonly RetrievedCandidate[],
  allowed: ReadonlyMap<string, Authorized>,
  reasons: RetrievalExclusionReason[]
): Promise<readonly RetrievedCandidate[]> {
  const graph = deps.graph;
  const links = deps.links;
  if (graph === undefined || !graph.enabled || links === undefined) return seeds;
  if (deps.index.fetchBySource === undefined || seeds.length === 0) return seeds;

  const hops = await expandHops(links, [...new Set(seeds.map((c) => c.sourceId))], graph, (ids) =>
    ids.filter((id) => allowed.has(id))
  );
  if (hops.size === 0) return seeds;

  const neighbours = await deps.index.fetchBySource({
    businessId: request.businessId,
    query: request.query,
    limit: request.limit,
    allowedSourceIds: new Set(hops.keys()),
  });

  const merged = new Map<string, { candidate: RetrievedCandidate; hop: number }>();
  for (const seed of seeds) merged.set(seed.chunkId, { candidate: seed, hop: 0 });
  for (const candidate of neighbours) {
    if (merged.has(candidate.chunkId)) continue;
    const grant = allowed.get(candidate.sourceId);
    if (grant === undefined) {
      reasons.push("index_filter_violation");
      continue;
    }
    merged.set(candidate.chunkId, {
      candidate: { ...candidate, provider: grant.provider, citation: grant.citation },
      hop: hops.get(candidate.sourceId) ?? MAX_GRAPH_EXPAND_DEPTH,
    });
  }

  // Scores are rewritten into hop bands, which is what makes "a two-hop page cannot outrank a
  // direct hit" survive a downstream reranker that only sees the number.
  const bounds = scoreBounds(seeds.map((candidate) => candidate.score));
  return [...merged.values()]
    .map(({ candidate, hop }) => ({
      ...candidate,
      score: effectiveScore(hop, candidate.score, bounds, graph),
    }))
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, request.limit);
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
  // Resolved once per query, never per document, so authorization stays linear in the corpus.
  const principals =
    deps.principalResolver === undefined
      ? request.principals
      : await deps.principalResolver.resolve({
          businessId: request.businessId,
          principals: request.principals,
        });
  const cacheKey = buildRetrievalCacheKey(
    request,
    deps.principalResolver === undefined ? undefined : principals,
    deps.graph?.enabled === true ? deps.graph.depth : undefined
  );

  if (deps.cache !== undefined) {
    const cached = await deps.cache.get<CachedRetrieval>(cacheKey);
    if (cached !== undefined) {
      if (await cachedStillValid(deps, request, cached, principals)) {
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

  const { allowed, reasons } = await authorizeAll(deps, request, principals);
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
    candidates: await expandCandidates(deps, request, candidates, allowed, reasons),
    exclusions: tally(reasons),
    cacheKey,
    fromCache: false,
  };

  if (deps.cache !== undefined) {
    const entry: CachedRetrieval = {
      candidates: result.candidates,
      exclusions: result.exclusions,
      sourceVersions: [...allowed.values()].map(({ citation, subjectKind }) => ({
        sourceId: citation.sourceId,
        revision: citation.revision,
        aclRevision: citation.aclRevision,
        subjectKind,
      })),
    };
    await deps.cache.set(cacheKey, entry, deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  }

  await auditRetrieval(deps, request, result);
  return result;
}
