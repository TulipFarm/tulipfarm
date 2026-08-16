import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { EMBEDDING_REINDEX_PENDING_WARNING, EMBEDDING_UNAVAILABLE_WARNING } from "@tulipfarm/llm";
import { resolveRerank } from "./rerank";
import { retrieve } from "./retrieve";
import { search as baseSearch } from "./search-service";
import type { KnowledgeServiceDeps } from "./service";
import type { KnowledgePrincipalRef } from "./source";
import type { KnowledgePage, QueryKnowledgeHit, SearchFilters, SearchResults } from "./types";

export interface HybridSearchContext {
  readonly principalId: string;
  readonly principals: readonly KnowledgePrincipalRef[];
  readonly guardrailEpoch: string;
  readonly contextEpoch: string;
  readonly correlationId: string;
  readonly agentId?: string;
  readonly runId?: string;
}

/** Vector/lexical search; `expandGraph` appends direct OKF neighbors with score 0. */
export async function search(
  deps: KnowledgeServiceDeps,
  query: string,
  filters: SearchFilters,
  limit: number,
  opts?: { expandGraph?: boolean }
): Promise<SearchResults> {
  const base = await baseSearch(query, filters, limit, {
    embeddings: deps.embeddings,
    chunksRepo: deps.chunks,
  });
  if (!opts?.expandGraph || !deps.links) return base;
  const hitIds = [...new Set(base.results.map((r) => r.pageId))];
  const neighborIds = (await deps.links.getLinkedPageIds(hitIds)).filter(
    (id) => !hitIds.includes(id)
  );
  if (neighborIds.length === 0) return base;
  const neighbors = await Promise.all(neighborIds.map((id) => deps.pages.getById(id)));
  const extra = neighbors
    .filter((p): p is KnowledgePage => Boolean(p?.active))
    // Space-scoped graph expansion must not leak neighbors from other spaces.
    .filter((p) => !filters.spaceId || p.spaceId === filters.spaceId)
    .map((p) => ({
      pageId: p._id,
      chunkId: `graph:${p._id}`,
      title: p.title,
      content: p.plainText.slice(0, 800),
      source: p.source,
      score: 0,
    }));
  return { results: [...base.results, ...extra], warnings: base.warnings };
}

/** Tool retrieval fuses vector and lexical arms with RRF (k=60) before hydration/rerank. */
export async function hybridSearchPages(
  deps: KnowledgeServiceDeps,
  query: string,
  filters: SearchFilters,
  limit: number,
  context?: HybridSearchContext
): Promise<{ results: QueryKnowledgeHit[]; warnings: string[] }> {
  const okf = await hybridSearchOkfPages(deps, query, filters, limit);
  const sourceResults = await searchKnowledgeSources(deps, query, filters, limit, context);
  if (sourceResults.results.length === 0) return okf;

  const fused = fuseUnifiedResults(okf.results, sourceResults.results, limit);
  const results = await resolveRerank().rerank(query, fused, limit);
  return { results, warnings: [...okf.warnings, ...sourceResults.warnings] };
}

