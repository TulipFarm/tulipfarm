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
}
