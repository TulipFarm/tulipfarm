import type { KnowledgeSubjectKind } from "../subject";

export interface GraphInvalidationPort {
  chunkIdsForSubject(
    subjectKind: KnowledgeSubjectKind,
    subjectId: string
  ): Promise<readonly string[]>;
  deleteEntitiesDerivedFrom(chunkIds: readonly string[]): Promise<number>;
  markSummariesStale(chunkIds: readonly string[]): Promise<number>;
  forgetExtractions(chunkIds: readonly string[]): Promise<number>;
}

export interface GraphInvalidationReport {
  readonly entitiesRemoved: number;
  readonly summariesInvalidated: number;
  readonly extractionsForgotten: number;
}

const NOTHING: GraphInvalidationReport = {
  entitiesRemoved: 0,
  summariesInvalidated: 0,
  extractionsForgotten: 0,
};

/**
 * Removes everything the graph derived from a set of chunks.
 *
 * Ordering is the point. Summaries are marked stale *first*: a summary keeps being served until
 * something marks it, whereas a deleted entity is gone the moment the delete lands. Marking first
 * means there is no interval in which a summary is still readable but the material behind it has
 * already been withdrawn.
 *
 * Called both when a document is deleted and when its ACL is revoked. Revocation is not a softer
 * case than deletion here: a summary built while a chunk was broadly readable is not re-derivable
 * from what the actor may now see, so it has to go either way.
 */
export async function invalidateGraphForChunks(
  chunkIds: readonly string[],
  port: GraphInvalidationPort
): Promise<GraphInvalidationReport> {
  const unique = [...new Set(chunkIds)];
  if (unique.length === 0) return NOTHING;

  const summariesInvalidated = await port.markSummariesStale(unique);
  const entitiesRemoved = await port.deleteEntitiesDerivedFrom(unique);
  const extractionsForgotten = await port.forgetExtractions(unique);

  return { entitiesRemoved, summariesInvalidated, extractionsForgotten };
}

/** Invalidates the graph for a whole document, resolving its chunks through the checkpoint table. */
export async function invalidateGraphForSubject(
  subjectKind: KnowledgeSubjectKind,
  subjectId: string,
  port: GraphInvalidationPort
): Promise<GraphInvalidationReport> {
  const chunkIds = await port.chunkIdsForSubject(subjectKind, subjectId);
  return invalidateGraphForChunks(chunkIds, port);
}
