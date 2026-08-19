import type { GraphRagConfig } from "../retrieval-config";
import type { RetrievalExclusion, RetrievalExclusionReason } from "../retrieve";
import {
  addTokens,
  type GraphCommunitySummaryRecord,
  type GraphEntityRecord,
  NO_TOKENS,
  type TokenUsage,
} from "./types";

export interface GraphSearchRequest {
  readonly businessId: string;
  readonly principalId: string;
  readonly query: string;
  readonly limit: number;
  readonly correlationId: string;
}

export interface GraphSearchStore {
  findEntities(
    businessId: string,
    query: string,
    limit: number,
    offset: number
  ): Promise<readonly GraphEntityRecord[]>;
  findChunkIdsForEntities(entityIds: readonly string[]): Promise<readonly string[]>;
  listCommunitySummaries(
    businessId: string,
    limit: number,
    offset: number
  ): Promise<readonly GraphCommunitySummaryRecord[]>;
}

export interface ChunkAuthorization {
  readonly allowed: ReadonlySet<string>;
}

/**
 * Query-time access decisions, already bound to the acting principal by the caller. Implemented in
 * terms of the one gate in `src/acl.ts`; a second evaluator here would be a defect.
 *
 * Returns only what is permitted, and deliberately cannot report *why* anything was denied. A
 * per-item reason is a channel in its own right, and one withheld item's reason would otherwise
 * end up reported against another.
 */
export interface GraphAuthorizationPort {
  authorizeChunks(chunkIds: readonly string[]): Promise<ChunkAuthorization>;
}

export interface GlobalAnswerPort {
  reduce(input: {
    readonly query: string;
    readonly summaries: readonly { readonly title: string; readonly summary: string }[];
  }): Promise<{ readonly answer: string; readonly usage?: TokenUsage }>;
}

export interface LocalSearchDeps {
  readonly config: GraphRagConfig;
  readonly store: GraphSearchStore;
  readonly authorization: GraphAuthorizationPort;
}

export interface GlobalSearchDeps extends LocalSearchDeps {
  readonly answers: GlobalAnswerPort;
}

export interface LocalSearchResult {
  readonly entities: readonly GraphEntityRecord[];
  readonly chunkIds: readonly string[];
  readonly exclusions: readonly RetrievalExclusion[];
}

export interface GlobalSearchResult {
  readonly answer: string;
  readonly citations: readonly {
    readonly communityId: string;
    readonly chunkIds: readonly string[];
  }[];
  readonly exclusions: readonly RetrievalExclusion[];
  readonly usage: TokenUsage;
}

/**
 * Every graph denial reports this one reason. A finer one would state something true about a
 * document the actor may not know exists — that it was deleted rather than merely unshared, say —
 * and the tally is observable output.
 */
const GRAPH_DENIAL_REASON: RetrievalExclusionReason = "principal_not_permitted";

/**
 * How many pages past the cap a search will read looking for admissible results.
 *
 * There has to be some bound, but it must not be the cap itself. Filtering *after* a capped fetch
 * lets a withheld item consume a slot a readable one would have taken, so the actor gets a shorter
 * answer because of a document they are not allowed to know about. Paging until the cap is filled
 * removes that displacement; this ceiling only binds when nearly the whole corpus is denied, in
 * which case the answer is empty either way.
 */
const MAX_PAGES = 10;

function tally(count: number): RetrievalExclusion[] {
  return count === 0 ? [] : [{ reason: GRAPH_DENIAL_REASON, count }];
}

const EMPTY_LOCAL: LocalSearchResult = { entities: [], chunkIds: [], exclusions: [] };
const EMPTY_GLOBAL: GlobalSearchResult = {
  answer: "",
  citations: [],
  exclusions: [],
  usage: NO_TOKENS,
};

