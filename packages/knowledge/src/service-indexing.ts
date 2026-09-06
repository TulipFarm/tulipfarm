import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { indexPage as indexPageImpl, reindexAll as reindexAllImpl } from "./index-service";
import { type RestrictionSubject, setPageRestriction } from "./page-restriction";
import type { KnowledgeServiceDeps } from "./service";
import type { IndexQueueStats, IndexStatusReport, KnowledgePage, KnowledgeSource } from "./types";

export interface IngestSourceInput {
  source: KnowledgeSource;
  sourceId: string;
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
  /**
   * Exactly who may read the Page this produces.
   *
   * Omitted, the Page is Business-wide readable, which is right for a Resource or a Conversation
   * every member can already open. A File is not that: it is readable by its owner and whoever it
   * was shared with, so indexing one without naming them would publish it to the whole Business.
   */
  readers?: readonly RestrictionSubject[];
  /**
   * Where the Page sits, for callers that produce a browsable Page rather than a bare source
   * record.
   *
   * Not optional in spirit: the lexical arm of retrieval only considers Pages that have both, so a
   * Page ingested without them is findable by vector search alone and silently invisible on a
   * deployment with no embedding provider. Omit it only for sources that are retrieved through
   * `searchKnowledgeSources` instead.
   */
  placement?: { spaceId: string; path: string };
}

export function indexPage(deps: KnowledgeServiceDeps, page: KnowledgePage): Promise<unknown> {
  return indexPageImpl(page, deps.chunks, deps.embeddings);
}

export async function reindexById(deps: KnowledgeServiceDeps, id: string): Promise<void> {
  const page = await deps.pages.getById(id);
  if (page?.active) await indexPage(deps, page);
}

/** Upsert a resource/conversation-sourced page and (re)index it. */
export async function ingestSource(
  deps: KnowledgeServiceDeps,
  input: IngestSourceInput
): Promise<KnowledgePage | null> {
  const now = new Date();
  const draft: KnowledgePage = {
    _id: randomUUID(),
    title: input.title,
    content: input.content,
    plainText: input.content.trim(),
    source: input.source,
    sourceId: input.sourceId,
    domain: input.domain ?? null,
    tags: input.tags ?? [],
    spaceId: input.placement?.spaceId ?? null,
    path: input.placement?.path ?? null,
    active: true,
    alwaysLoadForAgents: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const { _id } = await deps.pages.upsertBySource(draft);
  if (input.readers === undefined) {
    await deps.ownership?.ensureBusiness(DEPLOYMENT_BUSINESS_ID, "page", _id);
  }
  // Readership is written before the content is chunked, never after. Reversed, there is a window
  // in which the Page is indexed and still carries its default Business-wide grant, and a question
  // asked inside that window is answered from a File the asker may not read.
  if (input.readers !== undefined && input.readers.length > 0) {
    await setPageRestriction(deps, _id, input.readers);
  }
  const canonical = await deps.pages.getById(_id);
  if (canonical) await indexPage(deps, canonical);
  return canonical;
}

export function reindexAll(deps: KnowledgeServiceDeps): Promise<number> {
  return reindexAllImpl(deps.pages, deps.chunks, deps.embeddings);
}

/** Manual re-index; `pageId` and `spaceId` never fall back to full re-index. */
export async function reindexTargeted(
  deps: KnowledgeServiceDeps,
  opts: { pageId?: string; spaceId?: string }
): Promise<number> {
  if (opts.pageId) {
    const page = await deps.pages.getById(opts.pageId);
    if (!page?.active) return 0;
    await indexPage(deps, page);
    return 1;
  }
  if (opts.spaceId) {
    const pages = await deps.pages.listBySpace(opts.spaceId);
    for (const page of pages) await indexPage(deps, page);
    return pages.length;
  }
  return reindexAll(deps);
}

/** Backfill active pages with missing/stale embeddings; no provider returns 0. */
export async function backfillMissing(deps: KnowledgeServiceDeps): Promise<number> {
  const active = deps.embeddings.isAvailable() ? deps.embeddings.getActive() : null;
  if (!active?.model) return 0;
  const ids = await deps.chunks.listPageIdsNeedingEmbedding(active.model, active.dimension);
  for (const id of ids) {
    if (deps.enqueueIndex) await deps.enqueueIndex(id);
    else await reindexById(deps, id);
  }
  return ids.length;
}

/** DB-derived index health (+ pg-boss queue stats when wired). */
export async function indexStatus(deps: KnowledgeServiceDeps): Promise<IndexStatusReport> {
  const stats = await deps.chunks.indexStats();
  let queue: IndexQueueStats | null = null;
  if (deps.indexQueueStats) queue = await deps.indexQueueStats();
  return {
    activePages: stats.activePages,
    chunks: {
      total: stats.totalChunks,
      embedded: stats.embeddedChunks,
      lexicalOnly: stats.lexicalChunks,
    },
    indexLagSeconds: stats.maxLagSeconds,
    queue,
  };
}

/**
 * Full re-index when the stored vectors no longer match the active embedding model (KN-V1-002).
 *
 * The in-memory flag only sees a change that happens inside one process lifetime. An operator who
 * edits the embedding model and restarts loses it entirely, and every stored vector then sits at
 * a width `searchVector` will never match — vector recall silently drops to zero. So the stored
 * corpus, not process memory, is the authority; the flag is only a fast path.
 */
export async function runReindexIfPending(deps: KnowledgeServiceDeps): Promise<boolean> {
  if (!(await reindexNeeded(deps))) return false;
  await reindexAll(deps);
  // Cleared last: a re-index that throws must leave the signal set for the next attempt.
  deps.embeddings.clearPendingReindex();
  return true;
}

async function reindexNeeded(deps: KnowledgeServiceDeps): Promise<boolean> {
  if (deps.embeddings.pendingReindex()) return true;
  const dim = deps.embeddings.getDimension();
  if (dim === null) return false;
  return (await deps.chunks.countStaleDimension(dim)) > 0;
}

export async function afterWrite(deps: KnowledgeServiceDeps, page: KnowledgePage): Promise<void> {
  if (deps.enqueueIndex) await deps.enqueueIndex(page._id);
  else await indexPage(deps, page);
}
