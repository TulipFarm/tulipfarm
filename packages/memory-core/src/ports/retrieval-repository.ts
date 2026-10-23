import type { RepositoryResult } from './repository-result.ts';

export interface RetrievalRepository {
  anchors(
    values: [
      publications: (string | undefined)[],
      ordinals: number[],
      kinds: string[],
      sources: string[],
      documents: string[],
    ],
  ): Promise<RepositoryResult>;
  passages(
    values: [publications: string[], ordinals: number[], characters: number, limit: number, excluded: string[]],
  ): Promise<RepositoryResult>;
  /** Publications among these that have coverage gaps, as `publication_id` rows; absent where gaps are not stored. */
  readGaps?(values: [publicationIds: string[]]): Promise<RepositoryResult>;
}