/** Reads pages of candidates until `limit` are admitted or the store runs dry. */
async function collectAdmitted<T>(
  limit: number,
  fetchPage: (limit: number, offset: number) => Promise<readonly T[]>,
  admit: (page: readonly T[]) => Promise<{ admitted: T[]; denied: number }>
): Promise<{ admitted: T[]; denied: number }> {
  const admitted: T[] = [];
  let denied = 0;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES && admitted.length < limit; page++) {
    const batch = await fetchPage(limit, offset);
    if (batch.length === 0) break;
    offset += batch.length;
    const verdict = await admit(batch);
    admitted.push(...verdict.admitted);
    denied += verdict.denied;
    if (batch.length < limit) break;
  }

  return { admitted: admitted.slice(0, limit), denied };
}

/**
 * Local search: match entities by name, then fan out to the chunks they were derived from.
 *
 * An entity is admitted only when *every* chunk it came from is readable by this actor. That is
 * stricter than it strictly needs to be for the entity's name, but an entity's description is text
 * blended across all of its sources, and there is no way to hand back the part of a sentence that
 * came from a chunk the actor may read. Default-deny beats a rule that needs a careful reader.
 */
export async function localSearch(
  request: GraphSearchRequest,
  deps: LocalSearchDeps
): Promise<LocalSearchResult> {
  if (!deps.config.enabled) return EMPTY_LOCAL;

  const { admitted, denied } = await collectAdmitted<GraphEntityRecord>(
    request.limit,
    (limit, offset) => deps.store.findEntities(request.businessId, request.query, limit, offset),
    async (page) => {
      const chunkIds = [...new Set(page.flatMap((entity) => entity.sourceChunkIds))];
      const decision = await deps.authorization.authorizeChunks(chunkIds);
      const cleared = page.filter(
        (entity) =>
          entity.sourceChunkIds.length > 0 &&
          entity.sourceChunkIds.every((id) => decision.allowed.has(id))
      );
      return { admitted: cleared, denied: page.length - cleared.length };
    }
  );

  return {
    entities: admitted,
    chunkIds: [...new Set(admitted.flatMap((entity) => entity.sourceChunkIds))],
    exclusions: tally(denied),
  };
}

/**
 * Global search: map over community summaries, reduce the survivors into one answer.
 *
 * Build time already restricted each summary to broadly-readable material, but an ACL can be
 * revoked between the build and this query, so every provenance chunk is put through the gate
 * again here. One denied contributor withholds the entire summary: not a redaction, not a partial
 * render, and not a note that something was left out. The model is never shown the withheld text,
 * so it cannot leak it by paraphrase.
 */
export async function globalSearch(
  request: GraphSearchRequest,
  deps: GlobalSearchDeps
): Promise<GlobalSearchResult> {
  if (!deps.config.enabled) return EMPTY_GLOBAL;

  const { admitted, denied } = await collectAdmitted<GraphCommunitySummaryRecord>(
    deps.config.maxSummariesPerQuery,
    (limit, offset) => deps.store.listCommunitySummaries(request.businessId, limit, offset),
    async (page) => {
      const chunkIds = [...new Set(page.flatMap((summary) => summary.provenanceChunkIds))];
      const decision = await deps.authorization.authorizeChunks(chunkIds);
      const cleared = page.filter(
        (summary) =>
          summary.provenanceChunkIds.length > 0 &&
          summary.provenanceChunkIds.every((id) => decision.allowed.has(id))
      );
      return { admitted: cleared, denied: page.length - cleared.length };
    }
  );

  if (admitted.length === 0) return { ...EMPTY_GLOBAL, exclusions: tally(denied) };

  const reduced = await deps.answers.reduce({
    query: request.query,
    summaries: admitted.map((s) => ({ title: s.title, summary: s.summary })),
  });

  return {
    answer: reduced.answer,
    citations: admitted.map((s) => ({
      communityId: s.communityId,
      chunkIds: s.provenanceChunkIds,
    })),
    exclusions: tally(denied),
    usage: addTokens(NO_TOKENS, reduced.usage ?? NO_TOKENS),
  };
}