async function hybridSearchOkfPages(
  deps: KnowledgeServiceDeps,
  query: string,
  filters: SearchFilters,
  limit: number
): Promise<{ results: QueryKnowledgeHit[]; warnings: string[] }> {
  const N = Math.max(limit * 4, 20);
  const warnings: string[] = [];

  // Vector arm: chunk hits → max-score-per-page, keeping that chunk as the snippet.
  const vectorSnippet = new Map<string, string>();
  let pagesV: string[] = [];
  if (deps.embeddings.isAvailable()) {
    try {
      const out = await deps.embeddings.embedMany([query]);
      const vec = out.embeddings[0];
      const hits = vec ? await deps.chunks.searchVector(vec, out.dimension, N, filters) : [];
      const best = new Map<string, { content: string; score: number }>();
      for (const hit of hits) {
        const prior = best.get(hit.pageId);
        if (!prior || hit.score > prior.score) {
          best.set(hit.pageId, { content: hit.content, score: hit.score });
        }
      }
      pagesV = [...best.entries()].sort((a, b) => b[1].score - a[1].score).map(([id]) => id);
      for (const [id, { content }] of best) vectorSnippet.set(id, content);
      // Stored vectors at the previous width can never match an exact-width vector search, so
      // the arm returns confidently empty rather than erroring. Say so.
      if (deps.embeddings.pendingReindex()) {
        warnings.push(EMBEDDING_REINDEX_PENDING_WARNING);
      }
    } catch {
      // Any embedding failure degrades this arm to lexical-only, rate limits included: a partial
      // hybrid result with a warning beats failing a search the lexical arm could have answered.
      warnings.push(EMBEDDING_UNAVAILABLE_WARNING);
    }
  } else {
    warnings.push(EMBEDDING_UNAVAILABLE_WARNING);
  }

  // ── lexical arm: whole-page FTS ──
  const lexHits = deps.retrieval
    ? await deps.retrieval.searchPages({ query, filters, limit: N })
    : [];
  const pagesL = lexHits.map((h) => h.pageId);
  const lexicalSnippet = new Map(lexHits.map((h) => [h.pageId, h.snippet]));

  // ── RRF fuse (k=60), by 0-based rank across both arms ──
  const K = 60;
  const fused = new Map<string, number>();
  for (const list of [pagesV, pagesL]) {
    list.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (K + rank));
    });
  }
  const topIds = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  // ── hydrate (drop pages deleted since indexing) ──
  const pages = await Promise.all(topIds.map((id) => deps.pages.getById(id)));
  const hits: QueryKnowledgeHit[] = [];
  for (const page of pages) {
    if (!page) continue;
    const snippet =
      vectorSnippet.get(page._id) ?? lexicalSnippet.get(page._id) ?? page.plainText.slice(0, 800);
    hits.push({
      pageId: page._id,
      title: page.title,
      snippet,
      source: page.source,
      origin: "okf",
      score: fused.get(page._id) ?? 0,
      spaceId: page.spaceId ?? undefined,
      path: page.spaceId ? (page.path ?? undefined) : undefined,
    });
  }

  // ── rerank seam: default identity; the NotImplemented stub (when enabled) throws by design ──
  const results = await resolveRerank().rerank(query, hits, limit);
  return { results, warnings };
}

async function searchKnowledgeSources(
  deps: KnowledgeServiceDeps,
  query: string,
  filters: SearchFilters,
  limit: number,
  context?: HybridSearchContext
): Promise<{ results: QueryKnowledgeHit[]; warnings: string[] }> {
  if (deps.sourceRetrieval === undefined || context === undefined) {
    return { results: [], warnings: [] };
  }
  if (hasOkfOnlyFilter(filters)) return { results: [], warnings: [] };

  const result = await retrieve(deps.sourceRetrieval, {
    businessId: DEPLOYMENT_BUSINESS_ID,
    principalId: context.principalId,
    principals: context.principals,
    query,
    limit: Math.max(limit * 4, 20),
    guardrailEpoch: context.guardrailEpoch,
    contextEpoch: context.contextEpoch,
    correlationId: context.correlationId,
    ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  });

  return {
    results: result.candidates.map((candidate) => ({
      pageId: `knowledge-source:${candidate.sourceId}:${candidate.chunkId}`,
      title:
        candidate.provider === "slack"
          ? "Slack conversation"
          : candidate.provider === "confluence"
            ? "Confluence page"
            : candidate.provider === "notion"
              ? "Notion page"
              : candidate.provider === "google-docs"
                ? "Google Doc"
                : candidate.provider === "google-drive"
                  ? "Google Drive file"
                  : `${candidate.provider} knowledge source`,
      snippet: candidate.snippet,
      source: candidate.provider === "slack" ? "conversation" : "resource",
      origin: "knowledge_source",
      provider: candidate.provider,
      sourceId: candidate.sourceId,
      chunkId: candidate.chunkId,
      classification: candidate.classification,
      revision: candidate.revision,
      score: candidate.score,
    })),
    warnings: [],
  };
}

function hasOkfOnlyFilter(filters: SearchFilters): boolean {
  return (
    filters.domain !== undefined ||
    filters.source !== undefined ||
    filters.tags !== undefined ||
    filters.spaceId !== undefined ||
    filters.type !== undefined
  );
}

function fuseUnifiedResults(
  okf: readonly QueryKnowledgeHit[],
  sources: readonly QueryKnowledgeHit[],
  limit: number
): QueryKnowledgeHit[] {
  const K = 60;
  const hitsById = new Map<string, QueryKnowledgeHit>();
  const scores = new Map<string, number>();
  for (const list of [okf, sources]) {
    list.forEach((hit, rank) => {
      const id = `${hit.origin}:${hit.pageId}`;
      hitsById.set(id, hit);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank));
    });
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .flatMap(([id, score]) => {
      const hit = hitsById.get(id);
      return hit === undefined ? [] : [{ ...hit, score }];
    });
}
