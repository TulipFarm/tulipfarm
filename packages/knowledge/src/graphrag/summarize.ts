import {
  addTokens,
  type ChildSummary,
  type GraphCommunityRecord,
  type GraphCommunitySummaryRecord,
  type GraphEdgeRecord,
  type GraphEntityRecord,
  type GraphSummaryPort,
  NO_TOKENS,
  type TokenUsage,
} from "./types";

export interface SummaryDeps {
  readonly port: GraphSummaryPort;
  readonly buildId: string;
  /**
   * Whether a chunk is cleared for a blanket audience. Supplied by the caller so this module never
   * reaches for a database, and so the definition stays in `src/acl.ts` where the gate lives.
   */
  isBroadlyReadableChunk(chunkId: string): Promise<boolean>;
}

export interface SummaryBuildResult {
  readonly summaries: readonly GraphCommunitySummaryRecord[];
  readonly withheld: number;
  readonly usage: TokenUsage;
}

/**
 * Builds one summary per community, bottom-up.
 *
 * The whole ACL argument for GraphRAG lives here and in `search.ts`. A summary is derived text: no
 * downstream check can separate one contributor's words from another's once the model has blended
 * them. So the model is only ever shown material that is readable by construction — an entity or
 * edge is admitted only if *every* chunk it was derived from is broadly readable. One denied
 * contributor removes the whole node, not part of it.
 *
 * A community left with nothing gets no summary at all. Not an empty one, not a hint that something
 * was omitted: the existence of a withheld community is itself a fact about the corpus.
 */
export async function buildCommunitySummaries(
  communities: readonly GraphCommunityRecord[],
  entities: readonly GraphEntityRecord[],
  edges: readonly GraphEdgeRecord[],
  deps: SummaryDeps
): Promise<SummaryBuildResult> {
  const readable = new Map<string, boolean>();
  const cleared = async (chunkIds: readonly string[]): Promise<boolean> => {
    if (chunkIds.length === 0) return false;
    for (const chunkId of chunkIds) {
      let verdict = readable.get(chunkId);
      if (verdict === undefined) {
        verdict = await deps.isBroadlyReadableChunk(chunkId);
        readable.set(chunkId, verdict);
      }
      if (!verdict) return false;
    }
    return true;
  };

  const admittedEntities = new Map<string, GraphEntityRecord>();
  for (const entity of entities) {
    if (await cleared(entity.sourceChunkIds)) admittedEntities.set(entity.entityId, entity);
  }
  const admittedEdges: GraphEdgeRecord[] = [];
  for (const edge of edges) {
    if (await cleared(edge.sourceChunkIds)) admittedEdges.push(edge);
  }

  const summaries: GraphCommunitySummaryRecord[] = [];
  const byId = new Map<string, ChildSummary>();
  let usage = NO_TOKENS;
  let withheld = 0;

  const ordered = [...communities].sort(
    (a, b) => a.level - b.level || a.communityId.localeCompare(b.communityId)
  );
  const childrenOf = new Map<string, string[]>();
  for (const community of ordered) {
    if (community.parentCommunityId === undefined) continue;
    const siblings = childrenOf.get(community.parentCommunityId) ?? [];
    siblings.push(community.communityId);
    childrenOf.set(community.parentCommunityId, siblings);
  }

  for (const community of ordered) {
    const members = new Set(community.entityIds);
    const communityEntities = community.entityIds
      .map((id) => admittedEntities.get(id))
      .filter((entity): entity is GraphEntityRecord => entity !== undefined);
    const communityEdges = admittedEdges.filter(
      (edge) => members.has(edge.sourceEntityId) && members.has(edge.targetEntityId)
    );
    const childSummaries = (childrenOf.get(community.communityId) ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is ChildSummary => child !== undefined);

    if (communityEntities.length === 0 && childSummaries.length === 0) {
      withheld++;
      continue;
    }

    const output = await deps.port.summarize({
      communityId: community.communityId,
      level: community.level,
      entities: communityEntities,
      edges: communityEdges,
      childSummaries,
    });

    const provenanceChunkIds = [
      ...new Set([
        ...communityEntities.flatMap((entity) => entity.sourceChunkIds),
        ...communityEdges.flatMap((edge) => edge.sourceChunkIds),
      ]),
    ].sort();

    usage = addTokens(usage, output.usage ?? NO_TOKENS);
    summaries.push({
      communityId: community.communityId,
      businessId: community.businessId,
      buildId: deps.buildId,
      title: output.title,
      summary: output.summary,
      provenanceChunkIds,
      usage: output.usage ?? NO_TOKENS,
    });
    byId.set(community.communityId, {
      communityId: community.communityId,
      title: output.title,
      summary: output.summary,
    });
  }

  return { summaries, withheld, usage };
}
